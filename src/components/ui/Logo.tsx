import Link from 'next/link';

/**
 * Wordmark + mark.
 *
 * No `tone` prop any more. Colour comes from the theme tokens, so the mark is
 * correct on a light canvas and a dark one without the caller having to know
 * which it is - which is the whole point of moving to semantic tokens.
 *
 * The mark is inline SVG rather than an image so it paints on the first frame
 * with no extra request and inherits currentColor.
 */
export function Logo({ href = '/', showWord = true }: { href?: string; showWord?: boolean }) {
  return (
    <Link href={href} className="group flex items-center gap-2 rounded-lg" aria-label="CampusHub">
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-fg
 text-canvas transition-transform duration-200 ease-out group-hover:scale-[1.06]"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* Mortarboard, drawn rather than imported. */}
          <path d="M2 8.5 12 4l10 4.5-10 4.5L2 8.5Z" />
          <path d="M6 10.6V15c0 1.7 2.7 3 6 3s6-1.3 6-3v-4.4" />
        </svg>
      </span>

      {showWord && (
        <span className="text-md font-semibold tracking-tight text-fg">CampusHub</span>
      )}
    </Link>
  );
}
