/**
 * Remembers that the IN_REVIEW verification notice was closed. Its value is
 * the account id, so closing it on a shared computer does not hide it for the
 * next account. Read on the server by IdentityPromptSlot, so a dismissed
 * banner never flashes before hydration.
 *
 * Its own module, not an export of IdentityPrompt: a value imported from a
 * 'use client' file is a client reference inside a Server Component.
 */
export const REVIEW_DISMISS_COOKIE = 'CH_REVIEW_NOTICE';
export const REVIEW_DISMISS_MAX_AGE_S = 30 * 24 * 60 * 60;
