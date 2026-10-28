import { z } from 'zod';

/** Firestore auto-ids, and nothing that could be read as a document path. */
export const ANNOUNCEMENT_ID = /^[A-Za-z0-9]{1,64}$/;

/**
 * Pictures are uploaded through /api/admin/announcements/image and served by
 * /api/media/:id. Only that shape is accepted: the CSP allows `img-src 'self'`
 * and nothing else, and a free-form URL would let any moderator put a third-
 * party tracking pixel on every member's dashboard.
 */
const IMAGE_URL = /^\/api\/media\/[A-Za-z0-9_-]{1,64}$/;

/** A same-site path (no protocol-relative `//host`, no `\` tricks) or https. */
function isSafeActionUrl(url: string): boolean {
  if (url.startsWith('/')) return !url.startsWith('//') && !url.includes('\\');
  return /^https:\/\//i.test(url);
}

export const announcementSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    body: z.string().trim().min(1).max(600),
    imageUrl: z.string().regex(IMAGE_URL).nullable(),
    actionLabel: z.string().trim().max(40).nullable(),
    actionUrl: z.string().trim().max(500).nullable(),
    accent: z.enum(['violet', 'blue', 'amber', 'rose', 'emerald']),
    isActive: z.boolean(),
    startsAt: z.string().datetime().nullable(),
    endsAt: z.string().datetime().nullable(),
  })
  .strict()
  .refine((value) => !value.actionUrl || isSafeActionUrl(value.actionUrl), {
    path: ['actionUrl'],
    message: 'Use a site path or secure https link.',
  })
  .refine((value) => !value.actionLabel || Boolean(value.actionUrl), { path: ['actionUrl'] })
  .refine((value) => !value.startsAt || !value.endsAt || value.endsAt > value.startsAt, {
    path: ['endsAt'],
    message: 'End must be after start.',
  });

/** What members see - no author id, no scheduling internals. */
export function publicAnnouncement(row: Record<string, unknown> & { id: string }) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    imageUrl: row.imageUrl ?? null,
    actionLabel: row.actionLabel ?? null,
    actionUrl: row.actionUrl ?? null,
    accent: row.accent,
  };
}
