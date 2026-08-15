// Payment provider abstraction (spec §38). Swap via PAYMENT_PROVIDER (bkash/nagad/...).
// One provider going down must NOT take the whole platform down.
import { config } from '../../config/index.js';
const providers = {
  mock: {
    async createPayment({ amount, currency, orderId }) { return { paymentId: 'pay_mock_' + Date.now(), status: 'created', checkoutUrl: `http://localhost:8080/mock-checkout?order=${orderId}&amount=${amount}&ccy=${currency}` }; },
    async refund({ paymentId }) { return { paymentId, status: 'refunded' }; },
  },
  bkash: { async createPayment() { throw new Error('bKash adapter not configured. Implement createPayment() with the bKash tokenized checkout API.'); }, async refund() { throw new Error('bKash refund not configured.'); } },
  nagad: { async createPayment() { throw new Error('Nagad adapter not configured.'); }, async refund() { throw new Error('Nagad refund not configured.'); } },
};
export const payment = {
  createPayment(a) { return (providers[config.providers.payment] || providers.mock).createPayment(a); },
  refund(a) { return (providers[config.providers.payment] || providers.mock).refund(a); },
};
