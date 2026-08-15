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
};

export const sms = {
  async send(args) {
    const p = providers[config.providers.sms] || providers.mock;
    return p.send(args);
  },
};
