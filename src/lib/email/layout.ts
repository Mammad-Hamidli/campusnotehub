/**
 * The one HTML email layout.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LOOKS LIKE 2005 HTML AND THAT IS CORRECT
 * ---------------------------------------------------------------------------
 * Nothing in here is written the way the app's own UI is written, and every
 * departure is deliberate:
 *
 *  - TABLES, not flexbox or grid. Outlook on Windows renders through Microsoft
 *    Word's HTML engine, which has no support for either. A flex layout does
 *    not degrade there, it collapses into a single unstyled column.
 *  - INLINE styles, not classes. Gmail strips <style> blocks from the message
 *    body in several of its clients, so anything that matters has to sit in a
 *    style attribute on the element itself. The <style> block below therefore
 *    carries ONLY the mobile media query and client resets - things that
 *    cannot be expressed inline and whose loss is cosmetic.
 *  - XHTML 1.0 Transitional doctype. Outlook picks its box model from the
 *    doctype, and this is the one every major template framework targets.
 *  - HEX colours, not the CSS variables the app uses. An email is rendered by
 *    someone else's client; var(--accent) resolves to nothing there. The
 *    values below are the LIGHT-mode tokens from globals.css, copied
 *    deliberately, because an email cannot read the design system at runtime.
 *  - An explicit web-safe FONT STACK on every text element. There was none
 *    before, so every client fell back to its default - which is a serif in
 *    Outlook, and looked nothing like the product.
 *  - A 600px fixed width. The de facto safe width across desktop clients, with
 *    a media query for phones that the clients which support it will honour.
 *
 * The layout is a function rather than a template string constant so that
 * every message is composed from the same header, hero, footer and spacing,
 * and a new template physically cannot forget the branding or the unsubscribe
 * context. The individual messages in templates.ts supply only their own
 * middle section.
 *
 * SECURITY: every interpolated value passes through escapeHtml(). A student's
 * own display name reaches these templates, and an unescaped name is a stored
 * XSS vector against whatever webmail renders it.
 */

import { resolveAsset, type EmailAttachment } from './assets';
import { emailBranding } from './branding';
import { appUrl } from './urls';

export { appUrl };

/**
 * Light-mode tokens from globals.css, resolved to literals. See above.
 *
 * These are a hand-copy and there is no way around that: mail clients strip
 * <style> blocks and do not resolve CSS custom properties, so every colour has
 * to be inlined as a literal. The cost is that this list can silently fall out
 * of step with the app - it already had, still carrying the indigo accent
 * (#5458c4) after the product moved to the logo's navy-derived blue, so an
 * account confirmation arrived in a colour the site no longer used anywhere.
 * When a token changes in globals.css, change it here too.
 */
const C = {
  canvas: '#f6f8fb',
  surface: '#ffffff',
  fg: '#0f1a2b',
  fgMuted: '#4c5a6e',
  fgSubtle: '#78859a',
  edge: '#e1e7f0',
  accent: '#1b5c9b',
  accentFg: '#ffffff',
  /** The logo orange. The wordmark flourish only - never an action colour. */
  brand: '#c2410c',
  verified: '#0f7a4d',
  verifiedSoft: '#e6f4ec',
  warn: '#b07908',
  warnSoft: '#fdf4e3',
  danger: '#c0352f',
  dangerSoft: '#fceceb',
  /** Footer only. Dark by design, to close the message off visually. */
  footerBg: '#0f1a2b',
  footerFg: '#a7b2c4',
  footerEdge: '#2a3242',
} as const;

/**
 * Web-safe stack with a real fallback chain.
 *
 * No webfont: Outlook ignores @font-face entirely and Gmail strips it, so a
 * Google Font would be a download that most recipients never use. The
 * system-UI names at the front are honoured by Apple Mail and iOS, and
 * everything else lands on Arial or Helvetica.
 */
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,Helvetica,sans-serif";

export type EmailTone = 'neutral' | 'success' | 'warning' | 'danger';

const TONE: Record<EmailTone, { bg: string; fg: string; border: string }> = {
  neutral: { bg: C.canvas, fg: C.fgMuted, border: C.edge },
  success: { bg: C.verifiedSoft, fg: C.verified, border: '#bfe5d4' },
  warning: { bg: C.warnSoft, fg: C.warn, border: '#f0dcb4' },
  danger: { bg: C.dangerSoft, fg: C.danger, border: '#f3c9c9' },
};

