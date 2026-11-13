// =============================================================================
// Phone-number verification by a code that arrives inside the person's Telegram (Telegram Gateway).
//   POST /api/phone/send-code    { phone, purpose: 'signup' | 'reset', turnstileToken, resend? }
//   POST /api/phone/verify-code  { phone, code, purpose }   ->  { phoneToken }  (signed proof, 30 minutes)
// Accounts made with a phone number use the hidden identity  ph<digits>@telegram.camfeedkh.com
// (the phone itself is never put in URLs or lists). That address is derived from the VERIFIED number, so it cannot be edited.
// =============================================================================
const crypto = require('crypto');

const RESEND_COOLDOWN_MS = 60 * 1000;
const RESEND_WINDOW_MS = 30 * 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;
const PROOF_TTL_SECONDS = 30 * 60;
const SYNTHETIC_DOMAIN = 'telegram.camfeedkh.com';

// Country calling codes for the countries in the sign-up form
const DIAL = { 'Cambodia': '855', 'United States': '1', 'Canada': '1', 'Thailand': '66', 'Vietnam': '84', 'China': '86',
  'Japan': '81', 'South Korea': '82', 'France': '33', 'Australia': '61', 'United Kingdom': '44' };

// "+66 81 234 5678", "0066...", or a LOCAL number of the chosen country ("081 234 5678" + Thailand) -> "+66812345678".
// Without a country (login / forgot password) a local number is read as Cambodian; numbers from other countries must start with + or 00.
// For country "Other" a local number can not be guessed, so it must be written with + or 00.
function normalizePhone(raw, country) {
  const s = String(raw || '').trim();
  if (!s || !/^[+\d(][\d\s\-().]*$/.test(s)) return null;
  const plus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (!plus) {
    if (d.startsWith('00')) {
      d = d.slice(2);
    } else {
      const chosen = country !== undefined && country !== null && String(country).trim() !== '';
      const cc = chosen ? DIAL[country] : '855';
      if (!cc) return null;
      if (d.startsWith('0')) d = cc + d.slice(1);                                   // local number with the leading 0
      else if (d.startsWith(cc) && d.length > cc.length + 6) { /* already starts with the country code */ }
      else if (chosen) d = cc + d;                                                   // local number written without the leading 0 (e.g. US 555 123 4567)
      else return null;
    }
  }
  if (d.length < 9 || d.length > 15 || d.startsWith('0')) return null;
  return '+' + d;
}

// Every way an account can be identified by a phone number: the hidden identity of accounts made with the "Phone number" tab,
// and OLD accounts that used the number itself as their login (0962829738 / 855962829738 / +855962829738).
function phoneIdentities(e164) {
  const digits = String(e164).replace(/\D/g, '');
  const list = [`ph${digits}@${SYNTHETIC_DOMAIN}`];
  if (digits.startsWith('855')) list.push('0' + digits.slice(3));
  list.push(digits, '+' + digits);
  return list;
}
// -> the stored login of that account, or null
async function findAccountEmail(pool, e164) {
  const ids = phoneIdentities(e164);
  const r = await pool.query('SELECT email FROM users WHERE LOWER(email) = ANY($1::text[])', [ids]);
  for (const id of ids) { const hit = r.rows.find((x) => String(x.email).toLowerCase() === id); if (hit) return hit.email; }
  return null;
}

const phoneEmail = (e164) => `ph${String(e164).replace(/\D/g, '')}@${SYNTHETIC_DOMAIN}`;

function maskPhone(e164) {
  const d = String(e164).replace(/\D/g, '');
  return '+' + d.slice(0, 5) + '*'.repeat(Math.max(2, d.length - 8)) + d.slice(-3);
}

function fail(res, status, en, km, extra) {
  return res.status(status).json(Object.assign({ success: false, error: en, errorKm: km }, extra || {}));
}

const DAILY_LIMIT = parseInt(process.env.GATEWAY_DAILY_LIMIT || '100', 10);   // protects the prepaid balance
let dayKey = '', dayCount = 0;
const dailyAllowed = () => { const k = new Date().toISOString().slice(0, 10); if (k !== dayKey) { dayKey = k; dayCount = 0; } return dayCount < DAILY_LIMIT; };
const dailyHit = () => { dailyAllowed(); dayCount++; };

function createPhoneVerification({ pool, auth, gateway, mode }) {
  const isReset = mode === 'reset';
  const PURPOSE = isReset ? 'reset-phone' : 'signup-phone';
  const sendLimiter = auth.makeLimiter(parseInt(process.env.VERIFY_SEND_MAX_PER_HOUR_PER_IP || '10', 10), 60 * 60 * 1000);
  const verifyLimiter = auth.makeLimiter(30, 60 * 60 * 1000);

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS phone_verifications (
        phone VARCHAR(20) PRIMARY KEY,
        request_id VARCHAR(100) NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        sends INTEGER NOT NULL DEFAULT 1,
        window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
  }

  const notAvailable = (res) => fail(res, 503, 'Phone verification is not available yet. Please use your Gmail.', 'ការផ្ទៀងផ្ទាត់ដោយលេខទូរស័ព្ទមិនទាន់អាចប្រើបានទេ។ សូមប្រើ Gmail របស់អ្នក។');

  async function sendCode(req, res) {
    try {
      if (!gateway.isConfigured()) return notAvailable(res);
      const body = req.body || {};
      const phone = normalizePhone(body.phone, body.country);
      if (!phone) return fail(res, 400, 'Please enter a valid phone number. Choose your country, or start the number with + and your country code (for example +66 81 234 5678).', 'សូមបញ្ចូលលេខទូរស័ព្ទត្រឹមត្រូវ។ សូមជ្រើសរើសប្រទេសរបស់អ្នក ឬចាប់ផ្តើមដោយ + និងលេខកូដប្រទេស (ឧ. +66 81 234 5678)។');
      if (sendLimiter.isLimited(req.ip)) return fail(res, 429, 'Too many requests from this network. Please try again later.', 'សំណើច្រើនពេកពីបណ្តាញនេះ។ សូមព្យាយាមម្តងទៀតពេលក្រោយ។');

      const foundEmail = await findAccountEmail(pool, phone);
      if (isReset && !foundEmail) return fail(res, 404, 'No account was found with this phone number.', 'រកមិនឃើញគណនីដែលប្រើលេខទូរស័ព្ទនេះទេ។');
      if (!isReset && foundEmail) return fail(res, 409, 'This phone number is already registered. Please log in.', 'លេខទូរស័ព្ទនេះបានចុះឈ្មោះរួចហើយ។ សូមចូលគណនី។');

      const now = Date.now();
      const prev = (await pool.query('SELECT * FROM phone_verifications WHERE phone = $1', [phone])).rows[0];
      const prevCreated = prev ? new Date(prev.created_at).getTime() : 0;
      const isResend = !!(body.resend && prev && now - prevCreated < RESEND_WINDOW_MS);
      if (!isResend) {
        const human = await auth.verifyTurnstile(body.turnstileToken, req.ip);
        if (!human.ok) {
          return human.unavailable
            ? fail(res, 503, 'Verification service is unavailable. Please try again.', 'សេវាផ្ទៀងផ្ទាត់មិនអាចប្រើបានទេ។ សូមព្យាយាមម្តងទៀត។')
            : fail(res, 400, 'Human verification failed. Please try again.', 'ការបញ្ជាក់ថាជាមនុស្សបរាជ័យ។ សូមព្យាយាមម្តងទៀត។');
        }
      }
      let sends = 1, windowStart = now;
      if (prev) {
        const since = now - new Date(prev.last_sent_at).getTime();
        if (since < RESEND_COOLDOWN_MS) {
          const wait = Math.ceil((RESEND_COOLDOWN_MS - since) / 1000);
          return fail(res, 429, `Please wait ${wait} seconds before requesting another code.`, `សូមរង់ចាំ ${wait} វិនាទី មុនស្នើសុំលេខកូដម្តងទៀត។`, { retryAfterSec: wait });
        }
        const pw = new Date(prev.window_start).getTime();
        if (now - pw < 60 * 60 * 1000) {
          if (prev.sends >= MAX_SENDS_PER_HOUR) return fail(res, 429, 'Too many codes requested for this number. Please try again in an hour.', 'បានស្នើសុំលេខកូដច្រើនពេកសម្រាប់លេខនេះ។ សូមព្យាយាមម្តងទៀតក្នុងមួយម៉ោង។');
          sends = prev.sends + 1; windowStart = pw;
        }
      }
      if (!dailyAllowed()) return fail(res, 503, 'Phone codes are temporarily unavailable. Please use your Gmail or try again tomorrow.', 'លេខកូដតាមទូរស័ព្ទត្រូវបានផ្អាកបណ្តោះអាសន្ន។ សូមប្រើ Gmail ឬព្យាយាមម្តងទៀតថ្ងៃស្អែក។');

      // ask Telegram (the fee is only charged when the number can really be reached)
      let requestId;
      try {
        requestId = await gateway.checkSendAbility(phone);
        await gateway.sendCode(phone, requestId);
      } catch (e) {
        const code = String(e.gwCode || '');
        // say in plain words what to fix (this is what you read in the Render logs)
        const HINT = /BALANCE/.test(code) ? 'The Telegram Gateway balance is empty. Add credits at gateway.telegram.org (Account > Budget). Sending to your own number is free, any other number costs credits.'
          : /ACCESS_TOKEN/.test(code) ? 'TELEGRAM_GATEWAY_TOKEN in Render is wrong, was revoked, or the IP restriction in the Gateway account is not empty.'
          : /TIMEOUT|NETWORK/.test(code) ? 'Render could not reach gateway.telegram.org (temporary). Try again in a minute.'
          : /BAD_RESPONSE/.test(code) ? 'Telegram Gateway answered with something unreadable (temporary).'
          : /PHONE_NUMBER|NOT_FOUND/.test(code) ? 'This number is not on Telegram.' : '';
        console.error('[phone] gateway error:', code || e.message, HINT ? '-> ' + HINT : '');
        if (/BALANCE|ACCESS_TOKEN|TIMEOUT|NETWORK|BAD_RESPONSE/.test(code)) {
          return fail(res, 503, 'Phone codes are temporarily unavailable. Please use your Gmail.', 'លេខកូដតាមទូរស័ព្ទមិនអាចប្រើបានបណ្តោះអាសន្នទេ។ សូមប្រើ Gmail។');
        }
        return fail(res, 422, 'We could not send a code to this number through Telegram. Is the number on Telegram? You can use your Gmail instead.', 'មិនអាចផ្ញើលេខកូដទៅលេខនេះតាម Telegram បានទេ។ តើលេខនេះមាន Telegram ឬទេ? អ្នកអាចប្រើ Gmail ជំនួស។');
      }
      dailyHit();
      await pool.query(
        `INSERT INTO phone_verifications (phone, request_id, attempts, sends, window_start, last_sent_at, created_at)
         VALUES ($1, $2, 0, $3, $4, $5, $6)
         ON CONFLICT (phone) DO UPDATE SET request_id = EXCLUDED.request_id, attempts = 0, sends = EXCLUDED.sends,
           window_start = EXCLUDED.window_start, last_sent_at = EXCLUDED.last_sent_at, created_at = EXCLUDED.created_at`,
        [phone, requestId, sends, new Date(windowStart), new Date(now), new Date(isResend ? prevCreated : now)]);
      sendLimiter.hit(req.ip);
      res.json({ success: true, verificationRequired: true, maskedPhone: maskPhone(phone), resendAfterSec: RESEND_COOLDOWN_MS / 1000, expiresInSec: gateway.ttl() });
    } catch (err) {
      console.error('[phone] send-code error:', err.message);
      fail(res, 500, 'Something went wrong. Please try again.', 'មានបញ្ហា។ សូមព្យាយាមម្តងទៀត។');
    }
  }

  async function verifyCode(req, res) {
    try {
      if (!gateway.isConfigured()) return notAvailable(res);
      const body = req.body || {};
      const phone = normalizePhone(body.phone, body.country);
      const code = String(body.code || '').replace(/\s/g, '');
      if (!phone || !/^\d{6}$/.test(code)) return fail(res, 400, 'Please enter the 6-digit code.', 'សូមបញ្ចូលលេខកូដ 6 ខ្ទង់។');
      if (verifyLimiter.isLimited(req.ip)) return fail(res, 429, 'Too many attempts. Please try again later.', 'ព្យាយាមច្រើនពេក។ សូមព្យាយាមម្តងទៀតពេលក្រោយ។');
      verifyLimiter.hit(req.ip);

      const row = (await pool.query('SELECT * FROM phone_verifications WHERE phone = $1', [phone])).rows[0];
      if (!row) return fail(res, 400, 'This code is not valid anymore. Please request a new code.', 'លេខកូដនេះលែងមានសុពលភាពហើយ។ សូមស្នើសុំលេខកូដថ្មី។');
      if (row.attempts >= MAX_ATTEMPTS) return fail(res, 429, 'Too many wrong attempts. Please request a new code.', 'បញ្ចូលខុសច្រើនដងពេក។ សូមស្នើសុំលេខកូដថ្មី។');

      let status;
      try { status = await gateway.checkCode(row.request_id, code); }
      catch (e) { console.error('[phone] check error:', e.gwCode || e.message); return fail(res, 502, 'We could not check the code. Please try again.', 'មិនអាចពិនិត្យលេខកូដបានទេ។ សូមព្យាយាមម្តងទៀត។'); }

      if (status === 'expired') return fail(res, 400, 'This code has expired. Please request a new code.', 'លេខកូដនេះផុតកំណត់ហើយ។ សូមស្នើសុំលេខកូដថ្មី។');
      if (status === 'code_max_attempts_exceeded') return fail(res, 429, 'Too many wrong attempts. Please request a new code.', 'បញ្ចូលខុសច្រើនដងពេក។ សូមស្នើសុំលេខកូដថ្មី។');
      if (status !== 'code_valid') {
        const attemptsNow = row.attempts + 1;
        await pool.query('UPDATE phone_verifications SET attempts = attempts + 1 WHERE phone = $1', [phone]);
        const left = Math.max(0, MAX_ATTEMPTS - attemptsNow);
        return left > 0
          ? fail(res, 400, `Incorrect code. ${left} attempt(s) left.`, `លេខកូដមិនត្រឹមត្រូវ។ នៅសល់ ${left} ដង។`, { attemptsLeft: left })
          : fail(res, 400, 'Incorrect code. Please request a new code.', 'លេខកូដមិនត្រឹមត្រូវ។ សូមស្នើសុំលេខកូដថ្មី។', { attemptsLeft: 0 });
      }
      await pool.query('DELETE FROM phone_verifications WHERE phone = $1', [phone]);
      const proof = { sub: phone, purpose: PURPOSE };
      if (isReset) {
        const accountEmail = await findAccountEmail(pool, phone);
        const u = accountEmail ? await pool.query('SELECT password FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [accountEmail]) : { rows: [] };
        if (u.rows.length === 0) return fail(res, 404, 'No account was found with this phone number.', 'រកមិនឃើញគណនីដែលប្រើលេខទូរស័ព្ទនេះទេ។');
        proof.pv = auth.fingerprint(u.rows[0].password);
      }
      res.json({ success: true, verificationRequired: true, phoneToken: auth.signToken(proof, PROOF_TTL_SECONDS) });
    } catch (err) {
      console.error('[phone] verify-code error:', err.message);
      fail(res, 500, 'Something went wrong. Please try again.', 'មានបញ្ហា។ សូមព្យាយាមម្តងទៀត។');
    }
  }

  // does this signed proof belong to THIS verified phone number and THIS purpose?
  function checkToken(phone, token) {
    const e164 = normalizePhone(phone);
    const p = auth.verifyToken(token);
    return !!(e164 && p && p.purpose === PURPOSE && p.sub === e164);
  }

  return { sendCode, verifyCode, checkToken, ensureSchema };
}

module.exports = { createPhoneVerification, normalizePhone, phoneEmail, phoneIdentities, findAccountEmail, maskPhone, SYNTHETIC_DOMAIN, DIAL };
