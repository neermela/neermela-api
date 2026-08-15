// Card-issuing provider abstraction (spec §99). NeerMela does NOT issue Visa itself —
// it integrates a licensed issuer/BaaS. Swap via CARD_PROVIDER without changing the API.
import { config } from '../../config/index.js';

const luhnLast4 = () => String(Math.floor(1000 + Math.random() * 9000));

const providers = {
  // Sandbox: represents a card so the whole flow works end-to-end while you onboard a real issuer.
  sandbox: {
    async issue({ userId, currency = 'USD' }) {
      const now = new Date();
      return { provider_ref: 'card_sbx_' + Date.now(), brand: 'VISA', last4: luhnLast4(),
        exp_month: now.getMonth() + 1, exp_year: now.getFullYear() + 4, currency };
    },
    async setStatus() { return true; },
  },
  // Stripe Issuing — real virtual/physical Visa cards via API (needs a Stripe Issuing account).
  stripe: {
    async issue() { throw new Error('Stripe Issuing not configured. Add STRIPE_KEY + implement issue() with stripe.issuing.cards.create().'); },
    async setStatus() { throw new Error('Stripe Issuing not configured.'); },
  },
  // Marqeta / Rapyd — global card issuing platforms.
  marqeta: { async issue() { throw new Error('Marqeta not configured.'); }, async setStatus() { throw new Error('Marqeta not configured.'); } },
};

export const cards = {
  issue(a) { return (providers[config.providers.card] || providers.sandbox).issue(a); },
  setStatus(a) { return (providers[config.providers.card] || providers.sandbox).setStatus(a); },
};
