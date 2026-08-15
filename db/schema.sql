-- NeerMela API — PostgreSQL schema (spec §23). Domain-separated via schemas.
-- Cloud Storage holds blobs; the database holds metadata only (spec §92).

CREATE SCHEMA IF NOT EXISTS nm_auth;
CREATE SCHEMA IF NOT EXISTS users;
CREATE SCHEMA IF NOT EXISTS messaging;
CREATE SCHEMA IF NOT EXISTS media;
CREATE SCHEMA IF NOT EXISTS audit;

-- ============================ USERS (spec §8) ============================
CREATE TABLE IF NOT EXISTS users.users (
  user_id             text PRIMARY KEY,           -- internal immutable id: NM_usr_...
  username            text UNIQUE NOT NULL,
  display_name        text NOT NULL,
  phone               text UNIQUE,
  phone_verified      boolean NOT NULL DEFAULT false,
  email               text UNIQUE,
  email_verified      boolean NOT NULL DEFAULT false,
  country             text,
  language            text NOT NULL DEFAULT 'bn',
  bio                 text,
  profile_photo       text,
  cover_photo         text,
  account_status      text NOT NULL DEFAULT 'active',      -- active | suspended | banned | deletion_scheduled
  verification_status text NOT NULL DEFAULT 'none',        -- none | verified | business
  last_seen           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users.users(phone);
CREATE INDEX IF NOT EXISTS idx_users_email ON users.users(email);

-- ======================== AUTH: OTP (spec §7) ========================
CREATE TABLE IF NOT EXISTS nm_auth.otp_challenges (
  challenge_id   text PRIMARY KEY,           -- CH_...
  user_id        text REFERENCES users.users(user_id),
  destination    text NOT NULL,              -- phone or email
  channel        text NOT NULL,              -- sms | email
  purpose        text NOT NULL,              -- login | verify | reset
  otp_hash       text NOT NULL,              -- argon2 hash, never plaintext
  attempt_count  int  NOT NULL DEFAULT 0,
  max_attempts   int  NOT NULL DEFAULT 5,
  status         text NOT NULL DEFAULT 'pending', -- pending | used | expired | locked | superseded
  ip_address     text,
  device_id      text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_destination ON nm_auth.otp_challenges(destination, status);

-- ==================== AUTH: SESSIONS (spec §9) ====================
CREATE TABLE IF NOT EXISTS nm_auth.sessions (
  session_id    text PRIMARY KEY,           -- NM_sess_...
  user_id       text NOT NULL REFERENCES users.users(user_id),
  refresh_hash  text NOT NULL,              -- sha256 of rotating refresh token
  device_id     text,
  user_agent    text,
  ip_address    text,
  scopes        text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'active', -- active | revoked
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  expires_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON nm_auth.sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON nm_auth.sessions(refresh_hash);

-- ==================== MESSAGING (spec §13, §16) ====================
CREATE TABLE IF NOT EXISTS messaging.chats (
  chat_id    text PRIMARY KEY,              -- NM_chat_...
  type       text NOT NULL DEFAULT 'dm',    -- dm | group
  title      text,
  created_by text REFERENCES users.users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messaging.chat_members (
  chat_id   text NOT NULL REFERENCES messaging.chats(chat_id) ON DELETE CASCADE,
  user_id   text NOT NULL REFERENCES users.users(user_id),
  role      text NOT NULL DEFAULT 'member', -- owner | admin | moderator | member | restricted
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messaging.messages (
  message_id     text PRIMARY KEY,          -- NM_msg_...
  chat_id        text NOT NULL REFERENCES messaging.chats(chat_id) ON DELETE CASCADE,
  sender_user_id text NOT NULL REFERENCES users.users(user_id),
  type           text NOT NULL DEFAULT 'text',
  body           text,
  media_id       text,
  reply_to       text,
  edited         boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'sent', -- sent | delivered | read | deleted | failed
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messaging.messages(chat_id, created_at);

CREATE TABLE IF NOT EXISTS messaging.receipts (
  message_id text NOT NULL REFERENCES messaging.messages(message_id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users.users(user_id),
  state      text NOT NULL DEFAULT 'delivered', -- delivered | read
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

-- ==================== MEDIA (spec §21) ====================
CREATE TABLE IF NOT EXISTS media.media (
  media_id       text PRIMARY KEY,          -- NM_med_...
  owner_user_id  text NOT NULL REFERENCES users.users(user_id),
  storage_key    text NOT NULL,
  content_type   text NOT NULL,
  status         text NOT NULL DEFAULT 'pending', -- pending | ready | processing | failed
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ==================== AUDIT (spec §49) ====================
CREATE TABLE IF NOT EXISTS audit.audit_log (
  id            bigserial PRIMARY KEY,
  actor_user_id text,
  admin_id      text,
  action        text NOT NULL,
  resource      text,
  result        text NOT NULL DEFAULT 'success',
  ip_address    text,
  device_id     text,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit.audit_log(actor_user_id, created_at);

-- ==================== WALLET (closed-loop P2P, WeChat/BOTIM-style) ====================
-- Money is stored in MINOR UNITS (poisha/fils) as bigint — never floats.
CREATE SCHEMA IF NOT EXISTS wallet;

CREATE TABLE IF NOT EXISTS wallet.accounts (
  wallet_id    text PRIMARY KEY,          -- NM_wal_...
  user_id      text UNIQUE NOT NULL REFERENCES users.users(user_id),
  currency     text NOT NULL DEFAULT 'BDT',
  balance      bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),  -- minor units
  pin_hash     text,
  status       text NOT NULL DEFAULT 'active',  -- active | frozen
  daily_limit  bigint NOT NULL DEFAULT 2500000, -- 25,000.00 in minor units
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Double-entry ledger: each transfer writes TWO rows (debit + credit) sharing a txn_id.
CREATE TABLE IF NOT EXISTS wallet.ledger (
  entry_id            bigserial PRIMARY KEY,
  wallet_id           text NOT NULL REFERENCES wallet.accounts(wallet_id),
  txn_id              text NOT NULL,                 -- NM_txn_... (shared by both sides)
  direction           text NOT NULL,                 -- debit | credit
  amount              bigint NOT NULL CHECK (amount > 0),
  balance_after       bigint NOT NULL,
  type                text NOT NULL,                 -- transfer | topup | cashout | request_pay
  counterparty_wallet text,
  counterparty_name   text,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON wallet.ledger(wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_txn ON wallet.ledger(txn_id);

-- Money requests (request money → pay).
CREATE TABLE IF NOT EXISTS wallet.requests (
  request_id   text PRIMARY KEY,          -- NM_req_...
  from_user_id text NOT NULL REFERENCES users.users(user_id),  -- who asked
  to_user_id   text NOT NULL REFERENCES users.users(user_id),  -- who should pay
  amount       bigint NOT NULL CHECK (amount > 0),
  note         text,
  status       text NOT NULL DEFAULT 'pending', -- pending | paid | declined | cancelled
  txn_id       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_requests_to ON wallet.requests(to_user_id, status);

-- ==================== KYC / identity (spec §11, §67) ====================
-- Extra profile + verification fields. NID/passport enable higher wallet limits.
ALTER TABLE users.users ADD COLUMN IF NOT EXISTS full_name    text;
ALTER TABLE users.users ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE users.users ADD COLUMN IF NOT EXISTS gender       text;
ALTER TABLE users.users ADD COLUMN IF NOT EXISTS address      text;
ALTER TABLE users.users ADD COLUMN IF NOT EXISTS is_expat     boolean NOT NULL DEFAULT false; -- প্রবাসী
ALTER TABLE users.users ADD COLUMN IF NOT EXISTS residence_country text;
ALTER TABLE users.users ADD COLUMN IF NOT EXISTS kyc_status   text NOT NULL DEFAULT 'none'; -- none | pending | verified | rejected
ALTER TABLE users.users ADD COLUMN IF NOT EXISTS kyc_tier     int  NOT NULL DEFAULT 0;       -- 0 basic, 1 verified, 2 full

CREATE TABLE IF NOT EXISTS users.kyc (
  kyc_id        text PRIMARY KEY,          -- NM_kyc_...
  user_id       text UNIQUE NOT NULL REFERENCES users.users(user_id),
  doc_type      text NOT NULL,             -- nid | passport | driving | birth
  doc_number    text NOT NULL,
  full_name     text,
  date_of_birth date,
  country       text,                      -- issuing country (probashi: their host country)
  email         text,
  doc_front_media text,                    -- media_id of uploaded photo
  doc_back_media  text,
  selfie_media    text,
  status        text NOT NULL DEFAULT 'pending', -- pending | verified | rejected
  reviewer_id   text,
  reject_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kyc_status ON users.kyc(status);

-- ==================== PLATFORM REVENUE (fees / profit) ====================
-- A special wallet that collects NeerMela's fees. Every fee is a real ledger credit here.
CREATE TABLE IF NOT EXISTS wallet.fee_config (
  key        text PRIMARY KEY,   -- p2p | cashout | merchant | topup
  bps        int NOT NULL DEFAULT 0,   -- fee in basis points (185 = 1.85%)
  flat       bigint NOT NULL DEFAULT 0,-- flat fee minor units
  min_fee    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO wallet.fee_config (key,bps,flat,min_fee) VALUES
  ('p2p',0,0,0),           -- friend-to-friend: free (like WeChat)
  ('cashout',130,0,0),
  ('cashout_verified',110,0,0),     -- cash-out: 1.85% (bKash-style) -> NeerMela profit
  ('merchant',90,0,0),    -- merchant/QR payment: 1.20%
  ('topup',0,0,0)
ON CONFLICT (key) DO NOTHING;

-- Agent flag for the owner dashboard (agents do cash-in/out; earn commission).
ALTER TABLE users.users ADD COLUMN IF NOT EXISTS is_agent boolean NOT NULL DEFAULT false;

-- ==================== VIRTUAL CARDS (issued via a BaaS/issuer partner) ====================
-- NeerMela never stores the real PAN/CVV (PCI-DSS). The card issuer (Stripe Issuing,
-- Marqeta, Rapyd, or a bank) holds card data; we keep a reference + last4 + status.
CREATE TABLE IF NOT EXISTS wallet.cards (
  card_id     text PRIMARY KEY,          -- NM_card_...
  user_id     text NOT NULL REFERENCES users.users(user_id),
  provider    text NOT NULL DEFAULT 'sandbox',  -- sandbox | stripe | marqeta | rapyd
  provider_ref text,                     -- id at the issuer
  brand       text NOT NULL DEFAULT 'VISA',
  last4       text NOT NULL,
  exp_month   int NOT NULL,
  exp_year    int NOT NULL,
  currency    text NOT NULL DEFAULT 'USD',
  type        text NOT NULL DEFAULT 'virtual',   -- virtual | physical
  status      text NOT NULL DEFAULT 'active',    -- active | frozen | cancelled
  spend_limit bigint NOT NULL DEFAULT 0,         -- monthly, minor units (0 = wallet balance)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cards_user ON wallet.cards(user_id);

-- =====================================================================
-- POLLS (online vote inside a chat/group) — added v1.7
-- =====================================================================
CREATE TABLE IF NOT EXISTS messaging.polls (
  poll_id     text PRIMARY KEY,             -- NM_poll_...
  chat_id     text NOT NULL REFERENCES messaging.chats(chat_id) ON DELETE CASCADE,
  created_by  text NOT NULL REFERENCES users.users(user_id),
  question    text NOT NULL,
  options     jsonb NOT NULL,               -- ["Option A","Option B",...]
  multi       boolean NOT NULL DEFAULT false,
  closed      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_polls_chat ON messaging.polls(chat_id, created_at);

CREATE TABLE IF NOT EXISTS messaging.poll_votes (
  poll_id      text NOT NULL REFERENCES messaging.polls(poll_id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users.users(user_id),
  option_index int  NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, user_id)
);

-- =====================================================================
-- BILL PAY (closed-loop: wallet -> platform biller settlement) — v1.7
-- =====================================================================
CREATE TABLE IF NOT EXISTS wallet.billers (
  biller_id  text PRIMARY KEY,              -- e.g. dpdc, wasa, gas, grameenphone
  name       text NOT NULL,
  category   text NOT NULL,                 -- electricity | water | gas | internet | mobile | tv
  min_amount numeric NOT NULL DEFAULT 10,
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS wallet.bill_payments (
  payment_id   text PRIMARY KEY,            -- NM_bill_...
  user_id      text NOT NULL REFERENCES users.users(user_id),
  biller_id    text NOT NULL REFERENCES wallet.billers(biller_id),
  account_ref  text NOT NULL,               -- meter no / phone / customer id
  amount_minor bigint NOT NULL,
  txn_id       text,                        -- links to wallet.ledger
  status       text NOT NULL DEFAULT 'success',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bill_user ON wallet.bill_payments(user_id, created_at);

-- Seed common Bangladesh billers (idempotent)
INSERT INTO wallet.billers (biller_id,name,category,min_amount) VALUES
  ('dpdc','DPDC (Electricity)','electricity',20),
  ('desco','DESCO (Electricity)','electricity',20),
  ('nesco','NESCO (Electricity)','electricity',20),
  ('wasa','Dhaka WASA (Water)','water',20),
  ('titas','Titas Gas','gas',20),
  ('gp','Grameenphone','mobile',10),
  ('robi','Robi','mobile',10),
  ('banglalink','Banglalink','mobile',10),
  ('link3','Link3 (Internet)','internet',300),
  ('akash','Akash DTH (TV)','tv',300)
ON CONFLICT (biller_id) DO NOTHING;
