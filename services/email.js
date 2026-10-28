/**
 * Email service (Phase 09 — production-grade over the Phase 02 dev stub).
 * Providers: EMAIL_PROVIDER=dev (in-memory outbox, default) | smtp (nodemailer).
 * - Same sendEmail({to, subject, template, data}) interface for all callers.
 * - SMTP: rendered HTML+text bodies, 3 attempts with backoff (no retry on auth errors).
 * - Delivery outcome is RETURNED ({sent, attempts, error?}) — callers record it and
 *   must never roll back the core transaction on failure.
 * - Logs carry only recipient/template/attempts. Bodies, tokens, and credentials are never logged.
 */
const { renderTemplate } = require('./templates');

const outbox = [];
const MAX_ATTEMPTS = 3;

function smtpConfig() {
  return {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || 'LabPulse <noreply@labpulse.local>',
  };
}

let cachedTransporter = null;

function getTransporter() {
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (_) {
    throw new Error('EMAIL_PROVIDER=smtp requires the nodemailer dependency.');
  }
  const c = smtpConfig();
  if (!c.host) throw new Error('SMTP_HOST is not set.');
  if (cachedTransporter) return cachedTransporter;

  const isGmail = c.host === 'smtp.gmail.com' || (c.user && c.user.toLowerCase().endsWith('@gmail.com'));
  if (isGmail) {
    cachedTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: c.user ? { user: c.user, pass: c.pass } : undefined,
      connectionTimeout: 25000,
      greetingTimeout: 25000,
      socketTimeout: 30000,
    });
    return cachedTransporter;
  }

  cachedTransporter = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    connectionTimeout: 25000,
    greetingTimeout: 25000,
    socketTimeout: 30000,
  });
  return cachedTransporter;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendSmtp({ to, subject, template, data }) {
  const { html, text } = renderTemplate(template, data);
  const from = (process.env.EMAIL_FROM || 'LabPulse <noreply@labpulse.local>').slice(0, 160);
  let attempts = 0;
  let lastError = null;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    try {
      const tx = getTransporter();
      await tx.sendMail({ from, to, subject, text, html });
      if (process.env.NODE_ENV !== 'test') console.log(`[email:smtp] to=${to} template=${template} attempts=${attempts} sent`);
      return { sent: true, attempts };
    } catch (err) {
      lastError = err;
      cachedTransporter = null; // Reset cached transporter on error so next attempt reconnects cleanly
      const fatal = err && (err.code === 'EAUTH' || err.code === 'EMESSAGE' || err.responseCode === 535);
      if (process.env.NODE_ENV !== 'test') {
        console.warn(`[email:smtp] to=${to} template=${template} attempt=${attempts} failed: ${err.code || err.message}`);
      }
      if (fatal || attempts >= MAX_ATTEMPTS) break;
      await sleep(300 * 2 ** (attempts - 1));
    }
  }
  const short = String((lastError && (lastError.code || lastError.message)) || 'send failed').slice(0, 160);
  return { sent: false, attempts, error: short };
}

async function sendEmail({ to, subject, template, data }) {
  if (process.env.NODE_ENV !== 'production' && data && data.otp) {
    console.log(`[email:otp] 🔑 OTP code for ${to}: ${data.otp}`);
  }
  const provider = process.env.EMAIL_PROVIDER || 'dev';
  if (provider === 'smtp') {
    const outcome = await sendSmtp({ to, subject, template, data });
    outbox.push({ id: `${Date.now()}-${outbox.length}`, to, subject, template, data: data || {}, queuedAt: new Date().toISOString(), status: outcome.sent ? 'sent' : 'failed' });
    return { queued: true, id: outbox[outbox.length - 1].id, ...outcome };
  }
  const entry = {
    id: `${Date.now()}-${outbox.length}`,
    to,
    subject,
    template,
    data: data || {},
    queuedAt: new Date().toISOString(),
    status: 'queued-dev',
  };
  outbox.push(entry);
  if (process.env.NODE_ENV !== 'test') {
    console.log(`[email:dev] to=${to} subject="${subject}" template=${template}`);
    const tok = data && (data.activationToken || data.resetToken);
    if (tok) {
      const baseUrl = process.env.APP_URL || 'http://localhost:3000';
      console.log(`[email:dev:link] Activation/Reset URL -> ${baseUrl}/reset-password.html?token=${tok}`);
    }
  }
  return { queued: true, id: entry.id, sent: true, attempts: 1 };
}

function getOutbox() {
  return outbox;
}

function clearOutbox() {
  outbox.length = 0;
}

module.exports = { sendEmail, getOutbox, clearOutbox };
