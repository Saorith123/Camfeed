// =============================================================================
// CamFeed mailer: sends e-mail over HTTPS (works on Render free plan, which blocks SMTP).
// Supported providers: Resend (EMAIL_PROVIDER=resend) or Brevo (EMAIL_PROVIDER=brevo).
//   resend: RESEND_API_KEY      brevo: BREVO_API_KEY      both: EMAIL_FROM="CamFeed <no-reply@camfeedkh.com>"
// If nothing is configured, isConfigured() is false and sign-up works without e-mail verification.
// =============================================================================

function parseFrom(from) {
  const m = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(from || '');
  if (m) return { name: m[1].replace(/^"|"$/g, '') || 'CamFeed', email: m[2].trim() };
  return { name: 'CamFeed', email: String(from || '').trim() };
}

function config() {
  const provider = String(process.env.EMAIL_PROVIDER || '').toLowerCase();
  const from = process.env.EMAIL_FROM || '';
  if (provider === 'resend' && process.env.RESEND_API_KEY && from) return { provider, key: process.env.RESEND_API_KEY, from };
  if (provider === 'brevo' && process.env.BREVO_API_KEY && from) return { provider, key: process.env.BREVO_API_KEY, from };
  return null;
}

function isConfigured() { return !!config(); }

if (!config()) {
  console.warn('[mailer] E-mail is not configured (EMAIL_PROVIDER / API key / EMAIL_FROM). Sign-up will NOT require e-mail verification.');
}

async function sendEmail({ to, subject, html, text }) {
  const cfg = config();
  if (!cfg) throw new Error('E-mail provider is not configured');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    let res;
    if (cfg.provider === 'resend') {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST', signal: ctl.signal,
        headers: { 'Authorization': 'Bearer ' + cfg.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: cfg.from, to: [to], subject, html, text })
      });
    } else {
      const sender = parseFrom(cfg.from);
      res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', signal: ctl.signal,
        headers: { 'api-key': cfg.key, 'Content-Type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({ sender, to: [{ email: to }], subject, htmlContent: html, textContent: text })
      });
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch (e) {}
      throw new Error(`${cfg.provider} responded ${res.status} ${detail}`);
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendEmail, isConfigured, parseFrom };
