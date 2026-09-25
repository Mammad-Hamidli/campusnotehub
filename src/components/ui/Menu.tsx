'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';

/**
 * Shared dropdown primitive.
 *
 * Both the language and theme switchers, the user menu, the visibility picker
 * and the post overflow menu use this. Writing the outside-click / Escape /
 * focus-return logic once is not just DRY - it is the difference between menus
 * that behave consistently and menus that each have their own subtly different
 * keyboard bugs, which is a very recognisable symptom of generated UI.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PANEL IS IN A PORTAL AND POSITIONED IN JAVASCRIPT
 * ---------------------------------------------------------------------------
 * It used to be `absolute mt-1.5` inside the trigger's own wrapper, which has
 * two consequences that only show up in specific places - and the account menu
 * is in the worst of them.
 *
 *   1. IT ALWAYS OPENED DOWNWARD. The account button is the LAST element of a
 *      full-height sidebar, so "below the button" is below the viewport. The
 *      menu rendered off-screen and looked like a dead button.
 *
 *   2. AN ABSOLUTELY POSITIONED CHILD IS STILL CLIPPED by any ancestor with
 *      `overflow: hidden` or `overflow-x: auto`, and it is trapped inside any
 *      ancestor that creates a stacking context (a `transform`, a `filter`, an
 *      `opacity` < 1 - all of which this codebase uses for animations). Once
 *      trapped, no z-index can lift it above a later sibling: z-index only
 *      orders elements within the same stacking context. That is why bumping
 *      z-50 higher never fixed it.
 *
 * Rendering into document.body escapes both problems by construction - there
 * is no ancestor left to clip against or be trapped by. The cost is that the
 * panel no longer inherits the trigger's position, so it has to be measured
 * and placed, which is what layoutPanel() below does:
 *
 *   - `position: fixed`, in viewport coordinates, so it matches what
 *     getBoundingClientRect() returns without any scroll arithmetic;
 *   - it prefers to open UPWARD when the trigger sits in the lower half of the
 *     screen, which is what makes the bottom-left account button behave like a
 *     normal account dropdown;
 *   - it flips to the other side if the preferred side does not fit, and
 *     clamps to the viewport if neither does, so the panel is always fully
 *     visible on any screen size;
 *   - it re-measures on scroll and resize, because a fixed element does not
 *     follow the trigger on its own.
 */
export function Menu({
  trigger,
  children,
  align = 'end',
  label,
  width = 'w-56',
  placement = 'auto',
}: {
  /** Render prop for the button. Receives open state and a toggle. */
  trigger: (props: { open: boolean; toggle: () => void; id: string }) => ReactNode;
  /** Render prop for the panel body. Receives a `close` callback. */
  children: (props: { close: () => void }) => ReactNode;
  align?: 'start' | 'end';
  label: string;
  width?: string;
  /**
   * 'auto' picks a side from where the trigger sits and from the space
   * available. 'top' and 'bottom' state a preference, which is still overruled
   * when the preferred side genuinely does not fit - a menu that honours a
   * prop by rendering off-screen has honoured nothing.
   */
  placement?: 'auto' | 'top' | 'bottom';
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const [style, setStyle] = useState<React.CSSProperties>({
    // Off-screen until measured. Without this the panel paints once at 0,0 and
    // visibly jumps into place on open.
    position: 'fixed',
    top: -9999,
    left: -9999,
  });

  // Portals need a DOM to target, which does not exist during SSR.
  useEffect(() => setMounted(true), []);

  const close = useCallback(() => {
    setOpen(false);
    // Return focus to the trigger button rather than losing it to <body>.
    // Especially important with a portal: the panel is no longer a DOM sibling
    // of the trigger, so the browser's own focus order cannot recover it.
    containerRef.current?.querySelector<HTMLElement>('[data-menu-trigger]')?.focus();
  }, []);

  /** Measures the trigger and the panel, then places the panel. */
  const layoutPanel = useCallback(() => {
    const triggerEl = containerRef.current?.querySelector<HTMLElement>('[data-menu-trigger]');
    const panel = panelRef.current;
    if (!triggerEl || !panel) return;

    const anchor = triggerEl.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const margin = 6;
    const edge = 8; // keep clear of the viewport border

    const spaceBelow = window.innerHeight - anchor.bottom;
    const spaceAbove = anchor.top;

    // Prefer upward when the trigger is in the lower half of the screen. This
    // is the rule that makes the bottom-of-sidebar account menu open upward
    // without every other menu in the app changing behaviour.
    const wantsTop =
      placement === 'top' ||
      (placement === 'auto' && anchor.top > window.innerHeight / 2);

    // A preference is only honoured if it fits; otherwise take the side that
    // does, and if neither does, take the roomier one and let the clamp below
    // handle the overflow.
    const fitsTop = spaceAbove >= panelRect.height + margin + edge;
    const fitsBottom = spaceBelow >= panelRect.height + margin + edge;

    let onTop: boolean;
    if (wantsTop) onTop = fitsTop || !fitsBottom;
    else onTop = !fitsBottom && fitsTop;

    let top = onTop ? anchor.top - panelRect.height - margin : anchor.bottom + margin;

    // Horizontal: align the panel's start or end with the trigger's.
    let left = align === 'end' ? anchor.right - panelRect.width : anchor.left;

    // Clamp into the viewport. This is what keeps a menu usable on a narrow
    // phone, where a 224px panel anchored to a right-aligned button would
    // otherwise hang off the left edge.
    left = Math.min(Math.max(edge, left), Math.max(edge, window.innerWidth - panelRect.width - edge));
    top = Math.min(Math.max(edge, top), Math.max(edge, window.innerHeight - panelRect.height - edge));

    setStyle({
      position: 'fixed',
      top: Math.round(top),
      left: Math.round(left),
      // Matches the trigger so a wide trigger does not get a narrow menu. The
      // Tailwind width class still sets the actual width; this is the floor.
      minWidth: Math.round(anchor.width),
      zIndex: 100,
    });
  }, [align, placement]);

  /**
   * Measured in a layout effect, before paint, so the panel never appears at
   * the wrong place for a frame. useEffect would run after the browser has
   * already painted the un-positioned panel.
   */
  useLayoutEffect(() => {
    if (!open) return;
    layoutPanel();
  }, [open, layoutPanel]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // The panel is no longer inside containerRef now that it is portalled,
      // so BOTH have to be consulted - checking only the container would close
      // the menu on every click inside it.
      if (containerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

      const items = panelRef.current?.querySelectorAll<HTMLElement>('[data-menu-item]');
      if (!items?.length) return;
      event.preventDefault();

      const list = Array.from(items);
      const current = list.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === 'ArrowDown'
          ? (current + 1) % list.length
          : (current - 1 + list.length) % list.length;
      list[next].focus();
    };

    // A fixed panel does not travel with the page, so it is repositioned on
    // scroll rather than left floating over unrelated content. Capture phase,
    // because the scroll may happen in any ancestor, not just the window.
    const onReflow = () => layoutPanel();

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open, close, layoutPanel]);

  const panel = (
    <div
      ref={panelRef}
      id={id}
      role="menu"
      aria-label={label}
      style={style}
      className={`overlay animate-scale-in p-1 ${width}`}
    >
      {children({ close })}
    </div>
  );

  return (
    <div ref={containerRef} className="relative">
      {trigger({ open, toggle: () => setOpen((v) => !v), id })}
      {open && mounted && createPortal(panel, document.body)}
    </div>
  );
}

