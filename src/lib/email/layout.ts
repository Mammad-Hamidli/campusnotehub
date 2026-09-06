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
 *    style attribute on the element itself.
 *  - HEX colours, not the CSS variables the app uses. An email is rendered by
 *    someone else's client; var(--accent) resolves to nothing there. The
 *    values below are the LIGHT-mode tokens from globals.css, copied
 *    deliberately, because an email cannot read the design system at runtime.
 *  - A 600px fixed width. The de facto safe width across desktop clients, with
 *    a media query for phones that the clients which support it will honour.
 *
 * The layout is a function rather than a template string constant so that
 * every message is composed from the same header, footer and spacing, and a
 * new template physically cannot forget the unsubscribe context or the
 * branding. This is the "reusable template" the brief asks for; the individual
 * messages in templates.ts supply only their own middle section.
 *
 * SECURITY: every interpolated value passes through escapeHtml(). A student's
 * own display name reaches these templates, and an unescaped name is a stored
 * XSS vector against whatever webmail renders it.
 */

/** Light-mode tokens from globals.css, resolved to literals. See above. */
const C = {
  canvas: '#f8fafc',
  surface: '#ffffff',
  fg: '#0f172a',
  fgMuted: '#475569',
  fgSubtle: '#8b94a3',
  edge: '#e2e8f0',
  accent: '#5458c4',
  accentFg: '#ffffff',
  verified: '#057a55',
  verifiedSoft: '#e8f6f0',
  warn: '#b06a08',
  warnSoft: '#fdf5e6',
  danger: '#be2c2c',
  dangerSoft: '#fdeeee',
} as const;

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

export function appUrl(path = ''): string {
  const base = (process.env.APP_URL ?? 'https://campushub.az').replace(/\/+$/, '');
  if (!path) return base;
  return `${base}/${path.replace(/^\/+/, '')}`;
}

export type EmailBlock =
  | { kind: 'paragraph'; text: string }
  /** Label/value rows, e.g. "Faculty: Computer Science". */
  | { kind: 'facts'; rows: { label: string; value: string }[] }
  | { kind: 'callout'; tone: EmailTone; title: string; body?: string }
  | { kind: 'button'; label: string; href: string }
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

function renderBlock(block: EmailBlock): string {
  switch (block.kind) {
    case 'paragraph':
      return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${C.fgMuted};">${escapeHtml(
        block.text,
      )}</p>`;

    case 'facts':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;border-collapse:collapse;">
        ${block.rows
          .map(
            (row) => `<tr>
              <td style="padding:6px 12px 6px 0;font-size:13px;color:${C.fgSubtle};white-space:nowrap;vertical-align:top;">${escapeHtml(row.label)}</td>
              <td style="padding:6px 0;font-size:14px;color:${C.fg};font-weight:500;vertical-align:top;">${escapeHtml(row.value)}</td>
            </tr>`,
          )
          .join('')}
      </table>`;

    case 'callout': {
      const tone = TONE[block.tone];
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;border-collapse:separate;">
        <tr><td style="background:${tone.bg};border:1px solid ${tone.border};border-radius:10px;padding:14px 16px;">
          <p style="margin:0;font-size:14px;font-weight:600;color:${tone.fg};">${escapeHtml(block.title)}</p>
          ${
            block.body
              ? `<p style="margin:6px 0 0;font-size:14px;line-height:1.55;color:${C.fgMuted};">${escapeHtml(block.body)}</p>`
              : ''
          }
        </td></tr>
      </table>`;
    }

    case 'button':
      // A table-wrapped anchor, because Outlook ignores padding on an inline
      // <a> and would render a bare blue link where the CTA should be.
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;">
        <tr><td style="background:${C.accent};border-radius:8px;">
          <a href="${escapeHtml(block.href)}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:${C.accentFg};text-decoration:none;">${escapeHtml(block.label)}</a>
        </td></tr>
      </table>`;

    case 'divider':
      return `<div style="height:1px;background:${C.edge};margin:0 0 20px;"></div>`;
  }
}

/**
 * Wraps content in the shared shell. This is the only place that emits
 * <html>, the header, or the footer.
 */
export function renderEmail(content: EmailContent): { html: string; text: string } {
  const year = new Date().getFullYear();

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(content.subject)}</title>
<style>
  /* Honoured by the clients that support it; everything load-bearing is
     inline, so clients that strip this block still render correctly. */
  @media only screen and (max-width:620px) {
    .ch-wrap { width:100% !important; }
    .ch-pad  { padding-left:20px !important; padding-right:20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.canvas};-webkit-font-smoothing:antialiased;">

  <!-- Inbox preview text. Hidden in the body, read by the client's list view.
       Without it, clients show the first visible words, which is the header. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">
    ${escapeHtml(content.preheader)}
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.canvas};">
    <tr><td align="center" style="padding:32px 12px;">

      <table role="presentation" class="ch-wrap" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;">

        <!-- Header -->
        <tr><td class="ch-pad" style="padding:0 8px 18px;">
          <a href="${escapeHtml(appUrl())}" style="text-decoration:none;">
            <span style="font-size:17px;font-weight:700;letter-spacing:-0.02em;color:${C.fg};">UniPath</span>
            <span style="font-size:17px;font-weight:700;letter-spacing:-0.02em;color:${C.accent};">.</span>
          </a>
        </td></tr>

        <!-- Card -->
        <tr><td style="background:${C.surface};border:1px solid ${C.edge};border-radius:14px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr><td class="ch-pad" style="padding:28px 32px 24px;">
              <h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;font-weight:700;letter-spacing:-0.02em;color:${C.fg};">${escapeHtml(content.heading)}</h1>
              ${content.blocks.map(renderBlock).join('\n')}
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td class="ch-pad" style="padding:20px 8px 0;">
          <p style="margin:0 0 8px;font-size:12px;line-height:1.55;color:${C.fgSubtle};">
            You are receiving this because you have a UniPath account. Notification
            preferences can be changed in
            <a href="${escapeHtml(appUrl('/settings'))}" style="color:${C.accent};text-decoration:underline;">your settings</a>.
          </p>
          <p style="margin:0;font-size:12px;line-height:1.55;color:${C.fgSubtle};">
            UniPath &middot; Baku, Azerbaijan &middot; &copy; ${year}
            &nbsp;&middot;&nbsp;
            <a href="${escapeHtml(appUrl('/legal/privacy'))}" style="color:${C.fgSubtle};text-decoration:underline;">Privacy</a>
          </p>
        </td></tr>

      </table>

    </td></tr>
  </table>
</body>
</html>`;

  return { html, text: renderText(content) };
}

/**
 * The plain-text alternative.
 *
 * Not optional politeness: a message sent as HTML only scores badly with spam
 * filters, and some clients genuinely display text/plain. Generated from the
 * same blocks so it can never drift out of sync with the HTML version.
 */
function renderText(content: EmailContent): string {
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
      case 'divider':
        lines.push('---', '');
        break;
    }
  }

  lines.push('---', 'UniPath - Baku, Azerbaijan', `Notification settings: ${appUrl('/settings')}`);
  return lines.join('\n');
}
