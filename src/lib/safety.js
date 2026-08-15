// Production safety guard (spec §50). At boot, refuse to run with dangerous dev settings
// in production, and warn about weak ones. Protects real users and real money.
import { config } from '../config/index.js';

export function checkProductionSafety() {
  const prod = config.env === 'production';
  const errors = [], warnings = [];

  // Critical — never allowed in production.
  if (prod) {
    if (process.env.ALLOW_SANDBOX_TOPUP === 'true')
      errors.push('ALLOW_SANDBOX_TOPUP=true lets anyone mint balance. Set it to false.');
    if (process.env.AUTO_KYC === 'true')
      errors.push('AUTO_KYC=true auto-verifies identities. Set it to false and review KYC manually/with a provider.');
    if (!config.jwt.privateKey || !config.jwt.publicKey)
      errors.push('Set RS256 JWT_PRIVATE_KEY and JWT_PUBLIC_KEY (do not rely on the dev secret).');
    if (config.jwt.devSecret === 'dev-only-insecure-secret-change-me' && !config.jwt.privateKey)
      errors.push('JWT_DEV_SECRET is still the default. Set a strong secret or RS256 keys.');
    if (!process.env.ADMIN_KEY || process.env.ADMIN_KEY.length < 16)
      errors.push('ADMIN_KEY is missing or too short (>=16 chars). The dashboard would be exposed.');
    if (!process.env.PAYCODE_SECRET)
      errors.push('PAYCODE_SECRET is not set — QR pay codes would be forgeable.');
    if ((process.env.CORS_ORIGINS || '*') === '*')
      warnings.push('CORS_ORIGINS=* allows any site. Set it to your app domain(s).');
    if ((config.databaseUrl || '').includes(':neermela@'))
      warnings.push('Database is using the default password. Change it.');
  }

  for (const w of warnings) console.warn('  ⚠ SECURITY WARNING:', w);
  if (errors.length) {
    console.error('\n  ✖ REFUSING TO START — unsafe production configuration:');
    for (const e of errors) console.error('    -', e);
    console.error('  Fix these in your .env, then restart.\n');
    process.exit(1);
  }
  if (prod && !warnings.length) console.log('  ✓ Production safety checks passed.');
}
