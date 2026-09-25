import type { Locale } from '@/lib/i18n/dictionaries';
import type { LegalBlock } from '@/content/legal/types';

/**
 * Shape of an informational page linked from the landing header and footer
 * (About, Help, Safety, Contact).
 *
 * Kept as data beside the legal documents, for the same reason: the copy is
 * several kilobytes per language that only its own route reads, and
 * messages/*.json is bundled into every page. Section `id`s are URL anchors
 * (/help#notes) and are shared across locales; site.test.ts enforces it.
 *
 * Text may contain two kinds of inline link, rendered by SitePageView:
 *   - an email address, which becomes a mailto: link;
 *   - `[label](/path)`, a link to a page of this site. site.test.ts checks
 *     that every such path is a real route.
 */
export type SiteBlock =
  | LegalBlock
  /** Questions with answers, rendered as expandable rows. */
  | { faq: { q: string; a: string }[] };

export type SiteSection = {
  /** URL fragment. Lowercase, English, identical in every locale. */
  id: string;
  heading: string;
  body: SiteBlock[];
};

export type SitePage = {
  /** Small label above the title. */
  eyebrow: string;
  title: string;
  /** One or two sentences under the title. */
  summary: string;
  sections: SiteSection[];
};

export type LocalizedSitePage = Record<Locale, SitePage>;

/**
 * The inline markup SitePageView turns into links: `[label](/path)` or a bare
 * email address. Internal paths only - an external URL in the copy would be a
 * link nobody reviews. One capture group, so String.split() puts every match
 * at an odd index.
 */
export const INLINE_MARKUP = /(\[[^\]]+\]\(\/[^)\s]*\)|[\w.+-]+@[\w-]+\.[\w.]+\w)/;
export const INLINE_LINK = /^\[([^\]]+)\]\((\/[^)\s]*)\)$/;
