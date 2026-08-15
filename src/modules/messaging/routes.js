// Messaging API (spec §13). Chats + messages. Real-time delivery via WebSocket (see ws.js).
import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { ok, created, Errors } from '../../gateway/respond.js';
import { requireAuth, requireScope, idempotency } from '../../gateway/middleware.js';
import { chatId as newChatId, msgId as newMsgId, pollId } from '../../lib/ids.js';
import { publish } from './ws.js';

const r = Router();

// Create or fetch a 1:1 / group chat.
const createChat = z.object({
  type: z.enum(['dm', 'group']).default('dm'),
  member_ids: z.array(z.string()).min(1),
  title: z.string().max(80).optional(),
});
r.post('/chats', requireAuth, idempotency, async (req, res, next) => {
  try {
    const p = createChat.parse(req.body);
    const members = Array.from(new Set([req.auth.userId, ...p.member_ids]));

    // Deterministic id for DMs so both sides resolve the same chat.
    let cid;
    if (p.type === 'dm' && members.length === 2) {
      cid = 'NM_chat_dm_' + [...members].sort().join('_').replace(/[^A-Za-z0-9_]/g, '');
      const { rows } = await query('SELECT * FROM messaging.chats WHERE chat_id=$1', [cid]);
      if (rows[0]) return ok(res, { chat: rows[0] });
    } else {
      cid = newChatId();
    }

    await withTransaction(async (c) => {
      await c.query(
        `INSERT INTO messaging.chats (chat_id, type, title, created_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (chat_id) DO NOTHING`,
        [cid, p.type, p.title || null, req.auth.userId]
      );
      for (const m of members) {
        await c.query(
          `INSERT INTO messaging.chat_members (chat_id, user_id, role) VALUES ($1,$2,$3)
           ON CONFLICT (chat_id, user_id) DO NOTHING`,
          [cid, m, m === req.auth.userId ? 'owner' : 'member']
        );
      }
    });
    const { rows } = await query('SELECT * FROM messaging.chats WHERE chat_id=$1', [cid]);
    created(res, { chat: rows[0] });
  } catch (e) { next(e?.issues ? Errors.validation('Invalid chat.', e.issues) : e); }
});

r.get('/chats', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.* FROM messaging.chats c
       JOIN messaging.chat_members m ON m.chat_id=c.chat_id
       WHERE m.user_id=$1 ORDER BY c.updated_at DESC`,
      [req.auth.userId]
    );
    ok(res, { chats: rows });
  } catch (e) { next(e); }
});

async function assertMember(chatId, userId) {
  const { rows } = await query('SELECT 1 FROM messaging.chat_members WHERE chat_id=$1 AND user_id=$2', [chatId, userId]);
  if (!rows[0]) throw Errors.forbidden('You are not a member of this chat.');
}

// List messages (cursor pagination per spec §59).
r.get('/chats/:chatId/messages', requireAuth, async (req, res, next) => {
  try {
    await assertMember(req.params.chatId, req.auth.userId);
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
    const before = req.query.before || null;
    const { rows } = await query(
      `SELECT * FROM messaging.messages
       WHERE chat_id=$1 AND ($2::timestamptz IS NULL OR created_at < $2)
       ORDER BY created_at DESC LIMIT $3`,
      [req.params.chatId, before, limit]
    );
    ok(res, { messages: rows.reverse() }, { limit, has_next: rows.length === limit, next_cursor: rows[0]?.created_at || null });
  } catch (e) { next(e); }
});

// Send a message. Idempotency-Key prevents duplicates on retry (spec §60).
const sendMsg = z.object({
  type: z.enum(['text', 'image', 'video', 'audio', 'voice', 'document', 'location', 'contact', 'sticker', 'gif']).default('text'),
  body: z.string().optional(),
  media_id: z.string().optional(),
  reply_to: z.string().optional(),
});
r.post('/chats/:chatId/messages', requireAuth, requireScope('messages:write'), idempotency, async (req, res, next) => {
  try {
    await assertMember(req.params.chatId, req.auth.userId);
    const p = sendMsg.parse(req.body);
    const mid = newMsgId();
    const { rows } = await query(
      `INSERT INTO messaging.messages (message_id, chat_id, sender_user_id, type, body, media_id, reply_to, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'sent') RETURNING *`,
      [mid, req.params.chatId, req.auth.userId, p.type, p.body || null, p.media_id || null, p.reply_to || null]
    );
    await query('UPDATE messaging.chats SET updated_at=now() WHERE chat_id=$1', [req.params.chatId]);
    // Fan out in real time to other members (spec §14).
    publish(req.params.chatId, { event: 'message.new', message: rows[0] }, req.auth.userId);
    created(res, { message: rows[0] });
  } catch (e) { next(e?.issues ? Errors.validation('Invalid message.', e.issues) : e); }
});

// Edit / delete / read (spec §13).
r.patch('/messages/:messageId', requireAuth, async (req, res, next) => {
  try {
    const p = z.object({ body: z.string() }).parse(req.body);
    const { rows } = await query(
      `UPDATE messaging.messages SET body=$1, edited=true, updated_at=now()
       WHERE message_id=$2 AND sender_user_id=$3 RETURNING *`,
      [p.body, req.params.messageId, req.auth.userId]
    );
    if (!rows[0]) throw Errors.notFound('Message not found or not yours.');
    publish(rows[0].chat_id, { event: 'message.edited', message: rows[0] }, req.auth.userId);
    ok(res, { message: rows[0] });
  } catch (e) { next(e); }
});

r.delete('/messages/:messageId', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE messaging.messages SET status='deleted', body=NULL, updated_at=now()
       WHERE message_id=$1 AND sender_user_id=$2 RETURNING chat_id, message_id`,
      [req.params.messageId, req.auth.userId]
    );
    if (!rows[0]) throw Errors.notFound('Message not found or not yours.');
    publish(rows[0].chat_id, { event: 'message.deleted', message_id: rows[0].message_id }, req.auth.userId);
    ok(res, { deleted: true });
  } catch (e) { next(e); }
});

