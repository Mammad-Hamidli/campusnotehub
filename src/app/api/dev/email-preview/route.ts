import { NextResponse, type NextRequest } from 'next/server';
import { buildEmail, type TemplateName } from '@/lib/email/templates';
import { SAMPLE_NAMES, SAMPLE_PARAMS } from '@/lib/email/samples';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/dev/email-preview - render an email in the browser without sending.
 *
 *   /api/dev/email-preview                    -> an index of all templates
 *   /api/dev/email-preview?template=welcome   -> that template's HTML
 *   /api/dev/email-preview?template=welcome&format=text -> the text/plain part
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Email is the one surface with no feedback loop: every send is deliberately
 * swallowed (sendEmail never throws), delivery takes seconds, and checking a
 * layout change previously meant mailing yourself and waiting. A broken
 * template therefore reached real recipients before anyone saw it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS DEV-ONLY, AND WHY THAT IS THE FIRST THING IT CHECKS
 * ---------------------------------------------------------------------------
 * These renders contain no real user data - the sample values come from
 * samples.ts - but the route is still refused in production. An endpoint that
 * renders arbitrary templates from a query parameter is an open redirect and
 * content-injection surface waiting to be found, and it has no business being
 * reachable on a deployment. `next build` inlines NODE_ENV as the literal
 * 'production', so this branch is dead code the minifier strips: the route
 * cannot be enabled on a production deploy even by setting an env var.
 */
export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
  }

  const requested = request.nextUrl.searchParams.get('template');
  const format = request.nextUrl.searchParams.get('format');

  // No template named: render a clickable index rather than an error, so the
  // route is discoverable by visiting it.
  if (!requested) {
    const links = SAMPLE_NAMES.map(
      (name) =>
        `<li style="margin:0 0 6px;"><a href="?template=${encodeURIComponent(name)}">${name}</a>` +
        ` <a href="?template=${encodeURIComponent(name)}&amp;format=text" style="color:#888;font-size:12px;">(text)</a></li>`,
    ).join('');

    return new NextResponse(
      `<!doctype html><meta charset="utf-8"><title>Email previews</title>` +
        `<body style="font:14px system-ui,sans-serif;padding:24px;">` +
        `<h1 style="font-size:18px;">Email previews (${SAMPLE_NAMES.length})</h1>` +
        `<p style="color:#555;">Sample data comes from <code>src/lib/email/samples.ts</code>.</p>` +
        `<ul style="padding-left:18px;">${links}</ul></body>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } },
    );
  }

  /**
   * Validated against the known set before use. `requested` is attacker-
   * controlled in principle, and indexing TEMPLATES with an unchecked string
   * is how a preview route becomes a prototype-pollution or reflected-content
   * bug.
   */
  if (!SAMPLE_NAMES.includes(requested as TemplateName)) {
    return NextResponse.json(
      { error: 'errors.validationFailed', known: SAMPLE_NAMES },
      { status: 400 },
    );
  }
  const name = requested as TemplateName;

  const { subject, html, text } = buildEmail(name, SAMPLE_PARAMS[name] as never);

  if (format === 'text') {
    return new NextResponse(`Subject: ${subject}\n\n${text}`, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex' },
    });
  }

  /**
   * The HTML is returned as-is, exactly as the mail client will receive it.
   *
   * In CID mode the <img> tags point at cid: URLs, which a browser cannot
   * resolve - so images appear broken here while rendering correctly in a real
   * client. Set EMAIL_ASSET_MODE=url to preview them.
   */
  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex',
      'Cache-Control': 'no-store',
    },
  });
}
