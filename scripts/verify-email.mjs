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

const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASSWORD;
const from = process.env.EMAIL_FROM ?? 'UniPath <mammdhamidli04@gmail.com>';

if (!user || !pass) {
  console.error('\n  SMTP_USER / SMTP_PASSWORD are not set.\n');
  console.error('  For Gmail:');
  console.error('    1. Enable 2-Step Verification on the account.');
  console.error('    2. Create an App Password: https://myaccount.google.com/apppasswords');
  console.error('    3. Put it in .env as SMTP_PASSWORD (16 chars, spaces are fine).\n');
  process.exit(1);
}

const port = Number(process.env.SMTP_PORT ?? 465);
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
  port,
  secure: port === 465,
  auth: { user, pass },
  connectionTimeout: 10_000,
});

try {
  await transporter.verify();
  console.log(`\n  SMTP OK  -  ${user} via ${process.env.SMTP_HOST ?? 'smtp.gmail.com'}:${port}`);
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
