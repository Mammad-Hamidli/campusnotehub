import type { Locale } from '@/lib/i18n/dictionaries';

/**
 * Shape of a legal document (Terms, Privacy).
 *
 * The text lives here rather than in messages/*.json on purpose. Those three
 * files are bundled into EVERY page (see lib/i18n/dictionaries.ts), and a legal
 * document is several kilobytes per language that only two routes ever read.
 * Kept as data, the copy is imported by the legal routes alone.
 *
 * Structured rather than a Markdown string so a lawyer's edit is a text change
 * in one place, headings get stable anchors, and no Markdown parser ships to
 * the client. Section `id`s are shared across locales - they are the anchors
 * in /legal/privacy#cookies, and a link must work whatever language the reader
 * has selected.
 */
export type LegalBlock =
  /** A paragraph. */
  | string
  /** A bulleted list. */
  | { list: string[] };

export type LegalSection = {
  /** URL fragment. Lowercase, English, identical in every locale. */
  id: string;
  heading: string;
  body: LegalBlock[];
};

export type LegalDocument = {
  title: string;
  /** One or two sentences under the title: what this document covers. */
  summary: string;
  sections: LegalSection[];
};

export type LocalizedLegalDocument = {
  /** ISO date the current text takes effect. Bump it with every substantive edit. */
  effective: string;
  content: Record<Locale, LegalDocument>;
};