/**
 * Minimal HTML entity escaping.
 *
 * Deliberately not a dependency: five replacements is the whole job for text
 * placed in element content or a quoted attribute, and pulling a sanitiser in
 * for it would be more surface than it removes. Ampersand MUST be first, or it
 * would double-escape the entities produced by the later replacements.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type EmailBlock =
  | { kind: 'paragraph'; text: string }
  /** Label/value rows, e.g. "Faculty: Computer Science". */
  | { kind: 'facts'; rows: { label: string; value: string }[] }
  | { kind: 'callout'; tone: EmailTone; title: string; body?: string }
  | { kind: 'button'; label: string; href: string }
  /**
   * A full-width image above the card body. OPT-IN per template: a
   * photographic hero suits a welcome or an approval, and reads as tone-deaf
   * on "your account has been frozen", so the account and security messages
   * deliberately do not carry one.
   */
  | { kind: 'hero'; image: string; alt: string }
  | { kind: 'divider' };

export type EmailContent = {
  /** Subject line. Plain text; never interpolated into HTML unescaped. */
  subject: string;
  /** The <h1> inside the card. */
  heading: string;
  /** Shown in the inbox list preview next to the subject. */
  preheader: string;
  blocks: EmailBlock[];
};

/** Text styles shared by the body blocks, so the stack is declared once. */
const P = `margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.fgMuted};`;

/**
 * Renders one block, pushing any inline attachment it needs onto `attach`.
 *
 * The collector is threaded through rather than returned so a block can
 * contribute zero, one or several images without every caller unwrapping a
 * tuple.
 */
function renderBlock(block: EmailBlock, attach: EmailAttachment[]): string {
  switch (block.kind) {
    case 'paragraph':
      return `<p style="${P}">${escapeHtml(block.text)}</p>`;

    case 'facts':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;border-collapse:collapse;">
        ${block.rows
          .map(
            (row) => `<tr>
              <td style="padding:6px 12px 6px 0;font-family:${FONT};font-size:13px;color:${C.fgSubtle};white-space:nowrap;vertical-align:top;">${escapeHtml(row.label)}</td>
              <td style="padding:6px 0;font-family:${FONT};font-size:14px;color:${C.fg};font-weight:500;vertical-align:top;">${escapeHtml(row.value)}</td>
            </tr>`,
          )
          .join('')}
      </table>`;

    case 'callout': {
      const tone = TONE[block.tone];
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;border-collapse:separate;">
        <tr><td style="background-color:${tone.bg};border:1px solid ${tone.border};border-radius:10px;padding:14px 16px;">
          <p style="margin:0;font-family:${FONT};font-size:14px;font-weight:600;color:${tone.fg};">${escapeHtml(block.title)}</p>
          ${
            block.body
              ? `<p style="margin:6px 0 0;font-family:${FONT};font-size:14px;line-height:1.55;color:${C.fgMuted};">${escapeHtml(block.body)}</p>`
              : ''
          }
        </td></tr>
      </table>`;
    }

    case 'button': {
      /**
       * A bulletproof button: a table cell carries the background and the
       * radius, and the <a> carries the padding. Outlook ignores padding on an
       * inline <a> and would render a bare blue link where the CTA should be.
       *
       * The VML roundrect is the Outlook-only half. Outlook also ignores
       * border-radius, so without it the button is a hard rectangle; with it,
       * Word's renderer draws the rounded shape natively. The two halves are
       * mutually exclusive through a downlevel-revealed conditional, so no
       * client shows the button twice. The width is estimated from the label
       * because VML cannot size to its content.
       */
      const href = escapeHtml(block.href);
      const label = escapeHtml(block.label);
      const msoWidth = Math.max(160, block.label.length * 9 + 48);

      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;">
        <tr><td align="center" bgcolor="${C.accent}" style="background-color:${C.accent};border-radius:8px;">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:42px;v-text-anchor:middle;width:${msoWidth}px;" arcsize="19%" stroke="f" fillcolor="${C.accent}">
            <w:anchorlock/>
            <center style="color:${C.accentFg};font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;">${label}</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-- -->
          <a href="${href}" style="display:inline-block;padding:11px 22px;font-family:${FONT};font-size:14px;font-weight:600;color:${C.accentFg};text-decoration:none;border-radius:8px;">${label}</a>
          <!--<![endif]-->
        </td></tr>
      </table>`;
    }

    case 'hero': {
      const asset = resolveAsset(block.image);
      // Missing image: omit the block entirely rather than leaving a broken
      // icon or an empty 300px gap at the top of the message.
      if (!asset) return '';
      if (asset.attachment) attach.push(asset.attachment);

      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;border-collapse:collapse;">
        <tr><td align="center" style="padding:0;">
          <img src="${escapeHtml(asset.src)}" width="536" alt="${escapeHtml(block.alt)}" style="display:block;border:0;outline:none;text-decoration:none;width:100%;max-width:536px;height:auto;border-radius:10px;" />
        </td></tr>
      </table>`;
    }

    case 'divider':
      return `<div style="height:1px;background-color:${C.edge};margin:0 0 20px;line-height:1px;font-size:0;">&nbsp;</div>`;
  }
}

