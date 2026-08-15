// Email provider abstraction (spec §6, §26). Swap via EMAIL_PROVIDER.
import { config } from '../../config/index.js';
const providers = {
  mock: { async send({ to, subject, text }) { console.log(`[email:mock] -> ${to} :: ${subject} :: ${text}`); return { id: 'mock_' + Date.now(), provider: 'mock' }; } },
  ses:  { async send() { throw new Error('SES adapter not configured. Implement send() with your AWS SES client.'); } },
};
export const email = { async send(args) { return (providers[config.providers.email] || providers.mock).send(args); } };
