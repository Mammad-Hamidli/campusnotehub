'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The picture inside UserAvatar, replaced by `fallback` (the initials) when it
 * cannot be shown. A media asset that no longer exists (404), a storage outage
 * (500) or a URL the CSP blocks would otherwise leave an empty circle beside
 * the post or comment - indistinguishable from "this person has no picture",
 * except that it looks broken.
 *
 * The failure is remembered per `src`, so a new picture gets a fresh attempt.
 * An image that failed BEFORE hydration fired its error event before React
 * was listening, so the element is also checked once mounted.
 */
export function AvatarImage({ src, size, fallback }: { src: string; size: number; fallback: ReactNode }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const img = ref.current;
    // `complete` with no pixels = finished and broken. A lazy image that has
    // not started loading is not `complete`, so it is never misjudged here.
    if (img?.complete && img.naturalWidth === 0) setFailedSrc(src);
  }, [src]);

  if (failedSrc === src) return <>{fallback}</>;

  return (
    // Plain <img>: same-origin /api/media URLs, already re-encoded to a small
    // square WebP, and immutable-cached by that route.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailedSrc(src)}
      className="h-full w-full object-cover"
    />
  );
}