/** The branded header: logo image when available, wordmark when not. */
function renderHeader(attach: EmailAttachment[], companyName: string): string {
  const asset = resolveAsset('logo.png');
  if (asset) {
    if (asset.attachment) attach.push(asset.attachment);
    return `<a href="${escapeHtml(appUrl())}" style="text-decoration:none;">
      <img src="${escapeHtml(asset.src)}" width="180" alt="${escapeHtml(companyName)}" style="display:block;border:0;outline:none;text-decoration:none;width:180px;max-width:180px;height:auto;" />
    </a>`;
  }

  // The text wordmark. This is the pre-image behaviour and remains the
  // fallback, so a missing logo file costs nothing.
  return `<a href="${escapeHtml(appUrl())}" style="text-decoration:none;">
    <span style="font-family:${FONT};font-size:17px;font-weight:700;letter-spacing:-0.02em;color:${C.fg};">${escapeHtml(companyName)}</span>
    <span style="font-family:${FONT};font-size:17px;font-weight:700;letter-spacing:-0.02em;color:${C.brand};">.</span>
  </a>`;
}

/** Footer social row. An icon when the file exists, a text link when it does not. */
function renderSocial(
  attach: EmailAttachment[],
  social: { label: string; url: string; icon: string }[],
): string {
  if (social.length === 0) return '';

  const cells = social
    .map((entry) => {
      const asset = resolveAsset(entry.icon);
      if (asset) {
        if (asset.attachment) attach.push(asset.attachment);
        return `<td style="padding:0 6px;">
          <a href="${escapeHtml(entry.url)}" style="text-decoration:none;">
            <img src="${escapeHtml(asset.src)}" width="24" alt="${escapeHtml(entry.label)}" style="display:block;border:0;outline:none;width:24px;max-width:24px;height:auto;" />
          </a>
        </td>`;
      }
      return `<td style="padding:0 6px;">
        <a href="${escapeHtml(entry.url)}" style="font-family:${FONT};font-size:12px;color:${C.footerFg};text-decoration:underline;">${escapeHtml(entry.label)}</a>
      </td>`;
    })
    .join('');

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 14px;">
    <tr>${cells}</tr>
  </table>`;
}

/**
 * Wraps content in the shared shell. This is the only place that emits
 * <html>, the header, the hero or the footer.
 */
export function renderEmail(content: EmailContent): {
  html: string;
  text: string;
  attachments: EmailAttachment[];
} {
  const year = new Date().getFullYear();
  const brand = emailBranding();
  const attachments: EmailAttachment[] = [];

  const header = renderHeader(attachments, brand.companyName);
  const body = content.blocks.map((block) => renderBlock(block, attachments)).join('\n');
  const social = renderSocial(attachments, brand.social);

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(content.subject)}</title>
<!--[if mso]>
<xml><o:OfficeDocumentSettings>
  <o:AllowPNG/>
  <!-- Without this Outlook assumes 120dpi and renders every pixel value ~25%
       larger, which is what makes an otherwise correct email look bloated. -->
  <o:PixelsPerInch></o:PixelsPerInch>
</o:OfficeDocumentSettings></xml>
<![endif]-->
<style>
  /* Honoured by the clients that support it; everything load-bearing is
     inline, so clients that strip this block still render correctly. */
  html, body { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; margin:0; padding:0; }
  table { border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt; }
  img { -ms-interpolation-mode:bicubic; border:0; height:auto; line-height:100%; outline:none; text-decoration:none; }
  /* Clients that linkify addresses and dates style them blue; force ours. */
  a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
  @media only screen and (max-width:620px) {
    .ch-wrap { width:100% !important; max-width:100% !important; }
    .ch-pad  { padding-left:20px !important; padding-right:20px !important; }
    /* Multi-column rows stack: the footer's label/value pairs and any
       side-by-side cell become full width below 620px. */
    .ch-stack { display:block !important; width:100% !important; text-align:center !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${C.canvas};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">

  <!-- Inbox preview text. Hidden in the body, read by the client's list view.
       Without it, clients show the first visible words, which is the header. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.canvas};">
    ${escapeHtml(content.preheader)}
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${C.canvas};">
    <tr><td align="center" style="padding:32px 12px;">

      <!--[if mso | IE]><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600"><tr><td><![endif]-->
      <table role="presentation" class="ch-wrap" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;">

        <!-- Header -->
        <tr><td class="ch-pad" style="padding:0 8px 18px;">
          ${header}
        </td></tr>

        <!-- Card -->
        <tr><td style="background-color:${C.surface};border:1px solid ${C.edge};border-radius:14px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr><td class="ch-pad" style="padding:28px 32px 24px;">
              <h1 style="margin:0 0 14px;font-family:${FONT};font-size:21px;line-height:1.3;font-weight:700;letter-spacing:-0.02em;color:${C.fg};">${escapeHtml(content.heading)}</h1>
              ${body}
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer. Dark, to close the message off from the card above it. -->
        <tr><td style="padding:18px 0 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${C.footerBg};border-radius:14px;">
            <tr><td class="ch-pad" align="center" style="padding:24px 32px;">
              ${social}
              <p style="margin:0 0 10px;font-family:${FONT};font-size:13px;font-weight:600;color:${C.surface};">${escapeHtml(brand.companyName)}</p>
              <p style="margin:0 0 10px;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.footerFg};">
                ${escapeHtml(brand.companyAddress)}<br />
                <a href="mailto:${escapeHtml(brand.supportEmail)}" style="color:${C.footerFg};text-decoration:underline;">${escapeHtml(brand.supportEmail)}</a>
              </p>
              <div style="height:1px;background-color:${C.footerEdge};margin:14px 0;line-height:1px;font-size:0;">&nbsp;</div>
              <p style="margin:0 0 8px;font-family:${FONT};font-size:11px;line-height:1.6;color:${C.footerFg};">
                You are receiving this because you have a ${escapeHtml(brand.companyName)} account. These are
                service messages about your account, not marketing.
                <a href="${escapeHtml(brand.unsubscribeUrl)}" style="color:${C.footerFg};text-decoration:underline;">Manage notification preferences</a>.
              </p>
              <p style="margin:0;font-family:${FONT};font-size:11px;line-height:1.6;color:${C.footerFg};">
                &copy; ${year} ${escapeHtml(brand.companyName)}
                &nbsp;&middot;&nbsp;
                <a href="${escapeHtml(appUrl('/legal/privacy'))}" style="color:${C.footerFg};text-decoration:underline;">Privacy</a>
                &nbsp;&middot;&nbsp;
                <a href="${escapeHtml(appUrl('/legal/terms'))}" style="color:${C.footerFg};text-decoration:underline;">Terms</a>
              </p>
            </td></tr>
          </table>
        </td></tr>

      </table>
      <!--[if mso | IE]></td></tr></table><![endif]-->

    </td></tr>
  </table>
</body>
</html>`;

  return { html, text: renderText(content), attachments };
}

