'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

/**
 * The in-app paths visited in this document, newest last.
 *
 * Module scope, so it outlives every page; a full reload starts it over. The
 * browser's own history cannot answer "is the previous entry ours?" - it may be
 * a search engine or another site - so BackLink only steps back through
 * history this trail has seen, and otherwise follows its fallback link.
 */
const trail: string[] = [];

/** Mounted once in the root layout: records every client-side navigation. */
export function NavigationTrail() {
  const pathname = usePathname();
  useEffect(() => {
    if (trail[trail.length - 1] === pathname) return;
    // Landing on the page before this one is a Back (the browser's or ours).
    if (trail[trail.length - 2] === pathname) trail.pop();
    else trail.push(pathname);
  }, [pathname]);
  return null;
}

/**
 * The one Back control for sub-pages and detail views.
 *
 * Returns to wherever the reader came from inside the app (a profile opened
 * from search results goes back to those results, not to the feed). With no
 * such page - a shared link, a fresh tab, a reload - it goes to
 * `fallbackHref`, the page's logical parent. It is a real link to that parent,
 * so cmd/ctrl/middle-click still opens it in a new tab.
 */
export function BackLink({
  fallbackHref,
  label,
  className = '',
}: {
  fallbackHref: string;
  /** Defaults to "Back"; the destination is not always the fallback. */
  label?: string;
  className?: string;
}) {
  const t = useT();
  const router = useRouter();

  return (
    <Link
      href={fallbackHref}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (trail.length < 2) return;
        event.preventDefault();
        router.back();
      }}
      className={`btn-ghost -ml-2 h-8 px-2 text-sm ${className}`}
    >
      <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
      {label ?? t('common.back')}
    </Link>
  );
}
