/**
 * A mortarboard that tosses itself every few seconds, on a warm brand glow.
 *
 * Decoration only: aria-hidden, no JS, no hooks, so it renders identically on
 * the server and in either kind of component. All motion and colour live in
 * globals.css (`.gradcap`): the cap is drawn in `currentColor`, so the caller
 * sets its tone with a text-* utility, and the tassel and glow take the brand
 * orange from the tokens, so light and dark need no overrides.
 *
 * Size it by WIDTH; the box keeps the viewBox's 5:3 ratio. The toss rises
 * above that box (the SVG overflows rather than reserving headroom), so it
 * never changes layout - give it room above instead.
 *
 * The viewBox starts at 0,0 on purpose: `transform-box: view-box` origins are
 * resolved against it, and browsers have disagreed about viewBoxes with a
 * non-zero origin.
 */
export function GradCap({ className = '' }: { className?: string }) {
  return (
    <span className={`gradcap ${className}`} aria-hidden="true">
      <svg viewBox="0 0 200 120" focusable="false">
        <g className="cap">
          <path className="gradcap-band" d="M79 60 L121 60 L117 80 Q100 86 83 80 Z" />
          <path d="M100 26 L166 54 L100 84 L34 54 Z" />
          <g className="tassel">
            {/* Cord from the button, across the board to its front edge, then down. */}
            <path className="gradcap-cord" d="M100 53 L142 65 L142 88" />
            <circle className="gradcap-accent" cx="142" cy="88" r="3.2" />
            <path className="gradcap-accent" d="M139 89.5 L145 89.5 L148.5 105 Q142 108.5 135.5 105 Z" />
            <circle className="gradcap-accent" cx="100" cy="53" r="4.5" />
          </g>
        </g>
      </svg>
    </span>
  );
}
