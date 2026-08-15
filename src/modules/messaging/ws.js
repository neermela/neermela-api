// Real-time gateway (spec §14). WebSocket per connected device; presence + fan-out.
// Single-node in-memory fan-out for the monolith. When you split services (spec §79),
// replace publish() with a Redis pub/sub or a dedicated realtime service — the API stays the same.
import { WebSocketServer } from 'ws';
import { verifyAccessToken } from '../../lib/tokens.js';
import { query } from '../../db/pool.js';
import { redis } from '../../cache/redis.js';

// userId -> Set<WebSocket>
const clients = new Map();

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/v1/realtime' });

  wss.on('connection', (ws, req) => {
    // Token via ?access_token= or Sec-WebSocket-Protocol.
    const url = new URL(req.url, 'http://x');
    const token = url.searchParams.get('access_token');
    let auth;
    try { auth = verifyAccessToken(token); } catch { ws.close(4001, 'unauthorized'); return; }

    const uid = auth.sub;
    if (!clients.has(uid)) clients.set(uid, new Set());
    clients.get(uid).add(ws);
    redis.set(`presence:${uid}`, '1', 'EX', 60).catch(() => {});
    ws.send(JSON.stringify({ event: 'connected', user_id: uid }));

    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      // Typing indicator relay (spec §13/§14).
      if (msg.event === 'typing' && msg.chat_id) publish(msg.chat_id, { event: 'typing', chat_id: msg.chat_id, user_id: uid }, uid);
      if (msg.event === 'ping') { redis.set(`presence:${uid}`, '1', 'EX', 60).catch(() => {}); ws.send(JSON.stringify({ event: 'pong' })); }
    });

    ws.on('close', () => {
      const set = clients.get(uid);
      if (set) { set.delete(ws); if (!set.size) clients.delete(uid); }
    });
  });

  return wss;
}

// Deliver an event to every member of a chat except the sender.
export async function publish(chatId, payload, exceptUserId = null) {
  try {
    const { rows } = await query('SELECT user_id FROM messaging.chat_members WHERE chat_id=$1', [chatId]);
    for (const { user_id } of rows) {
      if (user_id === exceptUserId) continue;
      const set = clients.get(user_id);
      if (!set) continue;
      const data = JSON.stringify(payload);
      for (const ws of set) { if (ws.readyState === 1) ws.send(data); }
    }
  } catch (e) { console.error('[ws.publish]', e.message); }
}

// Deliver an event directly to one user's connected devices (wallet, requests, etc.).
export function publishUser(userId, payload) {
  const set = clients.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) { if (ws.readyState === 1) ws.send(data); }
}
