'use client';

import { useEffect, useState } from 'react';
import { MessageSquareText, X } from 'lucide-react';
import { ContactForm } from './ContactForm';
import { useT } from '@/lib/i18n/LocaleProvider';

/** Floating support entry point. Messages use the same protected contact API. */
export function SupportWidget() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [catTapped, setCatTapped] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  function meow() {
    try {
      const AudioContextType = window.AudioContext;
      const audio = new AudioContextType();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(760, audio.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(410, audio.currentTime + 0.16);
      gain.gain.setValueAtTime(0.0001, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.09, audio.currentTime + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.2);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start();
      oscillator.stop(audio.currentTime + 0.21);
      oscillator.onended = () => void audio.close();
    } catch {
      // Sound is an optional delight; the button remains fully usable.
    }
  }

  return (
    <>
      <div data-support-controls className="pointer-events-none fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] right-3 z-30 w-max sm:bottom-5 sm:right-5">
        <div className="relative w-max">
          <div className="pointer-events-none absolute inset-x-0 bottom-[calc(100%+0.25rem)] flex justify-center">
            <button
              type="button"
              data-support-kitten
              onClick={() => {
                meow();
                setCatTapped(true);
                window.setTimeout(() => setCatTapped(false), 650);
              }}
              aria-label={t('dashboard.rankings.meow')}
              className={`pointer-events-auto block h-[115px] w-[63px] overflow-hidden bg-transparent p-0 transition-transform focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:h-[142px] sm:w-[78px] ${catTapped ? 'animate-[cat-tap_550ms_ease-out]' : ''}`}
            >
              {/* Transparent crop of the user-provided yellow mascot. */}
              {/* eslint-disable-next-line @next/next/no-img-element -- fixed local mascot asset needs no loader. */}
              <img src="/brand/yellow-mascot.webp" alt="" className="h-full w-full object-cover" />
            </button>
          </div>
          <button
            type="button"
            data-support-button
            onClick={() => setOpen(true)}
            className="pointer-events-auto inline-flex h-11 items-center gap-2 rounded-full bg-accent px-3.5 text-sm font-semibold text-accent-fg shadow-raised transition hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <MessageSquareText className="h-4 w-4" aria-hidden="true" />
            {t('contact.form.title')}
          </button>
        </div>
      </div>
      {open && (
        <div
          className="fixed inset-0 z-[80] flex items-end justify-center bg-black/45 p-3 sm:items-center sm:p-6"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
        >
          <section role="dialog" aria-modal="true" aria-label={t('contact.form.title')} className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-canvas p-4 shadow-raised sm:p-6">
            <div className="flex items-center justify-end">
              <button type="button" onClick={() => setOpen(false)} aria-label={t('common.close')} className="btn-ghost h-9 w-9 p-0">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <ContactForm />
          </section>
        </div>
      )}
    </>
  );
}
