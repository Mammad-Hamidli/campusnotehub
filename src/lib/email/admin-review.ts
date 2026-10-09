import { appUrl } from './layout';
import { sendEmailAsync } from './send';
import { verificationAlertInbox } from './identity';

const QUEUES = {
  verification: { label: 'Verification request', path: '/admin/verifications' },
  mentor: { label: 'Mentor application', path: '/admin' },
  note: { label: 'Note approval', path: '/admin/reviews' },
  report: { label: 'Content report', path: '/admin/moderation' },
  accountDeletion: { label: 'Account deletion request', path: '/admin' },
} as const;

/** Send one deduplicated alert after a reviewable entity has committed. */
export function notifyAdminReviewQueue(kind: keyof typeof QUEUES, entityId: string): void {
  const queue = QUEUES[kind];
  sendEmailAsync(verificationAlertInbox(), 'adminReviewQueue', {
    item: queue.label,
    url: appUrl(queue.path),
  }, { dedupeKey: `admin-review:${kind}:${entityId}` });
}
