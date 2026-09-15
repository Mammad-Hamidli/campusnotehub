'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Loader2, Upload, X } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { NOTE_UPLOAD_ACCEPT, MAX_NOTE_BYTES, MAX_NOTE_MB } from '@/lib/notes/fileTypes';
import { FileChip } from './FileChip';

/**
 * UniNotes upload.
 *
 * The client-side checks below are a courtesy to honest users - they turn a
 * 400 round trip into instant feedback. They are NOT the control: the server
 * re-derives the type from the file's actual bytes in
 * src/lib/notes/fileTypes.ts, because `file.type` is a string the browser
 * copies from the extension and an attacker sets it to whatever they like.
 * Renaming payload.exe to notes.pdf passes every check on this page and is
 * refused by the server.
 */
export function NoteUploadForm({ universities }: { universities: { id: string; code: string }[] }) {
  const t = useT();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 0-100 while a request is in flight. */
  const [progress, setProgress] = useState(0);
  /**
   * Held so the user can cancel mid-upload.
   *
   * A 50 MB file on campus wifi is a genuinely long operation, and a form that
   * cannot be cancelled leaves the only escape being a page reload - which
   * loses everything already typed into the metadata fields below.
   */
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const [form, setForm] = useState({
    title: '',
    description: '',
    subject: '',
    courseCode: '',
    academicYear: '',
    language: 'az',
    priceMinor: '0',
  });
  const [universityIds, setUniversityIds] = useState<string[]>([]);
  /** Last title we generated; lets a new file replace it but never a user edit. */
  const autoTitle = useRef('');

  function toggleUniversity(id: string) {
    setUniversityIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : ids.length < 10 ? [...ids, id] : ids));
  }

  function pick(selected: File | null) {
    setError(null);
    if (!selected) return setFile(null);
    if (selected.size > MAX_NOTE_BYTES) {
      setError(t('notes.upload.errors.tooLarge'));
      return setFile(null);
    }
    setFile(selected);

    // "calculus_final-2024.pdf" -> "calculus final 2024"; only overwrite an
    // empty or previously auto-filled title.
    const derived = selected.name
      .replace(/\.[^.]+$/, '')
      .replace(/[_\-.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    setForm((f) => {
      if (f.title && f.title !== autoTitle.current) return f;
      autoTitle.current = derived;
      return { ...f, title: derived };
    });
  }

  function cancel() {
    xhrRef.current?.abort();
    xhrRef.current = null;
    setBusy(false);
    setProgress(0);
    setError(t('notes.upload.errors.cancelled'));
  }

  /**
   * Submits with XMLHttpRequest rather than fetch.
   *
   * This is the one place in the codebase that does, and the reason is
   * specific: fetch cannot report UPLOAD progress. `ReadableStream` request
   * bodies would allow it in principle, but they require HTTP/2, are not
   * supported in Safari, and need a duplex flag that changes the request
   * semantics. XHR exposes `upload.onprogress` in every browser this product
   * targets, and a 50 MB upload with no progress bar is indistinguishable from
   * a frozen page - people give up and retry, which doubles the load.
   *
   * Everything else is unchanged: same endpoint, same multipart body, same
   * server-side validation. Only the transport differs.
   */
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return setError(t('notes.upload.errors.missing'));

    setBusy(true);
    setError(null);
    setProgress(0);

    const body = new FormData();
    body.append('file', file);
    for (const [key, value] of Object.entries(form)) {
      if (value) body.append(key, value);
    }
    for (const id of universityIds) body.append('universityIds', id);

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open('POST', '/api/notes');

    xhr.upload.onprogress = (progressEvent) => {
      if (!progressEvent.lengthComputable) return;
      // Capped at 99: the last percent is the SERVER validating the bytes and
      // writing the row, which takes real time on a large file. Showing 100%
      // while that runs is what makes an upload look hung at the finish line.
      setProgress(Math.min(99, Math.round((progressEvent.loaded / progressEvent.total) * 100)));
    };

    xhr.onload = () => {
      xhrRef.current = null;
      setProgress(100);

      let payload: { error?: string } = {};
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        // A non-JSON body means something upstream failed (a proxy 413, an
        // HTML error page). The generic message is the honest answer.
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        // Uploaded notes wait for moderator approval before they are listed.
        window.alert(t('notes.upload.pendingReview'));
        router.push('/notes');
        return;
      }

      setBusy(false);
      setProgress(0);
      setError(t(payload.error ?? 'errors.generic'));
    };

    xhr.onerror = () => {
      xhrRef.current = null;
      setBusy(false);
      setProgress(0);
      setError(t('notes.upload.errors.network'));
    };

    // Fires on xhr.abort(); cancel() has already set the message and state.
    xhr.onabort = () => {
      xhrRef.current = null;
    };

    xhr.send(body);
  }

  const field = 'input py-2 text-sm';

  return (
    <form onSubmit={submit} className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-xl font-bold tracking-tight text-fg">{t('notes.upload.title')}</h1>
      <p className="mt-1 text-sm text-fg-muted">{t('notes.upload.subtitle')}</p>

      <div className="card mt-5 p-4">
        <label className="text-2xs font-medium uppercase tracking-wide text-fg-subtle">
          {t('notes.upload.file')}
        </label>

        {!file ? (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="mt-2 flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-edge bg-surface-muted px-4 py-8 text-center transition-colors hover:border-edge-strong"
          >
            <Upload className="h-5 w-5 text-fg-subtle" aria-hidden="true" />
            <span className="text-sm font-medium text-fg">{t('notes.upload.choose')}</span>
            <span className="text-2xs text-fg-muted">{t('notes.upload.accepted')}</span>
            {/* The limit is stated up front and read from the same constant
                the server enforces, so the two can never disagree - a form
                that says 10 MB while the API accepts 50 is worse than silence. */}
            <span className="text-2xs text-fg-subtle">
              {t('notes.upload.maxSize', { mb: MAX_NOTE_MB })}
            </span>
          </button>
        ) : (
          <div className="mt-2 rounded-xl border border-edge bg-surface-muted p-3">
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 shrink-0 text-fg-subtle" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg">{file.name}</span>
                <span className="text-2xs text-fg-muted">
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </span>
              </span>
              <button
                type="button"
                onClick={() => (busy ? cancel() : pick(null))}
                className="btn-ghost px-2 py-1"
                aria-label={busy ? t('notes.upload.cancel') : t('notes.upload.remove')}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {busy && (
              <div className="mt-3">
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full bg-surface-inset"
                  role="progressbar"
                  aria-valuenow={progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={t('notes.upload.progress', { percent: progress })}
                >
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-200"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="mt-1.5 flex items-center justify-between text-2xs text-fg-muted">
                  <span>{t('notes.upload.progress', { percent: progress })}</span>
                  <button
                    type="button"
                    onClick={cancel}
                    className="font-medium text-fg-muted underline underline-offset-2 hover:text-fg"
                  >
                    {t('notes.upload.cancel')}
                  </button>
                </p>
              </div>
            )}
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          accept={NOTE_UPLOAD_ACCEPT}
          onChange={(event) => pick(event.target.files?.[0] ?? null)}
        />
      </div>

      <div className="card mt-3 grid gap-3 p-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-2xs font-medium text-fg-muted">{t('notes.upload.fields.title')}</span>
          <input required minLength={3} maxLength={160} className={field}
            value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          {form.title && form.title === autoTitle.current && (
            <span className="text-2xs text-fg-subtle">{t('notes.upload.titleFromFile')}</span>
          )}
        </label>

        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-2xs font-medium text-fg-muted">{t('notes.upload.fields.description')}</span>
          <textarea required minLength={10} maxLength={4000} rows={4} className={`${field} resize-y`}
            value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('notes.upload.fields.subject')}</span>
          <input required minLength={2} maxLength={80} className={field}
            value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('notes.upload.fields.courseCode')}</span>
          <input maxLength={32} className={field}
            value={form.courseCode} onChange={(e) => setForm({ ...form, courseCode: e.target.value })} />
        </label>

        <fieldset className="flex flex-col gap-1 sm:col-span-2">
          <legend className="text-2xs font-medium text-fg-muted">
            {t('notes.upload.fields.universities')}
          </legend>
          <div className="mt-1 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
            {universities.map((u) => {
              const on = universityIds.includes(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleUniversity(u.id)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                    on
                      ? 'bg-accent text-accent-fg'
                      : 'border border-edge bg-surface text-fg-muted hover:border-edge-strong'
                  }`}
                >
                  {u.code}
                </button>
              );
            })}
          </div>
          <span className="text-2xs text-fg-subtle">{t('notes.upload.universitiesHint')}</span>
        </fieldset>

        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('notes.upload.fields.price')}</span>
          {/* Minor units (qepik), matching how money is stored everywhere else
              in this schema. Never a float. */}
          <input type="number" min={0} max={100000} step={50} className={field}
            value={form.priceMinor} onChange={(e) => setForm({ ...form, priceMinor: e.target.value })} />
        </label>
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-danger/40 bg-danger/5 p-2.5 text-sm text-danger-fg">
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button type="submit" className="btn-primary" disabled={busy || !file}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {t('notes.upload.submit')}
        </button>
        <span className="text-2xs text-fg-muted">{t('notes.upload.draftNote')}</span>
      </div>
    </form>
  );
}

export { FileChip };
