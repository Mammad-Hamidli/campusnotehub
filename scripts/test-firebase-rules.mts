/**
 * Proves the Firestore security rules deny what they claim to.
 *
 *   npm run firebase:emulators          # in one terminal
 *   npm run test:firebase-rules         # in another
 *
 * =============================================================================
 * WHY THIS USES THE CLIENT SDK
 * =============================================================================
 * The Admin SDK BYPASSES security rules entirely, so a test written with it
 * would pass no matter what the rules said - it would prove only that the data
 * exists. These assertions run through the client SDK, which is the code path
 * a browser actually takes and the only one the rules govern.
 *
 * Under Postgres this whole class of test was unnecessary: nothing but the
 * application had the connection string, so there was no direct client path to
 * secure. Firestore opens that path by default, which is why closing it needs
 * to be verified rather than assumed.
 */
import { initializeApp, deleteApp } from 'firebase/app';
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  setDoc,
} from 'firebase/firestore';

const HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const [hostname, port] = HOST.split(':');

const app = initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? 'campushub-local', apiKey: 'emulator' }, 'rules-test');
const db = getFirestore(app);
connectFirestoreEmulator(db, hostname, Number(port));

type Case = { label: string; expect: 'deny' | 'allow'; run: () => Promise<unknown> };

const cases: Case[] = [
  // Reads that must be refused: each of these documents holds something the
  // SQL schema protected by never putting it in a SELECT.
  { label: 'user document (email, phone, legal name)', expect: 'deny', run: () => getDoc(doc(db, 'users', 'anything')) },
  { label: 'sessions (credential-adjacent)', expect: 'deny', run: () => getDocs(collection(db, 'sessions')) },
  { label: 'auditLogs (who did what to whom)', expect: 'deny', run: () => getDocs(collection(db, 'auditLogs')) },
  { label: 'ledgerEntries (money)', expect: 'deny', run: () => getDocs(collection(db, 'ledgerEntries')) },
  { label: 'wallets (balances)', expect: 'deny', run: () => getDocs(collection(db, 'wallets')) },
  { label: 'verificationCases (fraud signals)', expect: 'deny', run: () => getDocs(collection(db, 'verificationCases')) },
  { label: 'blocklist (PII hashes)', expect: 'deny', run: () => getDocs(collection(db, 'blocklist')) },
  { label: 'moderationActions', expect: 'deny', run: () => getDocs(collection(db, 'moderationActions')) },
  { label: 'mediaAssets metadata', expect: 'deny', run: () => getDocs(collection(db, 'mediaAssets')) },

  // Writes: there is NO client write path anywhere in the product.
  { label: 'WRITE a post', expect: 'deny', run: () => setDoc(doc(db, 'posts', 'evil'), { body: 'injected' }) },
  { label: 'WRITE own user doc (role escalation)', expect: 'deny', run: () => setDoc(doc(db, 'users', 'evil'), { role: 'ADMIN' }) },
  { label: 'WRITE a ledger entry (forge money)', expect: 'deny', run: () => setDoc(doc(db, 'ledgerEntries', 'evil'), { amountMinor: 999999 }) },
  { label: 'WRITE an audit log (forge history)', expect: 'deny', run: () => setDoc(doc(db, 'auditLogs', 'evil'), { action: 'FAKE' }) },

  // The public catalogue the registration form renders before sign-in.
  { label: 'universities (public catalogue)', expect: 'allow', run: () => getDocs(collection(db, 'universities')) },
];

let pass = 0;
let fail = 0;

console.log('Firestore security rules\n');
for (const testCase of cases) {
  let denied = false;
  try {
    await testCase.run();
  } catch {
    denied = true;
  }
  const ok = testCase.expect === 'deny' ? denied : !denied;
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${testCase.expect.toUpperCase().padEnd(5)}  ${testCase.label}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
await deleteApp(app);
process.exit(fail === 0 ? 0 : 1);
