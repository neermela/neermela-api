// Mounts every v1 module under /v1 (spec §77). Versioned so v2 can run alongside later.
import { Router } from 'express';
import authRoutes from './modules/auth/routes.js';
import userRoutes from './modules/users/routes.js';
import messagingRoutes from './modules/messaging/routes.js';
import mediaRoutes from './modules/media/routes.js';
import walletRoutes from './modules/wallet/routes.js';
import adminRoutes from './modules/admin/routes.js';
import billpayRoutes from './modules/billpay/routes.js';

const v1 = Router();
v1.use('/auth', authRoutes);
v1.use('/users', userRoutes);
v1.use('/', messagingRoutes);   // /chats, /messages
v1.use('/media', mediaRoutes);
v1.use('/wallet', walletRoutes);
v1.use('/admin', adminRoutes);
v1.use('/billpay', billpayRoutes);

// Placeholders for the roadmap surface (spec §77). Wired in as each domain lands.
const soon = (name) => (req, res) => res.status(501).json({
  success: false,
  error: { code: 'NOT_IMPLEMENTED', message: `${name} API is on the roadmap and not built yet.`, request_id: res.locals.requestId },
});
['friends', 'follow', 'communities', 'channels', 'posts', 'stories', 'reels', 'live', 'calls',
 'notifications', 'search', 'business', 'products', 'orders', 'payments', 'marketing', 'ads', 'ai', 'developer', 'webhooks']
  .forEach((n) => v1.use('/' + n, soon(n.charAt(0).toUpperCase() + n.slice(1))));

export default v1;
