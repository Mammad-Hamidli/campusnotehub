import { describe, expect, it } from 'vitest';
import { CONTACT_LIMITS, contactSchema, isHoneypotFilled } from './contact';
import { buildEmail } from '@/lib/email/templates';

const valid = {
  name: 'Aysel Məmmədova',
  email: 'Aysel@Example.com',
  subject: 'Qeydlər',
  message: 'Salam! Fayl yükləyə bilmirəm.',
};

const fieldErrors = (input: unknown) => {
  const parsed = contactSchema.safeParse(input);
  return parsed.success ? {} : parsed.error.flatten().fieldErrors;
};

describe('contactSchema', () => {
  it('accepts a normal message, trimmed, with the email lowercased', () => {
    const parsed = contactSchema.parse({ ...valid, name: '  Aysel Məmmədova ', locale: 'az' });
    expect(parsed).toMatchObject({ name: 'Aysel Məmmədova', email: 'aysel@example.com', locale: 'az' });
  });

  it('requires every field', () => {
    const errors = fieldErrors({ name: ' ', email: '', subject: '', message: '' });
    expect(errors.name?.[0]).toBe('errors.fieldRequired');
    expect(errors.email?.[0]).toBe('errors.fieldRequired');
    expect(errors.subject?.[0]).toBe('errors.fieldRequired');
    expect(errors.message?.[0]).toBe('errors.fieldRequired');
  });

  it('refuses a malformed email address', () => {
    for (const email of ['aysel', 'aysel@', '@example.com', 'a b@example.com', 'a@example.com\r\nBcc: x@evil.example']) {
      expect(fieldErrors({ ...valid, email }).email?.[0], email).toBe('auth.errors.emailInvalid');
    }
  });

  it('caps every length', () => {
    const errors = fieldErrors({
      name: 'a'.repeat(CONTACT_LIMITS.name + 1),
      email: `${'a'.repeat(250)}@example.com`,
      subject: 's'.repeat(CONTACT_LIMITS.subject + 1),
      message: 'm'.repeat(CONTACT_LIMITS.message + 1),
    });
    expect(errors.name).toContain('contact.form.errors.tooLong');
    expect(errors.email).toContain('auth.errors.emailInvalid');
    expect(errors.subject).toContain('contact.form.errors.tooLong');
    expect(errors.message).toContain('contact.form.errors.tooLong');
  });

  it('asks for more than a few characters of message', () => {
    expect(fieldErrors({ ...valid, message: 'hi' }).message?.[0]).toBe('contact.form.errors.tooShort');
  });

  it('flattens the single-line fields, so nothing can break out of a header', () => {
    const parsed = contactSchema.parse({ ...valid, subject: 'Help\r\nBcc: victim@example.com', name: 'A\u0000ysel\tM' });
    expect(parsed.subject).toBe('Help Bcc: victim@example.com');
    expect(parsed.name).toBe('A ysel M');
  });

  it('keeps the message line breaks (normalised) and drops other control characters', () => {
    const parsed = contactSchema.parse({ ...valid, message: 'Line one\r\nLine two\u0007\n\nEnd' });
    expect(parsed.message).toBe('Line one\nLine two\n\nEnd');
  });

  it('refuses unknown fields', () => {
    expect(contactSchema.safeParse({ ...valid, to: 'someone@example.com' }).success).toBe(false);
  });
});

describe('isHoneypotFilled', () => {
  it('is true only for a non-empty website field', () => {
    expect(isHoneypotFilled({ ...valid, website: 'https://spam.example' })).toBe(true);
    expect(isHoneypotFilled({ ...valid, website: '' })).toBe(false);
    expect(isHoneypotFilled({ ...valid, website: '   ' })).toBe(false);
    expect(isHoneypotFilled(valid)).toBe(false);
    expect(isHoneypotFilled(null)).toBe(false);
    expect(isHoneypotFilled('website=x')).toBe(false);
  });
});

describe('contactMessage email', () => {
  const hostile = {
    name: '<script>alert(1)</script>',
    email: 'aysel@example.com',
    subject: 'Hi <b>there</b>\nBcc: x@evil.example',
    message: 'First line\n<img src=x onerror=alert(1)>\n"quoted" & \'single\'',
    locale: 'en',
  };

  it('escapes every visitor-supplied value in the HTML', () => {
    const { html } = buildEmail('contactMessage', hostile);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>there</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;quoted&quot; &amp; &#39;single&#39;');
  });

  it('keeps the message line breaks as <br /> after escaping', () => {
    const { html } = buildEmail('contactMessage', hostile);
    expect(html).toContain('First line<br />&lt;img');
  });

  it('puts a single-line subject on the message', () => {
    const { subject } = buildEmail('contactMessage', hostile);
    expect(subject).toBe('Contact form: Hi <b>there</b> Bcc: x@evil.example');
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it('has a plain-text part that quotes the message line by line', () => {
    const { text } = buildEmail('contactMessage', hostile);
    expect(text).toContain('> First line\n> <img src=x onerror=alert(1)>');
    expect(text).toContain('Email: aysel@example.com');
  });
});