r.post('/messages/:messageId/read', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT chat_id FROM messaging.messages WHERE message_id=$1', [req.params.messageId]);
    if (!rows[0]) throw Errors.notFound('Message not found.');
    await query(
      `INSERT INTO messaging.receipts (message_id, user_id, state) VALUES ($1,$2,'read')
       ON CONFLICT (message_id, user_id) DO UPDATE SET state='read', updated_at=now()`,
      [req.params.messageId, req.auth.userId]
    );
    publish(rows[0].chat_id, { event: 'message.read', message_id: req.params.messageId, by: req.auth.userId }, req.auth.userId);
    ok(res, { read: true });
  } catch (e) { next(e); }
});


// ---------- Group management (v1.7) ----------
async function assertGroupAdmin(chatId, userId){
  const { rows } = await query('SELECT role FROM messaging.chat_members WHERE chat_id=$1 AND user_id=$2',[chatId,userId]);
  if(!rows[0]) throw Errors.forbidden('You are not a member of this chat.');
  if(!['owner','admin'].includes(rows[0].role)) throw Errors.forbidden('Only group admins can do that.');
}

// Group members list
r.get('/chats/:chatId/members', requireAuth, async (req,res,next)=>{
  try{
    await assertMember(req.params.chatId, req.auth.userId);
    const { rows } = await query(
      `SELECT m.user_id, m.role, m.joined_at, u.display_name, u.username, u.profile_photo AS avatar_url
       FROM messaging.chat_members m JOIN users.users u ON u.user_id=m.user_id
       WHERE m.chat_id=$1 ORDER BY m.joined_at`, [req.params.chatId]);
    ok(res,{ members: rows });
  }catch(e){ next(e); }
});

// Add a member to a group (admin only)
r.post('/chats/:chatId/members', requireAuth, async (req,res,next)=>{
  try{
    const p = z.object({ user_id: z.string() }).parse(req.body);
    await assertGroupAdmin(req.params.chatId, req.auth.userId);
    await query(
      `INSERT INTO messaging.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member')
       ON CONFLICT (chat_id,user_id) DO NOTHING`, [req.params.chatId, p.user_id]);
    await query('UPDATE messaging.chats SET updated_at=now() WHERE chat_id=$1',[req.params.chatId]);
    publish(req.params.chatId, { event:'group.member_added', user_id:p.user_id }, req.auth.userId);
    created(res,{ added:true });
  }catch(e){ next(e?.issues ? Errors.validation('Invalid member.', e.issues) : e); }
});

// Leave a group
r.post('/chats/:chatId/leave', requireAuth, async (req,res,next)=>{
  try{
    await assertMember(req.params.chatId, req.auth.userId);
    await query('DELETE FROM messaging.chat_members WHERE chat_id=$1 AND user_id=$2',[req.params.chatId, req.auth.userId]);
    publish(req.params.chatId, { event:'group.member_left', user_id:req.auth.userId }, req.auth.userId);
    ok(res,{ left:true });
  }catch(e){ next(e); }
});

