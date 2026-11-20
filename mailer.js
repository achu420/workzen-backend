// Outgoing e-mail over SMTP (invitations, password reset, notification e-mails).
//
// Settings come from the environment (a private .env file is loaded at start-up, see env-file.js):
//   SMTP_HOST, SMTP_PORT (587 = STARTTLS, 465 = TLS), SMTP_USER, SMTP_PASS, EMAIL_FROM, EMAIL_FROM_NAME
// The BROADCAST_SMTP_HOST / _PORT / _USER / _PASS and BROADCAST_EMAIL_FROM names are accepted as aliases.
// With no host configured the mailer is disabled and every send reports { sent: false, reason: 'not_configured' }.
// The password is never logged or returned. Addresses that can never receive mail (example.com, *.test, ...) are
// skipped instead of bouncing.
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

// Inline logo referenced by the e-mail layout as <img src="cid:workzen-logo">; mail clients block SVG and data: images.
const LOGO_ATTACHMENT = { filename: 'workzen-logo.png', path: fileURLToPath(new URL('./assets/workzen-logo-email.png', import.meta.url)), cid: 'workzen-logo' };

const RESERVED = /(^|\.)(test|example|invalid|localhost|local)$|^example\.(com|net|org)$/i;

export function isDeliverableAddress(address) {
  const match = /^[^@\s]+@([^@\s]+)$/.exec(String(address ?? '').trim());

  return Boolean(match) && !RESERVED.test(match[1]);
}

const maskAddress = (address) => String(address).replace(/^(.).*(@.*)$/, '$1***$2');

export function mailerSettings(env = process.env) {
  const pick = (name) => env[`SMTP_${name}`] ?? env[`BROADCAST_SMTP_${name}`];
  const port = Number(pick('PORT')) || 587;

  return {
    host: pick('HOST') || '',
    port,
    user: pick('USER') || '',
    pass: pick('PASS') || '',
    from: env.EMAIL_FROM || env.BROADCAST_EMAIL_FROM || pick('USER') || '',
    fromName: env.EMAIL_FROM_NAME || 'Workzen',
    secure: port === 465,
  };
}

export function createMailer({ env = process.env, transport, logger = console } = {}) {
  const settings = mailerSettings(env);
  const enabled = Boolean(settings.host && settings.from);
  const transporter = transport ?? (enabled ? nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    requireTLS: !settings.secure,
    auth: settings.user ? { user: settings.user, pass: settings.pass } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  }) : null);

  return {
    enabled,
    /** Safe to show to an admin: no password. */
    describe: () => ({ enabled, host: settings.host || null, port: settings.port, from: settings.from || null, from_name: settings.fromName, user: settings.user ? maskAddress(settings.user) : null }),
    /** Connects and authenticates without sending anything. */
    async verify() {
      if (!enabled) return { ok: false, reason: 'not_configured' };
      try {
        await transporter.verify();
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: 'smtp_error', message: String(error?.message ?? error).replaceAll(settings.pass || '\u0000', '***').slice(0, 300) };
      }
    },
    /** @returns {Promise<{sent: boolean, reason?: string, message?: string}>} never throws. */
    async send({ to, subject, text, html }) {
      if (!enabled) return { sent: false, reason: 'not_configured' };
      if (!isDeliverableAddress(to)) return { sent: false, reason: 'undeliverable_address' };
      try {
        await transporter.sendMail({ from: `"${settings.fromName.replace(/"/g, '')}" <${settings.from}>`, to, subject, text, html, ...(html?.includes('cid:workzen-logo') ? { attachments: [LOGO_ATTACHMENT] } : {}) });
        logger.log?.(`[mail] sent "${String(subject).slice(0, 60)}" to ${maskAddress(to)}`);
        return { sent: true };
      } catch (error) {
        const message = String(error?.message ?? error).replaceAll(settings.pass || '\u0000', '***').slice(0, 300);

        logger.warn?.(`[mail] failed to send to ${maskAddress(to)}: ${message}`);
        return { sent: false, reason: 'smtp_error', message };
      }
    },
  };
}
