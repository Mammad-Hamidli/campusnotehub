import { VerificationStatus } from '@/lib/enums';
import { getViewer } from '@/lib/auth/session';
import { IdentityPrompt, type PromptState } from './IdentityPrompt';

/**
 * Account verification status -> banner state. VERIFIED maps to nothing,
 * which is the ONLY way the banner goes away. BANNED renders nothing either:
 * that is not a conversation a banner should be having.
 */
const PROMPT_STATE: Partial<Record<VerificationStatus, PromptState>> = {
  [VerificationStatus.UNVERIFIED]: 'UNVERIFIED',
  [VerificationStatus.REJECTED]: 'REJECTED',
  [VerificationStatus.PROCESSING]: 'IN_REVIEW',
  [VerificationStatus.NEEDS_REVIEW]: 'IN_REVIEW',
};

/**
 * Decides, on the server, whether the verification banner is shown at all.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DECISION IS MADE HERE AND NOT IN THE CLIENT COMPONENT
 * ---------------------------------------------------------------------------
 * The alternative is a client component in the root layout that fetches
 * /api/me on every page load: one extra round trip per navigation, and a
 * banner that paints a beat AFTER the page and shoves the content down under
 * the user's thumb - the worst possible layout shift, at the top.
 *
 * Reading the session here costs nothing extra. requireSession()'s cookie
 * path is memoised per request (see the cache() in src/lib/auth/session.ts),
 * so this shares the SAME lookup the page's own requirePageSession() makes. A
 * signed-out visitor costs zero reads: with no access-token cookie,
 * requireSession throws before it touches Firestore.
 */
export async function IdentityPromptSlot() {
  const viewer = await getViewer();
  if (!viewer) return null;

  const state = PROMPT_STATE[viewer.verificationStatus];
  return state ? <IdentityPrompt state={state} /> : null;
}
