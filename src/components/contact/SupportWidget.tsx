'use client';

import { useEffect, useState } from 'react';
import { MessageSquareText, X } from 'lucide-react';
import { ContactForm } from './ContactForm';
import { useT } from '@/lib/i18n/LocaleProvider';

/** Floating support entry point. Messages use the same protected contact API. */
export function SupportWidget() {
  const t = useT();
  const [open, setOpen] = useState(false);

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
      <div data-support-controls className="fixed bottom-6 right-6 z-50 w-max">
        <button
          type="button"
          data-support-kitten
          onClick={meow}
          aria-label={t('dashboard.rankings.meow')}
          className="absolute bottom-[calc(100%+1mm)] left-0 flex h-9 w-9 items-center justify-center border-0 bg-transparent p-0 leading-none drop-shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          style={{ animation: 'support-kitten-wander 5.6s infinite' }}
        >
          <span className="inline-block text-[2.25rem] leading-none">
            🐈
          </span>
        </button>
        <button
          type="button"
          data-support-button
          onClick={() => setOpen(true)}
          className="inline-flex h-12 items-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-accent-fg shadow-raised transition hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <MessageSquareText className="h-4 w-4" aria-hidden="true" />
          {t('contact.form.title')}
        </button>
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
