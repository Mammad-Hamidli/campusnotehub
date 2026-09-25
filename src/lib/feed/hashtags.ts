/**
 * Hashtags, one definition for the composer and the feed API.
 *
 * A tag is 2-40 letters, digits or underscores in any script, so #İmtahan and
 * #Экзамен are tags. It must start the text or follow a character that cannot
 * be part of a word, so "email#tag" and "C#" do not count.
 */
export const TAG_PATTERN = /^[\p{L}\p{N}_]{2,40}$/u;
export const MAX_POST_TAGS = 5;

const HASHTAG = /(?<![\p{L}\p{N}_&#])#([\p{L}\p{N}_]{2,40})(?![\p{L}\p{N}_])/gu;

/** Unique by lowercase, first spelling wins, in order of appearance. */
function unique(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags.filter((tag) => {
    const key = tag.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractHashtags(text: string): string[] {
  return unique([...text.matchAll(HASHTAG)].map((m) => m[1]));
}

/**
 * Hashtags the writer has FINISHED typing: something follows them. The one at
 * the very end is still being typed, and asking "save #Ex as a template?"
 * mid-word would be noise.
 */
export function completedHashtags(text: string): string[] {
  return unique(
    [...text.matchAll(HASHTAG)]
      .filter((m) => (m.index ?? 0) + m[0].length < text.length)
      .map((m) => m[1]),
  );
}

/** Splits text into plain and hashtag runs, for rendering tags as links. */
export function splitHashtags(text: string): { text: string; tag?: string }[] {
  const out: { text: string; tag?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(HASHTAG)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ text: m[0], tag: m[1] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
