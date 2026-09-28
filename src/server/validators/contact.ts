import { z } from 'zod';

/**
 * The /contact form. Shared by the route and the form itself, so the browser
 * shows exactly the field errors the server would return, under the same
 * message keys.
 *
 * Length caps bound what one anonymous request can put into the team's inbox;
 * the rate limit in the route bounds how often. Values are NOT escaped here -
 * escaping belongs to the output (the email layout escapes every value), and
 * escaping twice would show a person's "&" as "&amp;".
 */

export const CONTACT_LIMITS = { name: 100, email: 254, subject: 150, message: 5000 } as const;
export const CONTACT_MESSAGE_MIN = 10;

/** Control characters out, whitespace runs collapsed: a header-safe single line. */
const singleLine = (max: number) =>
  z
    .string()
    .transform((v) => v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, 'errors.fieldRequired').max(max, 'contact.form.errors.tooLong'));

/** Line breaks kept (normalised to \n); every other control character dropped. */
const multiLine = (min: number, max: number) =>
  z
    .string()
    .transform((v) =>
      v
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
        .trim(),
    )
    .pipe(
      z
        .string()
        .min(1, 'errors.fieldRequired')
        .min(min, 'contact.form.errors.tooShort')
        .max(max, 'contact.form.errors.tooLong'),
    );

export const contactSchema = z
  .object({
    name: singleLine(CONTACT_LIMITS.name),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .min(1, 'errors.fieldRequired')
      .email('auth.errors.emailInvalid')
      .max(CONTACT_LIMITS.email, 'auth.errors.emailInvalid'),
    subject: singleLine(CONTACT_LIMITS.subject),
    message: multiLine(CONTACT_MESSAGE_MIN, CONTACT_LIMITS.message),
    /** The reader's UI language, so the team knows which language to answer in. */
    locale: z.enum(['az', 'en', 'ru']).optional(),
    /** Honeypot. Always empty from a person; the route checks it before this schema. */
    website: z.string().max(500).optional(),
  })
  .strict();

export type ContactInput = z.infer<typeof contactSchema>;

/** A filled honeypot means a bot. Checked on the raw body, before validation. */
export function isHoneypotFilled(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const value = (body as { website?: unknown }).website;
  return typeof value === 'string' && value.trim().length > 0;
}
