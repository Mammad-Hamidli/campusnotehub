/**
 * Confirms the mail credentials work, and optionally sends one real message.
 *
 *   node scripts/verify-email.mjs                 -> check credentials only
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

// Same precedence as src/lib/email/send.ts: the Gmail pair first, then SMTP_*.
const gmail = Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
const user = gmail ? process.env.GMAIL_USER.trim() : process.env.SMTP_USER;
/**
 * Whitespace is stripped from BOTH variables, matching smtpSettings() in
 * src/lib/email/send.ts. Stripping only the Gmail one made this script
 * disagree with the application about the same credential: a 16-character App
 * Password pasted with Google's display spaces was reported here as 19
 * characters, which fired the "not 16 characters" warning below against a
 * secret the app itself was using correctly.
 */
const pass = (gmail ? process.env.GMAIL_APP_PASSWORD : process.env.SMTP_PASSWORD).replace(/\s+/g, '');
const host = gmail ? 'smtp.gmail.com' : (process.env.SMTP_HOST || 'smtp.gmail.com');
const port = gmail ? 465 : Number(process.env.SMTP_PORT || 465);
const displayName =
  /^(.*?)\s*</.exec(process.env.EMAIL_FROM ?? '')?.[1]?.replace(/^"|"$/g, '').trim() || 'UniPath';
const from = `${displayName} <${user}>`;

if (!user || !pass) {
  console.error('\n  GMAIL_USER / GMAIL_APP_PASSWORD are not set.\n');
  console.error('  For Gmail:');
  console.error('    1. Enable 2-Step Verification on the account.');
  console.error('    2. Create an App Password: https://myaccount.google.com/apppasswords');
  console.error('    3. Put it in .env as GMAIL_APP_PASSWORD (16 chars, spaces are fine).\n');
  process.exit(1);
}

/**
 * Says WHICH variables are in play and whether the secret is the right SHAPE,
 * without ever printing it.
 *
 * Both facts were invisible before, and both produce the same 535 from Google
 * as a genuinely wrong password:
 *   - the wrong variable pair silently winning (GMAIL_* takes precedence over
 *     SMTP_*, so a stale GMAIL_USER masks the SMTP_USER being debugged);
 *   - a Gmail App Password that is not 16 characters, which means it was
 *     truncated on paste or is the account password rather than an App
 *     Password.
 * Only the LENGTH and the mailbox are reported - never the value itself.
 */
console.log(`\n  Using      -  ${gmail ? 'GMAIL_USER + GMAIL_APP_PASSWORD' : 'SMTP_USER + SMTP_PASSWORD'}`);
console.log(`  Mailbox    -  ${user}`);
console.log(`  Host       -  ${host}:${port}`);
console.log(`  Secret     -  ${pass.length} characters (value never printed)`);

const configuredFrom = /<([^>]+)>/.exec(process.env.EMAIL_FROM ?? '')?.[1]?.trim();
if (configuredFrom && configuredFrom.toLowerCase() !== user.toLowerCase()) {
  // Gmail rewrites any From that is not the authenticated mailbox, so this is
  // a silent surprise rather than an error: mail arrives from the wrong address.
  console.warn(`  WARNING    -  EMAIL_FROM is <${configuredFrom}> but mail will be sent as <${user}>`);
}
if (host.includes('gmail.com') && pass.length !== 16) {
  console.warn(
    `  WARNING    -  a Google App Password is exactly 16 characters; this one is ${pass.length}.` +
      '\n                That alone will produce "535 Username and Password not accepted".',
  );
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure: port === 465,
  auth: { user, pass },
  connectionTimeout: 10_000,
});

try {
  await transporter.verify();
  console.log(`\n  SMTP OK  -  ${user} via ${host}:${port}`);
  console.log(`  From     -  ${from}\n`);
} catch (error) {
  console.error(`\n  SMTP FAILED: ${error.message}\n`);
  if (/username and password not accepted|invalid login|535/i.test(error.message)) {
    console.error('  That is an authentication failure. Almost always one of:');
    console.error('    - using the Google account password instead of an App Password');
    console.error('    - 2-Step Verification not enabled on the account');
    console.error('    - the App Password was revoked\n');
  }
  process.exit(1);
}

const recipient = process.argv[2];
if (!recipient) {
  console.log('  Pass an address to send a real test message:');
  console.log('    node scripts/verify-email.mjs you@example.com\n');
  process.exit(0);
}

const info = await transporter.sendMail({
  from,
  to: recipient,
  subject: 'UniPath email test',
  text: 'If you can read this, UniPath can send mail from this account.',
  html:
    '<div style="font-family:system-ui,sans-serif;padding:24px">' +
    '<h2 style="margin:0 0 8px">UniPath email test</h2>' +
    '<p style="color:#475569;margin:0">If you can read this, UniPath can send mail from this account.</p>' +
    '</div>',
});

console.log(`  Sent to ${recipient}  (id ${info.messageId})\n`);