/**
 * The plain-text alternative.
 *
 * Not optional politeness: a message sent as HTML only scores badly with spam
 * filters, and some clients genuinely display text/plain. Generated from the
 * same blocks so it can never drift out of sync with the HTML version.
 */
function renderText(content: EmailContent): string {
  const brand = emailBranding();
  const lines: string[] = [content.heading, '='.repeat(Math.min(content.heading.length, 60)), ''];

  for (const block of content.blocks) {
    switch (block.kind) {
      case 'paragraph':
        lines.push(block.text, '');
        break;
      case 'facts':
        for (const row of block.rows) lines.push(`  ${row.label}: ${row.value}`);
        lines.push('');
        break;
      case 'callout':
        lines.push(`[${block.title}]`, ...(block.body ? [block.body] : []), '');
        break;
      case 'button':
        lines.push(`${block.label}: ${block.href}`, '');
        break;
      case 'hero':
        // Images carry no information the body does not also state, so the
        // text version simply omits them rather than describing them.
        break;
      case 'divider':
        lines.push('---', '');
        break;
    }
  }

  lines.push(
    '---',
    `${brand.companyName} - ${brand.companyAddress}`,
    `Support: ${brand.supportEmail}`,
    `Notification preferences: ${brand.unsubscribeUrl}`,
  );
  return lines.join('\n');
}
