/* =====================================================================
   NeerMela API client — works in the browser (app) and in Node.
   Handles the standardized envelope, bearer tokens, auto-refresh on 401,
   and the WebSocket realtime stream.

   Browser:
     const nm = createNeerMelaClient({ baseUrl:'https://api.neermela.com/v1' });
     await nm.otpSend({ channel:'sms', phone:'+8801...' });
     const s = await nm.otpVerify({ challenge_id, code });   // stores tokens
     nm.connectRealtime(ev => console.log(ev));

   Node:
     import { createNeerMelaClient } from './neermela-client.js';
     const nm = createNeerMelaClient({ baseUrl, WebSocketImpl: (await import('ws')).default });
   ===================================================================== */
export function createNeerMelaClient(opts = {}) {
  const state = {
    baseUrl: (opts.baseUrl || '').replace(/\/$/, ''),
    accessToken: opts.accessToken || null,
    refreshToken: opts.refreshToken || null,
    deviceId: opts.deviceId || null,
    onTokens: opts.onTokens || (() => {}),      // called whenever tokens change (persist them)
    storage: opts.storage || memoryStore(),     // { get(k), set(k,v) }
    WebSocketImpl: opts.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null),
    ws: null,
  };

  // Restore any saved tokens.
  if (!state.accessToken) state.accessToken = state.storage.get('nm_at');
  if (!state.refreshToken) state.refreshToken = state.storage.get('nm_rt');

  function setTokens({ access_token, refresh_token }) {
    if (access_token) { state.accessToken = access_token; state.storage.set('nm_at', access_token); }
    if (refresh_token) { state.refreshToken = refresh_token; state.storage.set('nm_rt', refresh_token); }
    state.onTokens({ access_token: state.accessToken, refresh_token: state.refreshToken });
  }
  function clearTokens() {
    state.accessToken = null; state.refreshToken = null;
    state.storage.set('nm_at', null); state.storage.set('nm_rt', null);
  }

  async function raw(method, path, { body, auth = true, idempotencyKey } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && state.accessToken) headers['Authorization'] = 'Bearer ' + state.accessToken;
    if (state.deviceId) headers['X-Device-Id'] = state.deviceId;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await fetch(state.baseUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { res, json };
  }

  // Core request with one automatic refresh+retry on 401.
  async function request(method, path, options = {}) {
    let { res, json } = await raw(method, path, options);
    if (res.status === 401 && options.auth !== false && state.refreshToken) {
      const refreshed = await doRefresh();
      if (refreshed) ({ res, json } = await raw(method, path, options));
    }
    if (!json) throw new ApiClientError(res.status, 'EMPTY_RESPONSE', 'Empty response from server.');
    if (json.success === false) throw new ApiClientError(res.status, json.error?.code, json.error?.message, json.error?.request_id);
    return json.data;
  }

  async function doRefresh() {
    try {
      const { json } = await raw('POST', '/auth/refresh', { auth: false, body: { refresh_token: state.refreshToken } });
      if (json?.success && json.data?.access_token) { setTokens(json.data); return true; }
    } catch { /* fall through */ }
    clearTokens();
    return false;
  }

  return {
    // ── config / tokens ──
    get baseUrl() { return state.baseUrl; },
    setBaseUrl(u) { state.baseUrl = (u || '').replace(/\/$/, ''); },
    isAuthed() { return !!state.accessToken; },
    setTokens, clearTokens,

    // ── health ──
    async health() { const r = await fetch(state.baseUrl.replace(/\/v1$/, '') + '/health'); return r.json(); },

    // ── auth (spec §5, §6, §9) ──
    otpSend: ({ channel, phone, email, purpose = 'login' }) =>
      request('POST', '/auth/otp/send', { auth: false, body: { channel, phone, email, purpose } }),
    async otpVerify({ challenge_id, code, idempotencyKey }) {
      const data = await request('POST', '/auth/otp/verify', { auth: false, body: { challenge_id, code }, idempotencyKey });
      setTokens(data);
      return data; // { user, access_token, refresh_token, is_new, ... }
    },
    async logout() { try { await request('POST', '/auth/logout'); } finally { clearTokens(); } },
    sessions: () => request('GET', '/auth/sessions'),

    // ── users (spec §11) ──
    me: () => request('GET', '/users/me'),
    updateMe: (patch) => request('PATCH', '/users/me', { body: patch }),
    getUser: (idOrUsername) => request('GET', '/users/' + encodeURIComponent(idOrUsername)),
    findUsers: (q) => request('GET', '/users?q=' + encodeURIComponent(q)),

    // ── messaging (spec §13, §14) ──
    listChats: () => request('GET', '/chats'),
    createChat: ({ type = 'dm', member_ids, title }) =>
      request('POST', '/chats', { body: { type, member_ids, title }, idempotencyKey: 'chat_' + member_ids.join('_') }),
    listMessages: (chatId, { limit = 50, before } = {}) =>
      request('GET', `/chats/${chatId}/messages?limit=${limit}` + (before ? `&before=${encodeURIComponent(before)}` : '')),
    sendMessage: (chatId, { type = 'text', body, media_id, reply_to, idempotencyKey }) =>
      request('POST', `/chats/${chatId}/messages`, { body: { type, body, media_id, reply_to }, idempotencyKey }),
    editMessage: (messageId, body) => request('PATCH', `/messages/${messageId}`, { body: { body } }),
    deleteMessage: (messageId) => request('DELETE', `/messages/${messageId}`),
    markRead: (messageId) => request('POST', `/messages/${messageId}/read`),

    // ── media (spec §21) ──
    mediaInit: (content_type, folder = 'uploads') => request('POST', '/media/upload/init', { body: { content_type, folder } }),
    mediaComplete: (media_id) => request('POST', '/media/upload/complete', { body: { media_id } }),

    // ── realtime (spec §14) ──
    connectRealtime(onEvent, onClose) {
      if (!state.WebSocketImpl || !state.accessToken) return null;
      const wsUrl = state.baseUrl.replace(/^http/, 'ws') + '/realtime?access_token=' + encodeURIComponent(state.accessToken);
      const ws = new state.WebSocketImpl(wsUrl);
      ws.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch {} };
      ws.onclose = () => { onClose && onClose(); };
      // keep-alive ping every 30s
      const ping = setInterval(() => { try { ws.readyState === 1 && ws.send(JSON.stringify({ event: 'ping' })); } catch {} }, 30000);
      ws.onclose = () => { clearInterval(ping); onClose && onClose(); };
      state.ws = ws;
      return {
        typing: (chat_id) => { try { ws.send(JSON.stringify({ event: 'typing', chat_id })); } catch {} },
        close: () => { clearInterval(ping); try { ws.close(); } catch {} },
      };
    },
  };

  function memoryStore() { const m = {}; return { get: (k) => m[k] ?? null, set: (k, v) => { m[k] = v; } }; }
}

export class ApiClientError extends Error {
  constructor(status, code, message, requestId) { super(message || code || 'Request failed'); this.status = status; this.code = code; this.requestId = requestId; }
}

// Browser global convenience.
if (typeof window !== 'undefined') { window.createNeerMelaClient = createNeerMelaClient; }
