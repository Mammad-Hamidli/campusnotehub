/**
 * Plain-text normaliser for user-written text: post bodies, comments, image
 * alt text, report details.
 *
 * The feed renders text, never HTML, so markup is REMOVED rather than "made
 * safe" - there is no markup worth keeping. React already escapes this text on
 * output; stripping it on input as well means raw markup is never stored for
 * some later consumer (an email, an export, another client) to render.
 *
 * Deliberately not DOMPurify: server-side it needs jsdom, which is a heavy
 * cold-start cost on Vercel, and it exists to preserve *safe* HTML.
 *
 * Entities are NOT decoded: `&lt;script&gt;` stays literal text. Decoding
 * would turn escaped text back into markup after it had been checked.
 */
const BLOCK_ELEMENTS = /<(script|style|iframe|object|embed|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
// Tag-shaped only: a letter must follow `<`, so "I <3 notes" and "a < b" survive.
const TAGS = /<\/?[a-zA-Z][^<>]*>/g;
// C0/C1 control characters, except \n and \t.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Bidi overrides, used to visually disguise text ("abc\u202Egpj.exe").
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;

export function toPlainText(input: string): string {
  let text = input.normalize('NFC').replace(/\r\n?/g, '\n');
  // Repeat until stable, so nesting such as "<scr<b>ipt>" cannot re-form a tag
  // once the inner one is removed. Every productive pass deletes at least one
  // `<`, and callers cap the input length before this runs.
  for (let pass = 0; pass < 5; pass++) {
    const next = text.replace(BLOCK_ELEMENTS, '').replace(COMMENTS, '').replace(TAGS, '');
    if (next === text) break;
    text = next;
  }
  return text.replace(CONTROL, '').replace(BIDI, '').trim();
}
