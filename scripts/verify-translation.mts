/**
 * Answers one question: will the Translate button on a feed post work?
 *
 *   npx tsx scripts/verify-translation.mts
 *
 * It reports WHICH credential path is in use, then translates a sample string
 * into all six targets. The point is to separate the three failures that all
 * look identical from the browser - a 503 on the card:
 *
 *   - the API is not enabled on the project  -> a console click, no code change
 *   - the credential cannot mint a token     -> FIREBASE_SERVICE_ACCOUNT is wrong
 *   - the key is restricted to another API   -> fix the key's restrictions
 *
 * Read-only and free of charge in any meaningful sense: six short strings.
 */
// Must stay the first import: loads .env* the same way Next.js does.
import '../src/server/load-env';

const { TRANSLATION_TARGETS, TARGET_META } = await import('../src/lib/i18n/translatable');

const SAMPLE = 'Sabah imtahanım var, kim qeydlərini paylaşa bilər?';
const ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';

const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
const project = process.env.FIREBASE_PROJECT_ID ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

console.log(`\n  project     ${project ?? '(unset)'}`);
console.log(`  credential  ${apiKey ? 'GOOGLE_TRANSLATE_API_KEY' : 'Firebase service account'}`);

const headers: Record<string, string> = { 'content-type': 'application/json' };
let url = ENDPOINT;

if (apiKey) {
  url = `${ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
} else {
  const { adminApp } = await import('../src/lib/firebase/admin.core');
  const token = await adminApp().options.credential?.getAccessToken();
  if (!token?.access_token) {
    console.error(
      '\n  FAIL: could not mint an access token from the service account.\n' +
        '  Check FIREBASE_SERVICE_ACCOUNT (or GOOGLE_APPLICATION_CREDENTIALS), then re-run.\n',
    );
    process.exit(1);
  }
  headers.authorization = `Bearer ${token.access_token}`;
  if (project) headers['x-goog-user-project'] = project;
  console.log('  token       minted OK');
}

console.log('');
let failures = 0;

for (const target of TRANSLATION_TARGETS) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ q: SAMPLE, target, format: 'text' }),
  });

  if (!response.ok) {
    failures += 1;
    const detail = (await response.json().catch(() => null)) as
      | { error?: { message?: string; details?: { metadata?: { activationUrl?: string } }[] } }
      | null;
    const message = detail?.error?.message ?? `HTTP ${response.status}`;
    console.log(`  ${TARGET_META[target].short}  FAIL  ${message.split('.')[0]}.`);

    // The one failure with a one-click remedy; print the link rather than
    // making the operator reconstruct it from the project id.
    const activation = detail?.error?.details?.find((d) => d?.metadata?.activationUrl)?.metadata
      ?.activationUrl;
    if (activation) {
      console.log(`\n  Enable the API here, wait a minute, then re-run:\n    ${activation}\n`);
      break;
    }
    continue;
  }

  const payload = (await response.json()) as {
    data?: { translations?: { translatedText?: string; detectedSourceLanguage?: string }[] };
  };
  const first = payload.data?.translations?.[0];
  console.log(
    `  ${TARGET_META[target].short}  ok    ${first?.translatedText ?? '(no text)'} ` +
      `[detected: ${first?.detectedSourceLanguage ?? '?'}]`,
  );
}

if (failures) {
  console.error('\n  Translation is NOT working. The feed falls back to a 503 on the card.\n');
  // exitCode rather than exit(): process.exit() while a fetch socket is still
  // open trips a libuv assertion on Windows, which reads like a crash in this
  // script rather than the failure it is reporting. It does NOT stop the
  // script, so the success line below has to be an else.
  process.exitCode = 1;
} else {
  console.log('\n  Translation is working for all six targets.\n');
}
