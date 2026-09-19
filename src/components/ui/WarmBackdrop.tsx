/**
 * Decorative warm-colour wash behind every page.
 *
 * Fixed, full-viewport and `z-index: -1`, so it sits under all content
 * without taking part in layout, and `aria-hidden` because it carries no
 * information. Colours and opacity live in globals.css (`.warm-backdrop`) so
 * the dark theme can tone them down. Server component: it ships no JS.
 */
export function WarmBackdrop() {
  return (
    <div className="warm-backdrop" aria-hidden="true">
      <span className="warm-blob warm-blob-orange" />
      <span className="warm-blob warm-blob-yellow" />
      <span className="warm-blob warm-blob-green" />
      <span className="warm-blob warm-blob-red" />
    </div>
  );
}
