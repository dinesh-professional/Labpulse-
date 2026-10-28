/**
 * Email templates (Phase 09). Single source for every operational email body.
 * All values are HTML-escaped at render. Never log rendered bodies (they may carry
 * single-use tokens); logs record only recipient/template/delivery outcome.
 */
function esc(v) {
  return String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const TITLES = {
  'faculty-invitation': 'Faculty account invitation',
  'account-activation': 'LabPulse account activation',
  'account-signup': 'LabPulse account activation',
  'account-otp': 'Verification Code (OTP)',
  'password-reset': 'Password reset',
  'password-changed': 'Password changed',
  'schedule-created': 'Schedule confirmed',
  'schedule-modified': 'Schedule modified',
  'schedule-cancelled': 'Schedule cancelled',
  'booking-created': 'Booking confirmed — free of charge',
  'booking-cancelled': 'Booking cancelled',
  'booking-rescheduled': 'Booking rescheduled',
  'booking-reminder': 'Upcoming reservation reminder',
  'booking-rejected': 'Booking reservation declined',
  'instrument-unavailable': 'Instrument temporarily unavailable',
  'instrument-available': 'Instrument returned to service',
  'calibration-due-soon': 'Instrument calibration due soon',
  'calibration-overdue': 'Instrument calibration overdue',
  'calibration-failed': 'Instrument calibration failed',
  'calibration-scheduled': 'Calibration scheduled',
  'calibration-updated': 'Calibration updated',
  'calibration-completed': 'Calibration completed',
  'maintenance-scheduled': 'Maintenance scheduled',
  'maintenance-updated': 'Maintenance updated',
  'maintenance-completed': 'Maintenance completed',
  'breakage-reported': 'Breakage reported',
  'breakage-confirmed': 'Breakage confirmed',
  'breakage-updated': 'Breakage update',
  'breakage-resolved': 'Breakage resolved',
  'qr-pass-issued': 'QR access pass issued',
  'qr-pass-revoked': 'QR access pass revoked',
  'qr-check-in-success': 'Laboratory check-in confirmed',
};

const LABELS = {
  facultyName: 'Faculty', degree: 'Degree', department: 'Department', year: 'Year',
  section: 'Section', subject: 'Subject', laboratory: 'Laboratory', date: 'Date',
  startTime: 'Start time', endTime: 'End time', startDate: 'Start date', endDate: 'End date',
  status: 'Status', referenceId: 'Reference ID', instrument: 'Instrument', user: 'User',
  purpose: 'Purpose', calibrationType: 'Calibration type', type: 'Type',
  issueType: 'Issue', severity: 'Severity', description: 'Description',
  breakageFee: 'Confirmed breakage fee', resolutionNotes: 'Resolution notes',
  resetToken: 'Reset token', activationToken: 'Activation token', qrToken: 'Access token',
  expiresInMinutes: 'Expires in (minutes)', expiresInHours: 'Expires in (hours)',
  name: 'Name', drift: 'Drift', tolerance: 'Tolerance',
};

function labelOf(key) {
  if (LABELS[key]) return LABELS[key];
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function renderTemplate(template, data) {
  const title = TITLES[template] || 'LabPulse notification';
  const baseUrl = (data && data.baseUrl) || process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
  const token = data && (data.activationToken || data.resetToken);
  const actionUrl = token ? `${baseUrl}/reset-password.html?token=${encodeURIComponent(token)}` : '';

  const rows = Object.entries(data || {})
    .filter(([k, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ({ label: labelOf(k), value: String(v) }));
  const htmlRows = rows.map((r) => `<tr><td style="padding:6px 12px;color:#8A99AD;">${esc(r.label)}</td><td style="padding:6px 12px;color:#F8FAFC;">${esc(r.value)}</td></tr>`).join('');

  const otpHtml = data && data.otp
    ? `<div style="margin:24px 0;padding:20px;background:#121722;border:1px solid #00F5D4;border-radius:6px;text-align:center;">` +
      `<p style="margin:0 0 8px;font-size:12px;color:#8A99AD;text-transform:uppercase;letter-spacing:1px;">Your 6-Digit Verification Code</p>` +
      `<div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#00F5D4;font-family:monospace;margin:8px 0;">${esc(data.otp)}</div>` +
      `<p style="margin:8px 0 0;font-size:11px;color:#8A99AD;">This code expires in ${esc(data.expiresInMinutes || 10)} minutes. Do not share it with anyone.</p>` +
      `</div>`
    : '';

  const actionButtonHtml = actionUrl
    ? `<div style="margin:24px 0 20px;">` +
      `<a href="${esc(actionUrl)}" style="background-color:#00F5D4;color:#0A0D12;padding:12px 24px;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:0.5px;text-transform:uppercase;display:inline-block;border-radius:4px;">` +
      `${template && template.includes('reset') ? 'Reset Password' : 'Set Password & Activate'}` +
      `</a>` +
      `<p style="margin:14px 0 0;font-size:11px;color:#8A99AD;">Or click or copy this direct link into your browser:<br>` +
      `<a href="${esc(actionUrl)}" style="color:#00F5D4;word-break:break-all;">${esc(actionUrl)}</a></p>` +
      `</div>`
    : '';

  const html = `<div style="font-family:sans-serif;background:#0A0D12;color:#F8FAFC;padding:24px;">` +
    `<h2 style="margin:0 0 4px;">LabPulse</h2><p style="margin:0 0 16px;color:#00F5D4;">${esc(title)}</p>` +
    (otpHtml || '') +
    (actionButtonHtml || '') +
    `<table style="border-collapse:collapse;border:1px solid #222A3A;">${htmlRows}</table></div>`;
  const text = [
    `LabPulse — ${title}`,
    actionUrl ? `Direct link: ${actionUrl}` : '',
    ...rows.map((r) => `${r.label}: ${r.value}`),
  ].filter(Boolean).join('\n');
  return { title, html, text };
}

module.exports = { renderTemplate, TITLES };
