// Refuses to start a production server with development leftovers, and lists what an operator should still do.
// "Production" means NODE_ENV=production. Pure so it can be tested without starting anything.
export function checkProductionConfig({ env = process.env, storage, devKey, corsOrigins = [] }) {
  const errors = [];
  const warnings = [];

  if (devKey) errors.push('DEV_TEST_KEY is set: the development membership helper must not exist in production. Unset it.');
  if (storage !== 'postgres' && env.ALLOW_JSON_STORAGE !== 'true') {
    errors.push('STORAGE=postgres is required in production (the JSON file store rewrites everything on each change and has no backup path). Set ALLOW_JSON_STORAGE=true only to accept that knowingly.');
  }
  if (!env.AI_KEY_SECRET) warnings.push('AI_KEY_SECRET is not set: provider API keys are encrypted with a secret file next to the data. Set AI_KEY_SECRET and keep it with your backups.');
  if (corsOrigins.some((origin) => /localhost|127\.0\.0\.1/.test(origin))) warnings.push('CORS_ALLOWED_ORIGINS still lists localhost. Set it to the public web address, or empty when the web app and API share one origin.');
  if (env.SIGNUP_ENABLED !== 'false' && !env.SIGNUP_ALLOWED_DOMAINS) warnings.push('Sign-up is open to anyone who can reach the server. Set SIGNUP_ENABLED=false, or SIGNUP_ALLOWED_DOMAINS=yourcompany.com.');
  if (!(env.SMTP_HOST || env.BROADCAST_SMTP_HOST)) warnings.push('No SMTP settings (SMTP_HOST, SMTP_USER, SMTP_PASS, EMAIL_FROM): password reset codes, invitations by e-mail and notification e-mails cannot be sent.');
  if (env.TRUST_PROXY !== 'true') warnings.push('TRUST_PROXY is not true: behind a reverse proxy every visitor shares the proxy address for sign-in throttling. Set TRUST_PROXY=true when a proxy you control sets X-Forwarded-For.');
  return { errors, warnings };
}
