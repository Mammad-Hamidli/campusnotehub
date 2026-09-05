'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/**
 * Shared dropdown primitive.
 *
 * Both the language and theme switchers, the user menu and the post overflow
 * menu use this. Writing the outside-click / Escape / focus-return logic once
 * is not just DRY — it is the difference between menus that behave
 * consistently and menus that each have their own subtly different keyboard
 * bugs, which is a very recognisable symptom of generated UI.
 *
 * Behaviour:
 *  - closes on outside pointerdown, Escape, and route-affecting selection
 *  - returns focus to the trigger on close, so keyboard users do not get
 *    dumped at the top of the document
 *  - ArrowDown/ArrowUp roving focus across items
 */
export function Menu({
  trigger,
  children,
  align = 'end',
  label,
  width = 'w-56',
}: {
  /** Render prop for the button. Receives open state and a toggle. */
  trigger: (props: { open: boolean; toggle: () => void; id: string }) => ReactNode;
  /** Render prop for the panel body. Receives a `close` callback. */
  children: (props: { close: () => void }) => ReactNode;
  align?: 'start' | 'end';
  label: string;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = () => {
    setOpen(false);
    // Return focus to the trigger button rather than losing it to <body>.
    containerRef.current?.querySelector<HTMLElement>('[data-menu-trigger]')?.focus();
  };

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
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

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      {trigger({ open, toggle: () => setOpen((v) => !v), id })}

      {open && (
        <div
          ref={panelRef}
          id={id}
          role="menu"
          aria-label={label}
          className={`overlay absolute z-50 mt-1.5 animate-scale-in origin-top p-1
                      ${align === 'end' ? 'right-0' : 'left-0'} ${width}`}
        >
          {children({ close })}
        </div>
      )}
    </div>
  );
}

/** A single row inside a Menu. */
export function MenuItem({
  onSelect,
  selected = false,
  icon,
  children,
  trailing,
}: {
  onSelect: () => void;
  selected?: boolean;
  icon?: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      data-menu-item
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm
                  transition-colors duration-100
                  hover:bg-surface-muted focus-visible:bg-surface-muted
                  ${selected ? 'font-medium text-fg' : 'text-fg-muted'}`}
    >
      {icon && <span className="shrink-0 text-fg-subtle">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
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
