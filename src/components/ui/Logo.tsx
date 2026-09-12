import Link from 'next/link';

/**
 * Wordmark + mark.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE REAL MARK NOW, NOT AN APPROXIMATION OF IT
 * ---------------------------------------------------------------------------
 * The previous version drew its own two-path mortarboard inside a filled
 * rounded square, because there was no artwork to use. There is now
 * (logos/), and a hand-drawn stand-in next to the real logo on the login
 * screen and in the email templates is the kind of inconsistency people
 * notice without being able to name.
 *
 * It stays INLINE rather than becoming an <img> for the same reason as before:
 * it paints on the first frame with no extra request, and inline paths can
 * take theme colours. That second part is what an <img> could not do - see
 * below.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MORTARBOARD IS currentColor AND THE ARC IS NOT
 * ---------------------------------------------------------------------------
 * The source artwork draws the cap in the brand navy (#173F6E). On the dark
 * canvas that is very nearly the background colour, so shipping the file as-is
 * would make the logo disappear in dark mode - which is exactly why the brand
 * set also contains a "reversed" variant.
 *
 * Rather than branching on the theme and loading one of two files, the cap is
 * drawn in `currentColor` and inherits `text-fg`: navy-black on light, near
 * white on dark. That is the reversed lockup, produced by the token system
 * instead of by a second asset that could fall out of sync.
 *
 * The arc keeps the literal brand orange in both themes. It is the one element
 * that carries the brand's colour, it clears contrast on both canvases, and
 * pinning it means the logo never renders as a monochrome silhouette.
 */
export function Logo({ href = '/', showWord = true }: { href?: string; showWord?: boolean }) {
  return (
    <Link href={href} className="group flex items-center gap-2 rounded-lg" aria-label="CampusHub">
      <svg
        viewBox="0 0 159 194"
        className="h-7 w-7 shrink-0 text-fg transition-transform duration-200 ease-out
 group-hover:scale-[1.06]"
        role="img"
        aria-hidden="true"
      >
        <g transform="translate(-20.5 -6)">
          <path d="M42 120 A58 58 0 0 0 158 120" fill="none" stroke="rgb(var(--brand))" strokeWidth="15" />
          <circle cx="100" cy="120" r="32" fill="currentColor" />
          <path d="M70 47 Q100 58 130 47 L127 74 Q100 84.5 73 74 Z" fill="currentColor" />
          <path d="M100 20 L164 42 L100 64 L36 42 Z" fill="currentColor" />
          <path d="M45 43 L45 77" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" fill="none" />
          <circle cx="45" cy="79.5" r="3.9" fill="currentColor" />
          <path d="M40.2 83 L49.8 83 L51.3 95 Q45 100 38.7 95 Z" fill="currentColor" />
        </g>
      </svg>

      {showWord && (
        <span className="text-md font-semibold tracking-tight text-fg">CampusHub</span>
      )}
    </Link>
  );
}
