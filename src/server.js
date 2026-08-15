// NeerMela API — entry point. Modular monolith + API gateway (spec §3, §79).
import http from 'node:http';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config/index.js';
import v1 from './routes.js';
import healthRoutes from './modules/health/routes.js';
import { requestId, accessLog, rateLimit, errorHandler, notFound } from './gateway/middleware.js';
import { attachWebSocket } from './modules/messaging/ws.js';
import { checkProductionSafety } from './lib/safety.js';

checkProductionSafety();

const app = express();
app.set('trust proxy', true);

// Security headers + CORS (spec §50).
app.use(helmet());
const corsOrigins = process.env.CORS_ORIGINS || '*';
app.use(cors({ origin: corsOrigins === '*' ? true : corsOrigins.split(','), credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Gateway pipeline.
app.use(requestId);
app.use(accessLog);

// Health checks are unauthenticated and not rate limited.
app.use('/', healthRoutes);

// Everything under /v1 gets a default rate limit; sensitive routes add stricter buckets themselves.
app.use('/v1', rateLimit('default'), v1);

app.use(notFound);
app.use(errorHandler);

const server = http.createServer(app);
attachWebSocket(server); // /v1/realtime

server.listen(config.port, () => {
  console.log(`NeerMela API (${config.env}) listening on :${config.port}  base=${config.baseUrl}/${config.apiVersion}`);
  console.log(`Providers → sms:${config.providers.sms} email:${config.providers.email} storage:${config.providers.storage} ai:${config.providers.ai} payment:${config.providers.payment}`);
});

// Graceful shutdown.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log(`\n${sig} received, shutting down…`); server.close(() => process.exit(0)); });
}