/**
 * A single row inside a Menu.
 *
 * Pass `href` for a navigation row and `onSelect` for an action row.
 *
 * The href variant exists because the call sites were writing
 * `<MenuItem><Link/></MenuItem>`, which nests an <a> inside a <button>. That is
 * invalid HTML, and browsers recover from it inconsistently: the row is
 * announced as a button by screen readers while behaving as a link, keyboard
 * activation fires both handlers, and middle-click / cmd-click ("open in new
 * tab") lands on the button and does nothing. Rendering ONE element with the
 * right semantics fixes all of that at once.
 */
export function MenuItem({
  onSelect,
  href,
  reloadDocument = false,
  selected = false,
  icon,
  children,
  trailing,
  tone = 'default',
}: {
  onSelect?: () => void;
  /** Renders the row as a link. Mutually exclusive with a bare onSelect. */
  href?: string;
  /**
   * With `href`: a full page load instead of a client-side transition. Sign
   * out needs it - see the comment where it is rendered.
   */
  reloadDocument?: boolean;
  selected?: boolean;
  icon?: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  /** `danger` marks a destructive row (sign out, delete). */
  tone?: 'default' | 'danger';
}) {
  const className = `flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm
                  transition-colors duration-100
                  hover:bg-surface-muted focus-visible:bg-surface-muted
                  ${
                    tone === 'danger'
                      ? 'text-danger hover:bg-danger-soft'
                      : selected
                        ? 'font-medium text-fg'
                        : 'text-fg-muted'
                  }`;

  const inner = (
    <>
      {icon && (
        <span className={`shrink-0 ${tone === 'danger' ? 'text-danger' : 'text-fg-subtle'}`}>
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </>
  );

  if (href && reloadDocument) {
    /**
     * A plain <a>, so the browser loads a new document.
     *
     * Through <Link>, /logout ran as a client-side transition: the router
     * fetched it, followed its redirect to "/" and swapped the page in place.
     * The root layout is shared by every route, so it was never re-rendered -
     * and everything it mounts from the signed-in session (the live
     * notification poll and its bell badge, the "following" list) carried on
     * as if nobody had signed out. A document load tears all of that down, and
     * a plain <a> is never prefetched either.
     */
    return (
      <a href={href} role="menuitem" data-menu-item onClick={onSelect} className={className}>
        {inner}
      </a>
    );
  }

  if (href) {
    return (
      <Link
        href={href}
        role="menuitem"
        data-menu-item
        /**
         * Menu rows are never prefetched.
         *
         * Next.js prefetches a <Link> as soon as it enters the viewport, and an
         * open account menu puts every row there at once. For an ordinary page
         * that is just a warm cache, but /logout is a GET route handler that
         * REVOKES THE SESSION - prefetching it signs the user out for merely
         * opening the menu, before they have clicked anything. Nothing in a
         * menu is hot enough to be worth a prefetch, so the whole component
         * opts out rather than relying on each call site to remember.
         */
        prefetch={false}
        // Still fires so the menu closes on selection; navigation is the
        // link's own job and is not intercepted.
        onClick={onSelect}
        className={className}
      >
        {inner}
      </Link>
    );
  }

  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      data-menu-item
      onClick={onSelect}
      className={className}
    >
      {inner}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-edge" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pb-1 pt-2 text-2xs font-medium uppercase tracking-wider text-fg-subtle">
      {children}
    </div>
  );
}
