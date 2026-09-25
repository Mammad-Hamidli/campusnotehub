import { describe, expect, it } from 'vitest';
import { buildEmail } from './templates';
import { SAMPLE_NAMES, SAMPLE_PARAMS } from './samples';
import { escapeHtml } from './layout';

/**
 * Render tests for every transactional email.
 *
 * These exist because email has no feedback loop: sendEmail() deliberately
 * never throws, so a template that renders a literal "undefined" or drops its
 * call to action fails silently and is discovered by a recipient. Rendering is
 * a pure function of its parameters, so all of it is testable without a mail
 * provider.
 */
describe('email templates', () => {
  it('covers every template with sample data', () => {
    // SAMPLE_PARAMS is typed `satisfies SampleMap`, so a missing template is
    // already a compile error; this asserts the count is what we think it is.
    expect(SAMPLE_NAMES).toHaveLength(34);
  });

  describe.each(SAMPLE_NAMES)('%s', (name) => {
    const rendered = buildEmail(name, SAMPLE_PARAMS[name] as never);

    it('produces a subject, HTML and a plain-text alternative', () => {
      expect(rendered.subject.trim().length).toBeGreaterThan(0);
      expect(rendered.html.length).toBeGreaterThan(0);
      expect(rendered.text.trim().length).toBeGreaterThan(0);
    });

    it('leaves no unreplaced placeholders', () => {
      // The renderer is typed rather than string-templated, so a leftover
      // token would mean someone reintroduced string interpolation.
      for (const output of [rendered.subject, rendered.html, rendered.text]) {
        expect(output).not.toMatch(/\{\{/);
        expect(output).not.toMatch(/\}\}/);
        expect(output).not.toMatch(/\$\{/);
      }
    });

    it('never renders undefined, null or NaN into the body', () => {
      // The classic symptom of a renamed template parameter.
      expect(rendered.html).not.toMatch(/>\s*(undefined|null|NaN)\s*</);
      expect(rendered.text).not.toMatch(/\b(undefined|NaN)\b/);
    });

    it('is a table-based document with the required email scaffolding', () => {
      expect(rendered.html).toContain('XHTML 1.0 Transitional');
      expect(rendered.html).toContain('charset=UTF-8');
      expect(rendered.html).toContain('width=device-width, initial-scale=1');
      // 600px centred container.
      expect(rendered.html).toContain('max-width:600px');
      // Tables, and no modern layout that Outlook would collapse.
      expect(rendered.html).toContain('role="presentation"');
      expect(rendered.html).not.toMatch(/display:\s*flex/);
      expect(rendered.html).not.toMatch(/display:\s*grid/);
      // Outlook fixes and text-size resets.
      expect(rendered.html).toContain('o:PixelsPerInch');
      expect(rendered.html).toContain('-webkit-text-size-adjust');
      expect(rendered.html).toContain('-ms-text-size-adjust');
      // Mobile media query.
      expect(rendered.html).toContain('@media only screen and (max-width:620px)');
      // A web-safe fallback is always present.
      expect(rendered.html).toContain('Arial,Helvetica,sans-serif');
    });

    it('carries a hidden preheader and the branded footer', () => {
      expect(rendered.html).toContain('mso-hide:all');
      expect(rendered.html).toContain('List-Unsubscribe' in {} ? '' : 'Manage notification preferences');
      expect(rendered.html).toContain('campusnotehub');
    });

    it('uses a bulletproof button wherever it has a call to action', () => {
      // Not every template has one (passwordChanged deliberately does not).
      // A button renders as "Label: https://..." in the text version; the
      // footer's "Notification preferences: https://..." line is on EVERY
      // email and is not a call to action, so it is left out of the check.
      const body = rendered.text
        .split('\n')
        .filter((line) => !line.startsWith('Notification preferences:'))
        .join('\n');
      if (!body.match(/: https?:\/\//)) return;
      expect(rendered.html).toContain('v:roundrect');
      expect(rendered.html).not.toMatch(/<button/);
    });

    it('states every link as an absolute URL', () => {
      // A relative href resolves against mail.google.com in webmail.
      const hrefs = [...rendered.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      for (const href of hrefs) {
        expect(href).toMatch(/^(https?:\/\/|mailto:|cid:)/);
      }
    });

    it('has a plain-text part with no HTML tags left in it', () => {
      expect(rendered.text).not.toMatch(/<(table|div|p|a|img|span)\b/i);
    });
  });

  it('escapes user-supplied values instead of letting them inject markup', () => {
    const hostile = '<script>alert(1)</script>';
    const { html } = buildEmail('welcome', {
      nickname: hostile,
      university: 'ADA',
      faculty: 'CS',
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain(escapeHtml(hostile));
  });

  it('preserves Azerbaijani characters end to end', () => {
    const { html, text } = buildEmail('noteApproved', {
      nickname: 'aysel',
      title: 'Riyaziyyat: əyri xətlər, çoxluqlar və üçbucaqlar',
    });

    for (const output of [html, text]) {
      expect(output).toContain('əyri xətlər, çoxluqlar və üçbucaqlar');
    }
  });

  it('renders the hero templates without an image file present', () => {
    /**
     * The images are supplied by hand into public/email/, so at any moment
     * they may be absent. A missing hero must omit the block, not throw and
     * not leave a broken <img>.
     */
    const { html } = buildEmail('welcome', SAMPLE_PARAMS.welcome as never);
    expect(html).toContain('Your account is ready');
    // Either the image resolved, or the block was dropped - never a half-built
    // tag with an empty src.
    expect(html).not.toContain('src=""');
  });
});
