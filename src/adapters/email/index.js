// Email provider abstraction (spec §6, §26). Swap via EMAIL_PROVIDER.
// NeerMela — drop-in replacement for src/adapters/email/index.js
// Enables real Gmail / email OTP delivery via Resend (https://resend.com).
//
// Render env vars to set:
//   EMAIL_PROVIDER = resend
//   RESEND_API_KEY = re_xxxxxxxxxxxxxxxxxxxx
//   EMAIL_FROM     = NeerMela <noreply@neermela.com>   (after you verify the domain in Resend)
//                    (for a quick test before domain verify, leave EMAIL_FROM unset — it falls
//                     back to onboarding@resend.dev, which only delivers to your own Resend email)

import { config } from '../../config/index.js';

const FROM = process.env.EMAIL_FROM || 'NeerMela <onboarding@resend.dev>';

function htmlWrap(subject, text) {
  const safe = String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<div style="font-family:Inter,Arial,sans-serif;background:#0a1128;color:#eaf0ff;padding:28px;border-radius:14px;max-width:460px;margin:auto">
    <h2 style="margin:0 0 10px;color:#e9c46a">NeerMela <span style="color:#eaf0ff">নীড়মেলা</span></h2>
    <p style="margin:0 0 14px;color:#b8c2d9">${String(subject || '').replace(/</g, '&lt;')}</p>
    <div style="white-space:pre-line;font-size:15px;line-height:1.7">${safe}</div>
    <p style="margin:20px 0 0;font-size:12px;color:#7d8aa5">If you didn't request this, you can safely ignore this email.</p>
  </div>`;
}

const providers = {
  // Local/dev: prints the code to the server log so you can test the full flow.
  mock: {
    async send({ to, subject, text }) {
      console.log(`[email:mock] -> ${to} :: ${subject} :: ${text}`);
      return { id: 'mock_' + Date.now(), provider: 'mock' };
    },
  },

  // Resend — simple HTTPS API, works great from Render (no SMTP ports needed).
  // Env: RESEND_API_KEY, EMAIL_FROM
  resend: {
    async send({ to, subject, text }) {
      const key = process.env.RESEND_API_KEY;
      if (!key) throw new Error('RESEND_API_KEY not set.');
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM,
          to: [to],
          subject: subject || 'Your NeerMela code',
          text: String(text == null ? '' : text),
          html: htmlWrap(subject || 'Your verification code', text),
        }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(`resend error ${resp.status}: ${body && (body.message || JSON.stringify(body))}`);
      }
      return { id: (body && body.id) || 'resend_' + Date.now(), provider: 'resend' };
    },
  },

  // Brevo (Sendinblue) alternative — 300 emails/day free.
  // Env: BREVO_API_KEY, EMAIL_FROM (e.g. "NeerMela <noreply@neermela.com>")
  brevo: {
    async send({ to, subject, text }) {
      const key = process.env.BREVO_API_KEY;
      if (!key) throw new Error('BREVO_API_KEY not set.');
      // parse "Name <email>" or plain "email"
      const m = /<([^>]+)>/.exec(FROM);
      const senderEmail = (m ? m[1] : FROM).trim();
      const senderName = (m ? FROM.replace(/<[^>]+>/, '') : 'NeerMela').trim() || 'NeerMela';
      const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: senderName, email: senderEmail },
          to: [{ email: to }],
          subject: subject || 'Your NeerMela code',
          textContent: String(text == null ? '' : text),
          htmlContent: htmlWrap(subject || 'Your verification code', text),
        }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(`brevo error ${resp.status}: ${body && (body.message || JSON.stringify(body))}`);
      }
      return { id: (body && body.messageId) || 'brevo_' + Date.now(), provider: 'brevo' };
    },
  },

  ses: {
    async send() {
      throw new Error('SES adapter not configured. Implement send() with your AWS SES client.');
    },
  },
};

export const email = {
  async send(args) {
    return (providers[config.providers.email] || providers.mock).send(args);
  },
};
