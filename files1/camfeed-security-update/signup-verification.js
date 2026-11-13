// =============================================================================
// Sign-up e-mail verification: a 6-digit code is sent to the e-mail, and the account can
// only be created after the code is entered correctly (a signed 30-minute proof is returned).
//   POST /api/register/send-code    { email, turnstileToken, resend? }
//   POST /api/register/verify-code  { email, code }  ->  { emailToken }
// =============================================================================
const crypto = require('crypto');

const CODE_TTL_MS = 10 * 60 * 1000;          // a code is valid for 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000;        // 1 code per minute per e-mail
const RESEND_WINDOW_MS = 30 * 60 * 1000;     // "resend" works without CAPTCHA for 30 minutes after the first send
const MAX_SENDS_PER_HOUR = 5;                // per e-mail address
const MAX_ATTEMPTS = 5;                      // wrong guesses per code
const SIGNUP_TOKEN_TTL_SECONDS = 30 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeEmail(raw) { return String(raw || '').trim().toLowerCase(); }

function maskEmail(e) {
  const [user, domain] = e.split('@');
  const shown = user.length <= 2 ? user.slice(0, 1) : user.slice(0, 2);
  return shown + '*'.repeat(Math.max(1, Math.min(user.length - shown.length, 6))) + '@' + domain;
}

function fail(res, status, en, km, extra) {
  return res.status(status).json(Object.assign({ success: false, error: en, errorKm: km }, extra || {}));
}

function buildEmail(code) {
  const subject = `CamFeed: ${code} | លេខកូដផ្ទៀងផ្ទាត់`;
  const text =
    `លេខកូដផ្ទៀងផ្ទាត់ CamFeed របស់អ្នកគឺ ${code} (មានសុពលភាព 10 នាទី)។\n` +
    `បើអ្នកមិនបានស្នើសុំទេ សូមមិនអើពើអ៊ីមែលនេះ។\n\n` +
    `Your CamFeed verification code is ${code} (valid for 10 minutes).\n` +
    `If you did not request this, you can ignore this email.`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #e4e6eb;border-radius:12px">
      <h2 style="color:#1877f2;margin:0 0 12px">CamFeed</h2>
      <p style="margin:0 0 6px">លេខកូដផ្ទៀងផ្ទាត់របស់អ្នក៖</p>
      <p style="margin:0 0 14px;color:#606770;font-size:13px">Your verification code:</p>
      <div style="font-size:34px;font-weight:bold;letter-spacing:8px;text-align:center;background:#f0f2f5;border-radius:10px;padding:14px 0">${code}</div>
      <p style="margin:14px 0 4px;font-size:13px">មានសុពលភាព 10 នាទី។ បើអ្នកមិនបានស្នើសុំទេ សូមមិនអើពើអ៊ីមែលនេះ។</p>
      <p style="margin:0;color:#606770;font-size:12px">Valid for 10 minutes. If you did not request this, ignore this email.</p>
    </div>`;
  return { subject, text, html };
}

function buildResetEmail(code) {
  const subject = `CamFeed: ${code} | កំណត់ពាក្យសម្ងាត់ឡើងវិញ`;
  const text =
    `លេខកូដសម្រាប់កំណត់ពាក្យសម្ងាត់ CamFeed របស់អ្នកគឺ ${code} (មានសុពលភាព 10 នាទី)។\n` +
    `បើអ្នកមិនបានស្នើសុំទេ សូមមិនអើពើអ៊ីមែលនេះ ពាក្យសម្ងាត់របស់អ្នកនឹងមិនប្រែប្រួលទេ។\n\n` +
    `Your CamFeed password reset code is ${code} (valid for 10 minutes).\n` +
    `If you did not request this, ignore this email. Your password will not change.`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #e4e6eb;border-radius:12px">
      <h2 style="color:#1877f2;margin:0 0 12px">CamFeed</h2>
      <p style="margin:0 0 6px">លេខកូដកំណត់ពាក្យសម្ងាត់ឡើងវិញរបស់អ្នក៖</p>
      <p style="margin:0 0 14px;color:#606770;font-size:13px">Your password reset code:</p>
      <div style="font-size:34px;font-weight:bold;letter-spacing:8px;text-align:center;background:#f0f2f5;border-radius:10px;padding:14px 0">${code}</div>
      <p style="margin:14px 0 4px;font-size:13px">មានសុពលភាព 10 នាទី។ បើអ្នកមិនបានស្នើសុំទេ សូមមិនអើពើអ៊ីមែលនេះ ពាក្យសម្ងាត់របស់អ្នកនឹងមិនប្រែប្រួលទេ។</p>
      <p style="margin:0;color:#606770;font-size:12px">Valid for 10 minutes. If you did not request this, ignore this email. Your password will not change.</p>
    </div>`;
  return { subject, text, html };
}

