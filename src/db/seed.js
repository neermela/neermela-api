// Minimal seed for local testing. Run: npm run seed
import { query } from './pool.js';
import { userId } from '../lib/ids.js';
const u1 = userId(), u2 = userId();
try {
  await query(`INSERT INTO users.users (user_id, username, display_name, phone, phone_verified) VALUES ($1,'elyas','Elyas Munna','+971526969855',true) ON CONFLICT DO NOTHING`, [u1]);
  await query(`INSERT INTO users.users (user_id, username, display_name, phone, phone_verified) VALUES ($1,'rahim','রহিম উদ্দিন','+8801685354241',true) ON CONFLICT DO NOTHING`, [u2]);
  console.log('✓ Seeded users:', u1, u2);
  process.exit(0);
} catch (e) { console.error('✗ Seed failed:', e.message); process.exit(1); }
