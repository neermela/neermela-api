// Prefixed, sortable-ish unique IDs (spec §8: internal immutable IDs).
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
function base32(n = 16) {
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

// e.g. NM_usr_01HX8K9X..., NM_chat_..., REQ_..., CH_... (OTP challenge)
export const id = (prefix) => `${prefix}_${base32(20)}`;
export const userId = () => id('NM_usr');
export const chatId = () => id('NM_chat');
export const msgId = () => id('NM_msg');
export const mediaId = () => id('NM_med');
export const sessionId = () => id('NM_sess');
export const challengeId = () => id('CH');
export const requestId = () => id('REQ');
export const pollId = () => id('NM_poll');
export const billId = () => id('NM_bill');
