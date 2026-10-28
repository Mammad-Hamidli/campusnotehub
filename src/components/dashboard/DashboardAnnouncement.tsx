'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Megaphone, X } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

type Announcement = {
  id: string; title: string; body: string; imageUrl: string | null;
  actionLabel: string | null; actionUrl: string | null;
  accent: 'violet' | 'blue' | 'amber' | 'rose' | 'emerald';
};

const accents: Record<Announcement['accent'], string> = {
  violet: 'from-violet-700 via-fuchsia-600 to-rose-500',
  blue: 'from-blue-700 via-cyan-600 to-teal-400',
  amber: 'from-amber-600 via-orange-500 to-rose-500',
  rose: 'from-rose-700 via-pink-600 to-violet-500',
  emerald: 'from-emerald-700 via-teal-600 to-cyan-500',
};

export function DashboardAnnouncement() {
  const t = useT();
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/announcements', { signal: controller.signal, cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { announcement?: Announcement | null } | null) => {
        const next = data?.announcement ?? null;
        setAnnouncement(next);
        if (next) setDismissed(window.localStorage.getItem(`announcement-dismissed:${next.id}`) === '1');
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  if (!announcement || dismissed) return null;

  function dismiss() {
    try { window.localStorage.setItem(`announcement-dismissed:${announcement!.id}`, '1'); } catch { /* Dismissal still works for this view. */ }
    setDismissed(true);
  }

  const actionUrl = announcement.actionUrl;
  const internalAction = Boolean(actionUrl?.startsWith('/') && !actionUrl.startsWith('//'));
  const action = internalAction && actionUrl ? (
    <Link href={actionUrl} className="inline-flex min-h-9 items-center gap-1 rounded-full bg-white px-4 text-xs font-bold text-slate-950 shadow-lg transition hover:bg-white/90">
      {announcement.actionLabel}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
    </Link>
  ) : actionUrl && /^https:\/\//i.test(actionUrl) ? (
    <a href={actionUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1 rounded-full bg-white px-4 text-xs font-bold text-slate-950 shadow-lg transition hover:bg-white/90">
      {announcement.actionLabel}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  ) : null;

  return (
    <aside role="status" aria-label={t('dashboard.announcement.label')} className={`pointer-events-auto absolute bottom-[calc(100%+0.75rem)] left-1/2 z-20 w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-2xl bg-gradient-to-r ${accents[announcement.accent]} text-white shadow-[0_16px_50px_-18px_rgba(15,23,42,.65)]`}>
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,.28),transparent_55%)]" aria-hidden="true" />
      <div className="relative flex items-center gap-3 p-3.5 pr-12 sm:gap-4 sm:p-4 sm:pr-14">
        {announcement.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- announcement images are arbitrary Cloudinary URLs.
          <img src={announcement.imageUrl} alt="" className="h-14 w-14 shrink-0 rounded-xl object-cover ring-1 ring-white/35 sm:h-16 sm:w-16" />
        ) : <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/25"><Megaphone className="h-5 w-5" aria-hidden="true" /></span>}
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-extrabold uppercase tracking-[.2em] text-white/80">{t('dashboard.announcement.eyebrow')}</p>
          <h2 className="mt-0.5 font-sans text-base font-extrabold leading-tight tracking-tight sm:text-lg">{announcement.title}</h2>
          <p className="mt-1 line-clamp-2 whitespace-pre-line text-xs leading-relaxed text-white/90 sm:text-sm">{announcement.body}</p>
          {action && <div className="mt-2.5">{action}</div>}
        </div>
        <button type="button" onClick={dismiss} aria-label={t('common.close')} className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full text-white/80 transition hover:bg-white/15 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
