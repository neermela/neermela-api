// Audit log (spec §49): every sensitive action is recorded and hard to delete.
import { query } from '../db/pool.js';

export async function audit({ actorUserId = null, adminId = null, action, resource = null, result = 'success', ip = null, device = null, metadata = {} }) {
  try {
    await query(
      `INSERT INTO audit.audit_log (actor_user_id, admin_id, action, resource, result, ip_address, device_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [actorUserId, adminId, action, resource, result, ip, device, metadata]
    );
  } catch (e) {
    // Never let audit failure break the request path, but do surface it.
    console.error('[audit] failed:', e.message);
  }
}
