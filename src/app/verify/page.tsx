import { redirect } from 'next/navigation';
import { VERIFICATION_SETTINGS_HREF } from '@/lib/verification/requirements';

/** Session state is per-request; this route must never be prerendered or cached. */
export const dynamic = 'force-dynamic';

/**
 * /verify - kept as a permanent alias for Settings -> Verification.
 *
 * Verification now lives in the settings page, but emails already in inboxes,
 * in-app notifications and the register API's `next.href` all carry /verify,
 * so the old address keeps working and lands in the right place. The settings
 * page does its own session check (requirePageSession).
 */
export default function VerifyPage() {
  redirect(VERIFICATION_SETTINGS_HREF);
}