// Rename group (admin only)
r.patch('/chats/:chatId', requireAuth, async (req,res,next)=>{
  try{
    const p = z.object({ title: z.string().max(80) }).parse(req.body);
    await assertGroupAdmin(req.params.chatId, req.auth.userId);
    const { rows } = await query('UPDATE messaging.chats SET title=$1, updated_at=now() WHERE chat_id=$2 RETURNING *',[p.title, req.params.chatId]);
    publish(req.params.chatId, { event:'group.renamed', title:p.title }, req.auth.userId);
    ok(res,{ chat: rows[0] });
  }catch(e){ next(e?.issues ? Errors.validation('Invalid title.', e.issues) : e); }
});

// ---------- Polls / online vote (v1.7) ----------
const createPoll = z.object({
  question: z.string().min(1).max(200),
  options: z.array(z.string().min(1).max(80)).min(2).max(10),
  multi: z.boolean().optional(),
});
r.post('/chats/:chatId/polls', requireAuth, idempotency, async (req,res,next)=>{
  try{
    await assertMember(req.params.chatId, req.auth.userId);
    const p = createPoll.parse(req.body);
    const pid = pollId();
    await query(
      `INSERT INTO messaging.polls (poll_id,chat_id,created_by,question,options,multi)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [pid, req.params.chatId, req.auth.userId, p.question, JSON.stringify(p.options), !!p.multi]);
    // Drop a poll message into the chat so it shows in the thread
    const mid = newMsgId();
    await query(
      `INSERT INTO messaging.messages (message_id,chat_id,sender_user_id,type,body,status)
       VALUES ($1,$2,$3,'poll',$4,'sent')`,
      [mid, req.params.chatId, req.auth.userId, JSON.stringify({ poll_id:pid, question:p.question })]);
    await query('UPDATE messaging.chats SET updated_at=now() WHERE chat_id=$1',[req.params.chatId]);
    publish(req.params.chatId, { event:'poll.new', poll_id:pid, question:p.question }, req.auth.userId);
    created(res,{ poll_id:pid });
  }catch(e){ next(e?.issues ? Errors.validation('Invalid poll.', e.issues) : e); }
});

async function pollResults(pollId){
  const { rows:[poll] } = await query('SELECT * FROM messaging.polls WHERE poll_id=$1',[pollId]);
  if(!poll) throw Errors.notFound('Poll not found.');
  const { rows:votes } = await query('SELECT option_index, count(*)::int AS c FROM messaging.poll_votes WHERE poll_id=$1 GROUP BY option_index',[pollId]);
  const counts = poll.options.map((_,i)=> (votes.find(v=>v.option_index===i)?.c)||0 );
  const total = counts.reduce((a,b)=>a+b,0);
  return { poll_id:poll.poll_id, chat_id:poll.chat_id, question:poll.question, options:poll.options, counts, total, closed:poll.closed };
}

r.post('/polls/:pollId/vote', requireAuth, async (req,res,next)=>{
  try{
    const p = z.object({ option_index: z.number().int().min(0) }).parse(req.body);
    const { rows:[poll] } = await query('SELECT * FROM messaging.polls WHERE poll_id=$1',[req.params.pollId]);
    if(!poll) throw Errors.notFound('Poll not found.');
    if(poll.closed) throw Errors.validation('This poll is closed.');
    await assertMember(poll.chat_id, req.auth.userId);
    if(p.option_index >= poll.options.length) throw Errors.validation('Invalid option.');
    await query(
      `INSERT INTO messaging.poll_votes (poll_id,user_id,option_index) VALUES ($1,$2,$3)
       ON CONFLICT (poll_id,user_id) DO UPDATE SET option_index=$3, created_at=now()`,
      [req.params.pollId, req.auth.userId, p.option_index]);
    const results = await pollResults(req.params.pollId);
    publish(poll.chat_id, { event:'poll.voted', ...results }, null);
    ok(res, results);
  }catch(e){ next(e?.issues ? Errors.validation('Invalid vote.', e.issues) : e); }
});

r.get('/polls/:pollId', requireAuth, async (req,res,next)=>{
  try{
    const results = await pollResults(req.params.pollId);
    await assertMember(results.chat_id, req.auth.userId);
    const { rows:[mine] } = await query('SELECT option_index FROM messaging.poll_votes WHERE poll_id=$1 AND user_id=$2',[req.params.pollId, req.auth.userId]);
    ok(res, { ...results, my_vote: mine? mine.option_index : null });
  }catch(e){ next(e); }
});


export default r;
