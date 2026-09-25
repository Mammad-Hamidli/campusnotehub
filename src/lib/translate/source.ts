/**
 * Source-language detection for post translation. Browser-safe, no imports.
 *
 * MyMemory's `autodetect` is unreliable on short, casual text - which is most
 * of what a campus feed holds. "salam dostum" is read as Indonesian (where
 * "salam" is a formal greeting) and comes back as "salutation dostum"; told the
 * source is Azerbaijani, the very same call answers "hello friend". So the
 * source is decided here whenever the text itself says so, and autodetect is
 * only the fallback.
 *
 * Deliberately small: the script settles Russian, Arabic and Chinese outright;
 * for Latin text the letter ə (Azerbaijani only), the Turkic letters ğ ı ş and
 * short word lists decide between Azerbaijani, Turkish, English and German. A
 * tie or no evidence returns null, and the provider guesses as before.
 */

/**
 * Everyday words people type WITHOUT Azerbaijani letters, and their spelling.
 * The provider translates "necesen qardas" as "howesen ward" but
 * "necəsən qardaş" as "how are you brother", so the query - never the post -
 * is respelled before it is sent. Only words with a single plausible reading
 * belong here.
 */
const AZ_ASCII: Readonly<Record<string, string>> = {
  necesen: 'necəsən', nesen: 'nəsən', nece: 'necə', ne: 'nə', niye: 'niyə', bele: 'belə', hele: 'hələ',
  qardas: 'qardaş', qardasim: 'qardaşım', baci: 'bacı', beli: 'bəli',
  men: 'mən', sen: 'sən', menim: 'mənim', senin: 'sənin', mene: 'mənə', sene: 'sənə',
  ders: 'dərs', derse: 'dərsə', dersde: 'dərsdə', dersler: 'dərslər',
  gel: 'gəl', gelin: 'gəlin', gelirem: 'gəlirəm', gelirsen: 'gəlirsən', gelecem: 'gələcəm',
  gedirem: 'gedirəm', gedirsen: 'gedirsən', gedek: 'gedək',
  isteyirem: 'istəyirəm', bilirem: 'bilirəm', bilmirem: 'bilmirəm', edirem: 'edirəm',
  yaxsi: 'yaxşı', cox: 'çox', sag: 'sağ', sagol: 'sağ ol', ucun: 'üçün', ile: 'ilə',
  tesekkur: 'təşəkkür', tesekkurler: 'təşəkkürlər', zehmet: 'zəhmət', xahis: 'xahiş',
  gorusek: 'görüşək', goruserik: 'görüşərik', gunaydin: 'günaydın', axsamin: 'axşamın',
  muellim: 'müəllim', telebe: 'tələbə', telebeler: 'tələbələr',
};

const AZ_WORDS = new Set([
  ...Object.keys(AZ_ASCII),
  ...Object.values(AZ_ASCII),
  'salam', 'dost', 'dostum', 'dostlar', 'sabah', 'bu', 'var', 'yox', 'və', 'xeyr', 'xeyir', 'hə', 'harada',
  'harda', 'amma', 'ancaq', 'biz', 'siz', 'onlar', 'indi', 'sonra', 'imtahan', 'qrup', 'olar', 'olmaz',
  'sual', 'cavab', 'nədir', 'deyil', 'kim', 'universitet', 'kitab',
]);

const TR_WORDS = new Set([
  'merhaba', 'selam', 'nasılsın', 'nasilsin', 'ben', 'benim', 'değil', 'degil', 'için', 'icin', 'çok',
  'arkadaş', 'arkadaşım', 'arkadas', 'evet', 'hayır', 'hayir', 'gibi', 'yarın', 'yarin', 'güzel', 'lütfen',
]);

const EN_WORDS = new Set([
  'the', 'and', 'you', 'are', 'is', 'i', 'im', 'to', 'of', 'in', 'for', 'it', 'this', 'that', 'my', 'your',
  'we', 'with', 'have', 'has', 'what', 'how', 'hello', 'hi', 'hey', 'thanks', 'thank', 'please', 'see',
  'tomorrow', 'today', 'class', 'exam', 'friend', 'bro', 'guys', 'anyone', 'does', 'do', 'can', 'will',
  'not', 'yes', 'good', 'great', 'be', 'at', 'from', 'was', 'there', 'they', 'me', 'know', 'just', 'who',
  'where', 'when', 'why', 'but', 'or', 'if',
]);

const DE_WORDS = new Set([
  'der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'du', 'wir', 'ein', 'eine', 'mit', 'für', 'auf', 'zu',
  'ja', 'nein', 'danke', 'hallo', 'bitte', 'morgen', 'heute', 'wie', 'geht', 'bin', 'bist', 'sind',
]);

/**
 * The language `text` is written in, as a provider language code, or null
 * when the text does not say clearly enough.
 */
export function detectSourceLang(text: string): string | null {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return null;
  const share = (script: RegExp) => letters.filter((c) => script.test(c)).length / letters.length;
  if (share(/\p{Script=Cyrillic}/u) > 0.5) return 'ru';
  if (share(/\p{Script=Arabic}/u) > 0.5) return 'ar';
  if (share(/\p{Script=Han}/u) > 0.3) return 'zh';

  // Plain toLowerCase on purpose: the Azerbaijani locale would turn English
  // "I" into dotless "ı" and count it as Turkic evidence.
  const lower = text.toLowerCase();
  if (lower.includes('ə')) return 'az';

  // ğ ı ş are Turkish too; on this campus they lean Azerbaijani, and the word
  // lists still let a clearly Turkish post win.
  const score: Record<string, number> = { az: /[ğış]/.test(lower) ? 1 : 0, tr: 0, en: 0, de: /[äß]/.test(lower) ? 1 : 0 };
  for (const word of lower.match(/\p{L}+/gu) ?? []) {
    if (AZ_WORDS.has(word)) score.az++;
    if (TR_WORDS.has(word)) score.tr++;
    if (EN_WORDS.has(word)) score.en++;
    if (DE_WORDS.has(word)) score.de++;
  }
  const [best, runnerUp] = Object.entries(score).sort((a, b) => b[1] - a[1]);
  return best[1] > 0 && best[1] > runnerUp[1] ? best[0] : null;
}

/**
 * Respells ASCII-typed Azerbaijani (see AZ_ASCII). Text that already uses ə
 * was typed with the proper keyboard and is left alone.
 */
export function restoreAzSpelling(text: string): string {
  if (/[əƏ]/.test(text)) return text;
  return text.replace(/\p{L}+/gu, (word) => {
    const fixed = AZ_ASCII[word.toLowerCase()];
    if (!fixed) return word;
    const capitalised = word[0] !== word[0].toLowerCase();
    return capitalised ? fixed[0].toLocaleUpperCase('az') + fixed.slice(1) : fixed;
  });
}
