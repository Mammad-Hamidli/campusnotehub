import { BadgeCheck } from 'lucide-react';

const SIZES = {
  sm: { box: 'h-8 w-8', text: 'text-2xs', badge: 'h-3 w-3', px: 32 },
  md: { box: 'h-10 w-10', text: 'text-xs', badge: 'h-3.5 w-3.5', px: 40 },
  lg: { box: 'h-16 w-16', text: 'text-lg', badge: 'h-5 w-5', px: 64 },
  xl: { box: 'h-24 w-24', text: 'text-2xl', badge: 'h-6 w-6', px: 96 },
} as const;

export type AvatarSize = keyof typeof SIZES;

/** Initials from the public handle only - never the legal name. */
export function initialsOf(nickname: string): string {
  return nickname.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '??';
}

/**
 * A profile picture with its verification state drawn AROUND it.
 *
 * Verified accounts get a colourful ring (a slowly turning conic gradient -
 * only the ring layer rotates, never the photo) plus a green check badge;
 * everyone else gets a plain hairline. The ring is decoration, the badge and
 * its label carry the meaning, so the state is not colour-only.
 *
 * Server- and client-safe (no hooks), so feed rows, comments and the
 * server-rendered profile page all share it.
 */
export function UserAvatar({
  nickname,
  src,
  verified,
  size = 'md',
  verifiedLabel = 'Verified',
  className = '',
}: {
  nickname: string;
  src?: string | null;
  verified: boolean;
  size?: AvatarSize;
  /** Localised accessible name for the badge. */
  verifiedLabel?: string;
  className?: string;
}) {
  const s = SIZES[size];

  return (
    <span className={`relative inline-flex shrink-0 ${s.box} ${className}`}>
      {verified ? (
        <span className="absolute inset-0 overflow-hidden rounded-full" aria-hidden="true">
          <span className="avatar-ring absolute inset-[-50%] animate-spin-slow" />
        </span>
      ) : (
        <span className="absolute inset-0 rounded-full border border-edge" aria-hidden="true" />
      )}

      <span
        className={`relative m-auto flex items-center justify-center overflow-hidden rounded-full bg-surface-inset
                    font-bold text-accent ${s.text} ${verified ? 'h-[calc(100%-6px)] w-[calc(100%-6px)] ring-2 ring-surface' : 'h-full w-full'}`}
      >
        {src ? (
          // Plain <img>: same-origin /api/media URLs, already re-encoded to a
          // small square WebP, and immutable-cached by that route.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt=""
            width={s.px}
            height={s.px}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        ) : (
          <span aria-hidden="true">{initialsOf(nickname)}</span>
        )}
      </span>

      {verified && (
        <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-surface p-px">
          <BadgeCheck className={`${s.badge} text-verified`} aria-label={verifiedLabel} role="img" />
        </span>
      )}
    </span>
  );
}
