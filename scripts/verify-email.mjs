/**
 * Confirms the Gmail credentials work - outbound and inbound - and optionally
 * sends one real message.
 *
 *   node scripts/verify-email.mjs                 -> check SMTP + IMAP only
 *   node scripts/verify-email.mjs you@example.com -> also send a test message
 *
 * This exists because every send in the app is deliberately swallowed
 * (src/lib/email/send.ts never throws, so a mail outage cannot fail a
 * registration). The cost of that guarantee is that a typo'd App Password is
 * indistinguishable from "email not configured" until somebody notices no mail
 * has arrived. This script is the loud channel.
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

// Minimal .env reader. The app gets these from Next's own loader; a bare node
// script does not, and pulling in dotenv for six lines is not worth a
// dependency.
for (const file of ['.env.local', '.env']) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue; // real env wins
    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, '');
  }
}

const nodemailer = require('nodemailer');

/**
 * Mirrors src/lib/email/identity.ts. Duplicated rather than imported because
 * this is a plain .mjs script with no TypeScript loader - and because the
 * check has to run even when the app does not compile. If the allowlist there
 * changes, change it here.
 */
const MAIL_ACCOUNT = 'supportcampushub@gmail.com';
const ROLE_MAILBOXES = [MAIL_ACCOUNT];
const bare = (value) => {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  return (/<([^>]+)>/.exec(raw)?.[1] ?? raw).trim().toLowerCase();
};

/**
 * Refuses any other address before it is ever used.
 *
 * This is the check the whole configuration exists to enforce, so it runs
 * first and exits non-zero: a deploy pipeline that calls this script fails on
 * a foreign address rather than shipping it.
 */
function requireRoleMailbox(variable, value, fallback) {
  const address = bare(value);
  if (!address) return fallback;
  if (!ROLE_MAILBOXES.includes(address)) {
    console.error(`\n  ${variable}=<${address}> is not the platform mailbox.`);
    console.error(`  Only ${MAIL_ACCOUNT} may be used for project email.\n`);
    process.exit(1);
  }
  return address;
}

const user = requireRoleMailbox('SMTP_USER', process.env.SMTP_USER, MAIL_ACCOUNT);
const fromAddress = requireRoleMailbox('EMAIL_FROM', process.env.EMAIL_FROM, MAIL_ACCOUNT);
const replyTo = requireRoleMailbox('EMAIL_SUPPORT_ADDRESS', process.env.EMAIL_SUPPORT_ADDRESS, MAIL_ACCOUNT);
const imapUser = requireRoleMailbox('IMAP_USER', process.env.IMAP_USER, MAIL_ACCOUNT);

/**
 * Whitespace is stripped here exactly as smtpSettings() does in
 * src/lib/email/send.ts. When the two disagreed, a password pasted with the
 * dashboard's trailing space was reported here as the wrong length against a
 * secret the app itself was using correctly. Google in particular prints the
 * App Password in four groups of four, which is routinely pasted with spaces.
 */
const pass = (process.env.SMTP_PASSWORD ?? '').replace(/\s+/g, '');
const host = process.env.SMTP_HOST?.trim() || 'smtp.gmail.com';
const port = Number(process.env.SMTP_PORT || 465);
const displayName =
  process.env.EMAIL_SENDER_NAME?.trim() ||
  /^(.*?)\s*</.exec(process.env.EMAIL_FROM ?? '')?.[1]?.replace(/^"|"$/g, '').trim() ||
  'CampusNoteHub';
const from = `${displayName} <${fromAddress}>`;

if (!pass) {
  console.error('\n  SMTP_PASSWORD is not set.\n');
  console.error('  For Gmail:');
  console.error('    1. Sign in as ' + user + ' and turn on 2-Step Verification.');
  console.error('    2. myaccount.google.com > Security > 2-Step Verification > App passwords.');
  console.error('    3. Create one for "Mail"; Google shows 16 characters in four groups.');
  console.error('    4. Put it in .env as SMTP_PASSWORD (and IMAP_PASSWORD - same account).\n');
  process.exit(1);
}

/**
 * Says WHICH mailbox is in play and whether the secret has a plausible SHAPE,
 * without ever printing it. Both facts were invisible before, and both produce
 * the same 535 from the server as a genuinely wrong password.
 */
console.log(`\n  Sender     -  ${from}`);
console.log(`  Reply-To   -  ${replyTo}`);
console.log(`  SMTP       -  ${user} at ${host}:${port}`);
console.log(`  Secret     -  ${pass.length} characters (value never printed)`);
if (pass.length !== 16) {
  console.warn('  WARNING    -  a Gmail App Password is 16 characters once spaces are stripped.');
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure: port === 465,
  requireTLS: port !== 465,
  auth: { user, pass },
  connectionTimeout: 10_000,
});

try {
  await transporter.verify();
  console.log(`\n  SMTP OK    -  ${user} via ${host}:${port}`);
} catch (error) {
  console.error(`\n  SMTP FAILED: ${error.message}\n`);
  if (/authentication failed|invalid login|username and password not accepted|535/i.test(error.message)) {
    console.error('  That is an authentication failure. Almost always one of:');
    console.error('    - using the Google account password instead of an App Password');
    console.error('    - 2-Step Verification is off, so the account cannot mint an App Password');
    console.error('    - the App Password was revoked, or the account was reset\n');
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Inbound. Same account, same App Password - this only proves IMAP access is
// switched on for it, which is a separate Gmail setting from SMTP.
// ---------------------------------------------------------------------------
const imapPass = (process.env.IMAP_PASSWORD ?? '').replace(/\s+/g, '');
const imapHost = process.env.IMAP_HOST?.trim() || 'imap.gmail.com';
const imapPort = Number(process.env.IMAP_PORT || 993);

if (!imapPass) {
  console.warn(`\n  IMAP       -  IMAP_PASSWORD is not set; ${imapUser} is not being read.\n`);
} else {
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({
    host: imapHost,
    port: imapPort,
    secure: imapPort === 993,
    auth: { user: imapUser, pass: imapPass },
    logger: false,
    greetingTimeout: 10_000,
  });
  try {
    await client.connect();
    const status = await client.status('INBOX', { unseen: true, messages: true });
    console.log(`  IMAP OK    -  ${imapUser} via ${imapHost}:${imapPort}`);
    console.log(`                INBOX: ${status.messages ?? 0} messages, ${status.unseen ?? 0} unseen\n`);
  } catch (error) {
    console.error(`\n  IMAP FAILED: ${error.message}\n`);
    console.error('  Check that IMAP access is enabled for the mailbox:');
    console.error('    Gmail > Settings > See all settings > Forwarding and POP/IMAP > Enable IMAP\n');
    process.exit(1);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

const recipient = process.argv[2];
if (!recipient) {
  console.log('  Pass an address to send a real test message:');
  console.log('    node scripts/verify-email.mjs you@example.com\n');
  process.exit(0);
}

const info = await transporter.sendMail({
  from,
  replyTo,
  to: recipient,
  subject: 'CampusNoteHub email test',
  text: 'If you can read this, CampusNoteHub can send mail from this account. Replies go to ' + replyTo + '.',
  html:
    '<div style="font-family:system-ui,sans-serif;padding:24px">' +
    '<h2 style="margin:0 0 8px">CampusNoteHub email test</h2>' +
    '<p style="color:#475569;margin:0">If you can read this, CampusNoteHub can send mail from this account.</p>' +
    `<p style="color:#475569;margin:8px 0 0">Replies go to ${replyTo}.</p>` +
    '</div>',
});

console.log(`  Sent to ${recipient}  (id ${info.messageId})\n`);
