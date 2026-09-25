import {
  BookOpen,
  GraduationCap,
  NotebookPen,
  PenTool,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

/**
 * Decorative wash behind every page.
 *
 * Fixed, full-viewport and `z-index: -1`, so it sits under all content
 * without taking part in layout, and `aria-hidden` because it carries no
 * information. Colours and opacity live in globals.css (`.warm-backdrop`) so
 * the dark theme can tone them down. Server component: it ships no JS.
 *
 * Above the blobs sits a watermark layer: the campusnotehub mark plus a few
 * study-themed glyphs and abstract shapes, scattered at a few percent opacity
 * so a sparse page never reads as a blank sheet. The `sm-only` entries are
 * dropped on phones, where the same scatter would crowd a narrow column.
 *
 * Both layers are deliberately restricted to `brand` and `accent`. The glyphs
 * used to take one tone each from all five accents - including `verified`
 * green and `warn` amber - which meant every screen carried faint status
 * colours that belonged to nothing, and a real warning had to compete with
 * wallpaper painted in its own hue.
 */

type Glyph = { icon: LucideIcon; className: string };

const GLYPHS: Glyph[] = [
  { icon: BookOpen, className: 'left-[6%] top-[22%] h-16 w-16 -rotate-12 text-accent' },
  { icon: NotebookPen, className: 'right-[8%] top-[38%] h-20 w-20 rotate-6 text-brand' },
  { icon: GraduationCap, className: 'left-[12%] bottom-[14%] h-14 w-14 rotate-[18deg] text-accent sm-only' },
  { icon: PenTool, className: 'left-[40%] bottom-[6%] h-12 w-12 rotate-45 text-accent sm-only' },
  { icon: UsersRound, className: 'right-[4%] bottom-[30%] h-12 w-12 -rotate-[10deg] text-brand sm-only' },
];

export function WarmBackdrop() {
  return (
    <div className="warm-backdrop" aria-hidden="true">
      <span className="warm-blob warm-blob-brand" />
      <span className="warm-blob warm-blob-accent" />

      <div className="watermarks">
        {/* The brand cap-and-ring mark (public/brand/campus-hub-icon.svg),
            inlined as paths so it can take currentColor and costs no request. */}
        <svg
          viewBox="0 0 159 194"
          className="watermark -bottom-10 -right-10 h-72 w-60 -rotate-12 text-brand sm:h-96 sm:w-80"
          fill="currentColor"
        >
          <g transform="translate(-20.5 -6)">
            <path d="M42 120 A58 58 0 0 0 158 120" fill="none" stroke="currentColor" strokeWidth="15" />
            <circle cx="100" cy="120" r="32" />
            <path d="M70 47 Q100 58 130 47 L127 74 Q100 84.5 73 74 Z" />
            <path d="M100 20 L164 42 L100 64 L36 42 Z" />
          </g>
        </svg>

        {/* Abstract shapes: an outlined ring and a dot grid. */}
        <span className="watermark watermark-ring -left-24 top-[55%] h-64 w-64 text-accent" />
        <span className="watermark watermark-dots right-[18%] top-[4%] h-32 w-40 text-fg sm-only" />

        {GLYPHS.map(({ icon: Icon, className }, i) => (
          <Icon key={i} className={`watermark ${className}`} strokeWidth={1.25} />
        ))}
      </div>
    </div>
  );
}
