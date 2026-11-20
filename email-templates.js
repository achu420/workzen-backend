// Plain, readable e-mails: a text part and a small HTML part. Everything interpolated is escaped.
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function layout({ heading, paragraphs, action, footer }) {
  const body = paragraphs.map((text) => `<p style="margin:0 0 14px;line-height:1.5">${escapeHtml(text)}</p>`).join('');
  const button = action ? `<p style="margin:22px 0"><a href="${escapeHtml(action.url)}" style="background:#1a73e8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">${escapeHtml(action.label)}</a></p><p style="margin:0 0 14px;color:#667;font-size:13px">Or open this link: ${escapeHtml(action.url)}</p>` : '';

  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;color:#1f2430"><p style="margin:0 0 20px"><img src="cid:workzen-logo" alt="workzen" width="140" style="display:block;border:0;height:auto"></p><h2 style="margin:0 0 16px;font-size:20px">${escapeHtml(heading)}</h2>${body}${button}<p style="margin:24px 0 0;color:#889;font-size:12px">${escapeHtml(footer)}</p></div>`;
}

const text = (lines) => lines.filter((line) => line !== null && line !== undefined).join('\n');

export function inviteEmail({ inviterName, workspaceName, signupUrl, acceptUrl }) {
  const subject = `${inviterName} invited you to ${workspaceName}`;
  const steps = ['1. Create your account with this e-mail address (you will not need an access code).', `2. You will be added to "${workspaceName}" automatically.`];

  return {
    subject,
    text: text([`${inviterName} invited you to join "${workspaceName}".`, '', ...steps, '', `Create your account: ${signupUrl}`, acceptUrl ? `Already have an account? Open: ${acceptUrl}` : null, '', 'If you did not expect this, you can ignore this e-mail.']),
    html: layout({ heading: `Join ${workspaceName}`, paragraphs: [`${inviterName} invited you to join "${workspaceName}".`, ...steps], action: { url: signupUrl, label: 'Create your account' }, footer: 'If you did not expect this, you can ignore this e-mail.' }),
  };
}

export function addedToWorkspaceEmail({ inviterName, workspaceName, url }) {
  const subject = `You were added to ${workspaceName}`;

  return {
    subject,
    text: text([`${inviterName} added you to "${workspaceName}".`, '', `Open it: ${url}`]),
    html: layout({ heading: subject, paragraphs: [`${inviterName} added you to "${workspaceName}".`], action: { url, label: 'Open workspace' }, footer: 'You received this because someone added your e-mail address to a workspace.' }),
  };
}

const CODE_PURPOSES = {
  recovery: { subject: 'Your password reset code', heading: 'Reset your password', line: 'Use this code to reset your password:' },
  magiclink: { subject: 'Your sign-in code', heading: 'Sign in', line: 'Use this code to sign in:' },
};

export function codeEmail({ type, code, minutes }) {
  const purpose = CODE_PURPOSES[type] ?? CODE_PURPOSES.magiclink;

  return {
    subject: purpose.subject,
    text: text([purpose.line, '', `    ${code}`, '', `It works once and expires in ${minutes} minutes. If you did not ask for it, ignore this e-mail; your password has not changed.`]),
    html: layout({ heading: purpose.heading, paragraphs: [purpose.line, `${code}`, `It works once and expires in ${minutes} minutes. If you did not ask for it, ignore this e-mail; your password has not changed.`], footer: 'Never share this code.' }).replace(`<p style="margin:0 0 14px;line-height:1.5">${escapeHtml(code)}</p>`, `<p style="margin:0 0 18px;font-size:30px;letter-spacing:6px;font-weight:700;font-family:monospace">${escapeHtml(code)}</p>`),
  };
}

const NOTIFICATION_LINES = {
  mention: (actor, page) => `${actor} mentioned you in "${page}"`,
  comment_reply: (actor, page) => `${actor} replied to your comment in "${page}"`,
  comment_on_page: (actor, page) => `${actor} commented on "${page}"`,
  person_property_assigned: (actor, page) => `${actor} assigned you to "${page}"`,
};

export const emailableNotificationTypes = new Set(Object.keys(NOTIFICATION_LINES));

export function notificationEmail({ type, actorName, pageName, url, workspaceName, unsubscribeUrl }) {
  const line = (NOTIFICATION_LINES[type] ?? ((actor, page) => `${actor} updated "${page}"`))(actorName, pageName || 'a page');
  const stop = unsubscribeUrl ? `Stop these e-mails: ${unsubscribeUrl}` : 'Ask a workspace admin if you want these e-mails turned off.';

  return {
    subject: line,
    text: text([line, '', `Open it: ${url}`, '', `Workspace: ${workspaceName}`, stop]),
    html: layout({ heading: line, paragraphs: [`Workspace: ${workspaceName}`], action: { url, label: 'Open' }, footer: stop }),
  };
}

export function testEmail({ workspaceName }) {
  return {
    subject: 'Test e-mail from Workzen',
    text: text([`This is a test message from "${workspaceName}". If you can read it, outgoing e-mail works.`]),
    html: layout({ heading: 'E-mail is working', paragraphs: [`This is a test message from "${workspaceName}". If you can read it, outgoing e-mail works.`], footer: 'Sent by the server settings check.' }),
  };
}