// the free e-mail plans (Resend 100/day, Brevo 300/day) are shared by sign-up and password-reset codes
const DAILY_LIMIT = parseInt(process.env.EMAIL_DAILY_LIMIT || '90', 10);
let dayKey = '', dayCount = 0;
const dailyAllowed = () => { const k = new Date().toISOString().slice(0, 10); if (k !== dayKey) { dayKey = k; dayCount = 0; } return dayCount < DAILY_LIMIT; };
const dailyHit = () => { dailyAllowed(); dayCount++; };

// mode 'signup': the e-mail must NOT be registered yet     -> proof purpose "signup"
// mode 'reset' : the e-mail must belong to an account      -> proof purpose "reset" (bound to the current password)
function createCodeFlow({ pool, auth, mailer, mode }) {
  const isReset = mode === 'reset';
  const TABLE = isReset ? 'password_resets' : 'email_verifications';
  const PURPOSE = isReset ? 'reset' : 'signup';
  const makeEmail = isReset ? buildResetEmail : buildEmail;
  const LOG = isReset ? '[reset]' : '[signup]';
  const salt = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
  const hashCode = (code, email) => crypto.createHmac('sha256', salt).update(email + ':' + code).digest('hex');

  const ipSendLimiter = auth.makeLimiter(parseInt(process.env.VERIFY_SEND_MAX_PER_HOUR_PER_IP || '10', 10), 60 * 60 * 1000);
  const ipVerifyLimiter = auth.makeLimiter(30, 60 * 60 * 1000);

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        email VARCHAR(255) PRIMARY KEY,
        code_hash VARCHAR(64) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        sends INTEGER NOT NULL DEFAULT 1,
        window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    if (!isReset) await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE');
  }

  const isRequired = () => mailer.isConfigured();
  const notAvailable = (res) => fail(res, 503, 'Password reset by email is not available yet. Please contact support.', 'ការកំណត់ពាក្យសម្ងាត់ឡើងវិញតាមអ៊ីមែលមិនទាន់អាចប្រើបានទេ។ សូមទំនាក់ទំនងផ្នែកជំនួយ។');

  async function sendCode(req, res) {
    try {
      if (!isRequired()) return isReset ? notAvailable(res) : res.json({ success: true, verificationRequired: false });

      const body = req.body || {};
      const email = normalizeEmail(body.email);
      if (!EMAIL_RE.test(email) || email.length > 254) {
        return fail(res, 400, 'Please enter a valid email address (for example name@gmail.com).', 'សូមបញ្ចូលអ៊ីមែលត្រឹមត្រូវ (ឧ. name@gmail.com)។');
      }
      if (/@telegram\.camfeedkh\.com$/.test(email)) {
        return isReset
          ? fail(res, 400, 'This account signs in with Telegram, so it has no password to reset.', 'គណនីនេះចូលតាម Telegram ដូច្នេះមិនមានពាក្យសម្ងាត់ត្រូវកំណត់ឡើងវិញទេ។')
          : fail(res, 400, 'Please use a real email address.', 'សូមប្រើអាសយដ្ឋានអ៊ីមែលពិតប្រាកដ។');
      }
      if (ipSendLimiter.isLimited(req.ip)) {
        return fail(res, 429, 'Too many requests from this network. Please try again later.', 'សំណើច្រើនពេកពីបណ្តាញនេះ។ សូមព្យាយាមម្តងទៀតពេលក្រោយ។');
      }
      const exists = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1 LIMIT 1', [email]);
      if (isReset) {
        if (exists.rows.length === 0) {
          return fail(res, 404, 'No account was found with this email.', 'រកមិនឃើញគណនីដែលប្រើអ៊ីមែលនេះទេ។');
        }
      } else if (exists.rows.length > 0) {
        return fail(res, 409, 'This email is already registered. Please log in.', 'អ៊ីមែលនេះបានចុះឈ្មោះរួចហើយ។ សូមចូលគណនី។');
      }

      const now = Date.now();
      const prevRes = await pool.query(`SELECT * FROM ${TABLE} WHERE email = $1`, [email]);
      const prev = prevRes.rows[0];
      const prevCreated = prev ? new Date(prev.created_at).getTime() : 0;
      // "Resend" skips the CAPTCHA only for an address that already passed it in the last 30 minutes
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
        const sinceLast = now - new Date(prev.last_sent_at).getTime();
        if (sinceLast < RESEND_COOLDOWN_MS) {
          const wait = Math.ceil((RESEND_COOLDOWN_MS - sinceLast) / 1000);
          return fail(res, 429, `Please wait ${wait} seconds before requesting another code.`, `សូមរង់ចាំ ${wait} វិនាទី មុនស្នើសុំលេខកូដម្តងទៀត។`, { retryAfterSec: wait });
        }
        const prevWindow = new Date(prev.window_start).getTime();
        if (now - prevWindow < 60 * 60 * 1000) {
          if (prev.sends >= MAX_SENDS_PER_HOUR) {
            return fail(res, 429, 'Too many codes requested for this email. Please try again in an hour.', 'បានស្នើសុំលេខកូដច្រើនពេកសម្រាប់អ៊ីមែលនេះ។ សូមព្យាយាមម្តងទៀតក្នុងមួយម៉ោង។');
          }
          sends = prev.sends + 1; windowStart = prevWindow;
        }
      }
      if (!dailyAllowed()) {
        return fail(res, 503, 'Verification emails are temporarily unavailable. Please try again tomorrow.', 'ការផ្ញើអ៊ីមែលផ្ទៀងផ្ទាត់ត្រូវបានផ្អាកបណ្តោះអាសន្ន។ សូមព្យាយាមម្តងទៀតថ្ងៃស្អែក។');
      }

      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await pool.query(
        `INSERT INTO ${TABLE} (email, code_hash, expires_at, attempts, sends, window_start, last_sent_at, created_at)
         VALUES ($1, $2, $3, 0, $4, $5, $6, $7)
         ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0,
           sends = EXCLUDED.sends, window_start = EXCLUDED.window_start, last_sent_at = EXCLUDED.last_sent_at, created_at = EXCLUDED.created_at`,
        [email, hashCode(code, email), new Date(now + CODE_TTL_MS), sends, new Date(windowStart), new Date(now), new Date(isResend ? prevCreated : now)]);
      dailyHit();

      try {
        await mailer.sendEmail(Object.assign({ to: email }, makeEmail(code)));
      } catch (e) {
        console.error(LOG + ' could not send email:', e.message);
        await pool.query(`DELETE FROM ${TABLE} WHERE email = $1`, [email]).catch(() => {});
        return fail(res, 502, 'We could not send the email. Please try again in a moment.', 'មិនអាចផ្ញើអ៊ីមែលបានទេ។ សូមព្យាយាមម្តងទៀតបន្តិចក្រោយ។');
      }
      ipSendLimiter.hit(req.ip);
      pool.query(`DELETE FROM ${TABLE} WHERE expires_at < NOW() - INTERVAL '1 day'`).catch(() => {}); // tidy old rows
      res.json({ success: true, verificationRequired: true, maskedEmail: maskEmail(email), expiresInSec: CODE_TTL_MS / 1000, resendAfterSec: RESEND_COOLDOWN_MS / 1000 });
    } catch (err) {
      console.error(LOG + ' send-code error:', err.message);
      fail(res, 500, 'Something went wrong. Please try again.', 'មានបញ្ហា។ សូមព្យាយាមម្តងទៀត។');
    }
  }

  async function verifyCode(req, res) {
    try {
      if (!isRequired()) return isReset ? notAvailable(res) : res.json({ success: true, verificationRequired: false });

      const body = req.body || {};
      const email = normalizeEmail(body.email);
      const code = String(body.code || '').replace(/\s/g, '');
      if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) {
        return fail(res, 400, 'Please enter the 6-digit code.', 'សូមបញ្ចូលលេខកូដ 6 ខ្ទង់។');
      }
      if (ipVerifyLimiter.isLimited(req.ip)) {
        return fail(res, 429, 'Too many attempts. Please try again later.', 'ព្យាយាមច្រើនពេក។ សូមព្យាយាមម្តងទៀតពេលក្រោយ។');
      }
      ipVerifyLimiter.hit(req.ip);

      const row = (await pool.query(`SELECT * FROM ${TABLE} WHERE email = $1`, [email])).rows[0];
      if (!row) return fail(res, 400, 'This code is not valid anymore. Please request a new code.', 'លេខកូដនេះលែងមានសុពលភាពហើយ។ សូមស្នើសុំលេខកូដថ្មី។');
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return fail(res, 400, 'This code has expired. Please request a new code.', 'លេខកូដនេះផុតកំណត់ហើយ។ សូមស្នើសុំលេខកូដថ្មី។');
      }
      if (row.attempts >= MAX_ATTEMPTS) {
        return fail(res, 429, 'Too many wrong attempts. Please request a new code.', 'បញ្ចូលខុសច្រើនដងពេក។ សូមស្នើសុំលេខកូដថ្មី។');
      }
      if (!auth.safeEqual(hashCode(code, email), row.code_hash)) {
        const attemptsNow = row.attempts + 1;
        await pool.query(`UPDATE ${TABLE} SET attempts = attempts + 1 WHERE email = $1`, [email]);
        const left = Math.max(0, MAX_ATTEMPTS - attemptsNow);
        return left > 0
          ? fail(res, 400, `Incorrect code. ${left} attempt(s) left.`, `លេខកូដមិនត្រឹមត្រូវ។ នៅសល់ ${left} ដង។`, { attemptsLeft: left })
          : fail(res, 400, 'Incorrect code. Please request a new code.', 'លេខកូដមិនត្រឹមត្រូវ។ សូមស្នើសុំលេខកូដថ្មី។', { attemptsLeft: 0 });
      }
      await pool.query(`DELETE FROM ${TABLE} WHERE email = $1`, [email]);
      const proof = { sub: email, purpose: PURPOSE };
      if (isReset) {
        // bind the proof to the CURRENT password: it stops working the moment the password changes (single use)
        const u = await pool.query('SELECT password FROM users WHERE LOWER(email) = $1 LIMIT 1', [email]);
        if (u.rows.length === 0) return fail(res, 404, 'No account was found with this email.', 'រកមិនឃើញគណនីដែលប្រើអ៊ីមែលនេះទេ។');
        proof.pv = auth.fingerprint(u.rows[0].password);
      }
      res.json({ success: true, verificationRequired: true, emailToken: auth.signToken(proof, SIGNUP_TOKEN_TTL_SECONDS) });
    } catch (err) {
      console.error(LOG + ' verify-code error:', err.message);
      fail(res, 500, 'Something went wrong. Please try again.', 'មានបញ្ហា។ សូមព្យាយាមម្តងទៀត។');
    }
  }

  // used by /api/register: does this token prove that THIS e-mail was verified?
  function checkEmailToken(email, token) {
    const payload = auth.verifyToken(token);
    return !!(payload && payload.purpose === PURPOSE && String(payload.sub).toLowerCase() === normalizeEmail(email));
  }

  return { sendCode, verifyCode, checkEmailToken, isRequired, ensureSchema };
}

const createSignupVerification = (deps) => createCodeFlow(Object.assign({}, deps, { mode: 'signup' }));
const createPasswordReset = (deps) => createCodeFlow(Object.assign({}, deps, { mode: 'reset' }));

module.exports = { createSignupVerification, createPasswordReset, normalizeEmail, maskEmail, buildEmail, buildResetEmail, EMAIL_RE };
