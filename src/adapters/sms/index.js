// SMS provider abstraction (spec §6, §26, §99). Swap providers via SMS_PROVIDER
// without changing the public API contract. Each provider implements send().
import { config } from '../../config/index.js';

const providers = {
  // Local/dev: prints the code to the server log so you can test the full flow.
  mock: {
    async send({ to, text }) {
      console.log(`[sms:mock] -> ${to} :: ${text}`);
      return { id: 'mock_' + Date.now(), provider: 'mock' };
    },
  },
  // Wire your real gateway here (Twilio, local BD SMS aggregator, etc.).
  twilio: {
    async send({ to, text }) {
      // const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_SECRET);
      // const msg = await client.messages.create({ to, from: process.env.TWILIO_FROM, body: text });
      // return { id: msg.sid, provider: 'twilio' };
      throw new Error('Twilio adapter not configured. Set TWILIO_* env vars and implement send().');
    },
  },
  // bulksmsbd.net — Bangladesh SMS gateway (OTP / transactional).
  // Env: BULKSMSBD_API_KEY, BULKSMSBD_SENDER_ID (optional).
  bulksmsbd: {
    async send({ to, text }) {
      const apiKey = process.env.BULKSMSBD_API_KEY;
      const senderId = process.env.BULKSMSBD_SENDER_ID || '';
      if (!apiKey) throw new Error('BULKSMSBD_API_KEY not set.');
      // bulksmsbd expects numbers like 8801XXXXXXXXX (no '+').
      const num = String(to).replace(/[^0-9]/g, '');
      const params = new URLSearchParams({
        api_key: apiKey,
        type: 'text',
        number: num,
        senderid: senderId,
        message: text,
      });
      const url = 'http://bulksmsbd.net/api/smsapi';
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const bodyText = await resp.text().catch(() => '');
      // bulksmsbd returns a response_code; 202 = SMS submitted successfully.
      let parsed = null;
      try { parsed = JSON.parse(bodyText); } catch { /* plain text */ }
      const code = parsed && (parsed.response_code ?? parsed.code);
      if (code && Number(code) !== 202) {
        throw new Error(`bulksmsbd error ${code}: ${parsed.error_message || bodyText}`);
      }
      return { id: 'bulksmsbd_' + Date.now(), provider: 'bulksmsbd', raw: bodyText.slice(0, 200) };
    },
  },
};

export const sms = {
  async send(args) {
    const p = providers[config.providers.sms] || providers.mock;
    return p.send(args);
  },
};
