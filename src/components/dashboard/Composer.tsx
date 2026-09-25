'use client';

import { useEffect, useRef, useState } from 'react';
import { Bookmark, Hash, ImagePlus, Loader2, Send, X } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { IMAGE_ACCEPT_ATTRIBUTE, MAX_IMAGE_BYTES, MAX_IMAGE_MB } from '@/lib/media/constants';
import { completedHashtags, extractHashtags, MAX_POST_TAGS } from '@/lib/feed/hashtags';

const MAX_CHARS = 2000;
const SUGGESTED_TAGS = ['ExamAlert', 'Career', 'Notes', 'Internship', 'Scholarship', 'Deadline'];
/** Tags the writer said "no" to, for this browser session - asked once, not on every post. */
const DECLINED_KEY = 'campusnotehub:declined-hashtag-templates';

function readDeclined(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(DECLINED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/**
 * Post composer.
 *
 * Note that posting is available to UNVERIFIED accounts. That is deliberate
 * and matches the capability table in src/lib/permissions.ts: unverified users
 * get the whole social product and can spend money, but cannot earn, withdraw,
 * or book a mentor. Gating the feed too would leave a new signup with an empty
 * product for 24 hours and tank funnel completion.
 *
 * HASHTAGS. A `#tag` typed in the body is a tag of the post (merged with the
 * picker's, capped at MAX_POST_TAGS). Once the writer has finished a tag that
 * is not yet a template, the composer offers to save it; saved templates sit
 * under the input as one-tap buttons (POST/DELETE /api/me/hashtag-templates).
 */
export function Composer({
  author,
  initialTemplates = [],
  onPost,
}: {
  author: { initials: string; name: string };
  /** The viewer's saved hashtag templates, from GET /api/me. */
  initialTemplates?: string[];
  /**
   * Performs the actual write and RESOLVES when it is done.
   *
   * This used to be a fire-and-forget `void` callback, which is what let the
   * composer clear itself and stop spinning before anything had been saved -
   * a failed post looked exactly like a successful one. Returning a promise
   * means the button's busy state tracks the real request, and a rejection is
   * something this component can actually show.
   */
  onPost: (post: { body: string; tags: string[]; image?: File }) => Promise<void>;
}) {
  const t = useT();
  const toast = useToast();
  const [body, setBody] = useState('');
  const [templates, setTemplates] = useState<string[]>(initialTemplates);
  /** The finished hashtag currently offered as a template, if any. */
  const [offer, setOffer] = useState<string | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const declined = useRef<Set<string> | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [posting, setPosting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Local preview, via an object URL.
   *
   * Revoked whenever the file changes and on unmount: an un-revoked object URL
   * pins the whole image in memory for the life of the document, so composing
   * several posts in a session would leak a few megabytes each time.
   */
  useEffect(() => {
    if (!image) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  /**
   * Offer the first finished hashtag that is neither a template already nor
   * one the writer declined. One question at a time: the next tag is offered
   * once this one is answered.
   */
  useEffect(() => {
    if (offer) return;
    declined.current ??= readDeclined();
    const known = new Set(templates.map((tag) => tag.toLowerCase()));
    const next = completedHashtags(body).find(
      (tag) => !known.has(tag.toLowerCase()) && !declined.current!.has(tag.toLowerCase()),
    );
    if (next) setOffer(next);
  }, [body, templates, offer]);

  function declineOffer() {
    if (!offer) return;
    declined.current ??= readDeclined();
    declined.current.add(offer.toLowerCase());
    try {
      sessionStorage.setItem(DECLINED_KEY, JSON.stringify([...declined.current]));
    } catch {
      // Private mode: the refusal still holds for this page.
    }
    setOffer(null);
  }

  async function editTemplate(tag: string, op: 'add' | 'remove') {
    setSavingTemplate(true);
    try {
      const response = await fetch('/api/me/hashtag-templates', {
        method: op === 'add' ? 'POST' : 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(t(payload?.error ?? 'feed.templates.errors.failed', payload?.params));
        return;
      }
      setTemplates(payload.templates as string[]);
      if (op === 'add') toast.success(t('feed.templates.saved', { tag: `#${tag}` }));
    } catch {
      toast.error(t('feed.templates.errors.failed'));
    } finally {
      setSavingTemplate(false);
      if (op === 'add') setOffer(null);
    }
  }

  /** Inserts `#tag ` at the caret, with a space before it when needed. */
  function insertTemplate(tag: string) {
    const el = textareaRef.current;
    const at = el?.selectionStart ?? body.length;
    const before = body.slice(0, at);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    setBody(`${before}${pad}#${tag} ${body.slice(at)}`);
    requestAnimationFrame(() => {
      if (!el) return;
      const caret = before.length + pad.length + tag.length + 2;
      el.focus();
      el.setSelectionRange(caret, caret);
      autoGrow(el);
    });
  }

  const remaining = MAX_CHARS - body.length;
  const canPost = body.trim().length > 0 && remaining >= 0 && !posting;

  function autoGrow(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }

  function toggleTag(tag: string) {
    setTags((prev) =>
      prev.includes(tag) ? prev.filter((x) => x !== tag) : prev.length < 5 ? [...prev, tag] : prev,
    );
  }

  /**
   * Hands the draft to the parent, which owns the request.
   *
   * The body of this function used to be a commented-out fetch followed by
   * `await new Promise(r => setTimeout(r, 450))` - a simulated network delay.
   * The composer therefore always "succeeded": it cleared the textarea and
   * added a card locally while nothing was written, so the post vanished on
   * reload and never existed for anyone else.
   *
   * Now it awaits the real write and only clears the form if that write
   * resolved. A failure keeps the user's text on screen, which is the whole
   * point - retyping a lost post is the worst possible outcome here.
   */
  async function submit() {
    if (!canPost) return;
    setPosting(true);
    setError(null);

    try {
      // Body hashtags are tags too; the picker's come first, the cap is the server's.
      const merged = [...tags, ...extractHashtags(body)].filter(
        (tag, i, all) => all.findIndex((other) => other.toLowerCase() === tag.toLowerCase()) === i,
      );
      await onPost({ body: body.trim(), tags: merged.slice(0, MAX_POST_TAGS), image: image ?? undefined });

      setBody('');
      setTags([]);
      setOffer(null);
      setImage(null);
      setTagPickerOpen(false);
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    } catch (cause) {
      // The parent throws with a locale key it got from the server.
      setError(cause instanceof Error ? cause.message : 'errors.generic');
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="card p-4">
      <div className="flex gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full
 bg-surface-inset text-xs font-bold text-accent"
          aria-hidden="true"
        >
          {author.initials}
        </span>

        <div className="min-w-0 flex-1">
          <label htmlFor="composer" className="sr-only">
            {t('feed.composerPlaceholder')}
          </label>
          <textarea
            id="composer"
            ref={textareaRef}
            value={body}
            rows={2}
            onChange={(e) => {
              setBody(e.target.value);
              autoGrow(e.target);
            }}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter posts. Plain Enter must insert a newline — this
              // is a multi-line composer, not a chat input.
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
            }}
            placeholder={`${t('feed.composerPlaceholder')} #ExamAlert`}
            className="w-full resize-none border-0 bg-transparent p-0 text-[0.9375rem] leading-relaxed
 text-fg placeholder:text-fg-subtle focus:ring-0"
          />

          {offer && (
            <div
              role="status"
              className="mt-2.5 flex animate-rise flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2"
            >
              <p className="min-w-0 flex-1 text-xs text-fg">
                {t('feed.templates.prompt')} <span className="font-semibold text-accent">#{offer}</span>
              </p>
              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  disabled={savingTemplate}
                  onClick={() => void editTemplate(offer, 'add')}
                  className="btn-primary h-7 px-2.5 text-xs"
                >
                  {savingTemplate && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
                  {t('feed.templates.save')}
                </button>
                <button type="button" onClick={declineOffer} className="btn-ghost h-7 px-2.5 text-xs">
                  {t('feed.templates.dismiss')}
                </button>
              </div>
            </div>
          )}

          {templates.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5" role="group" aria-label={t('feed.templates.label')}>
              <Bookmark className="h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
              {templates.map((tag) => (
                <span
                  key={tag}
                  className="group inline-flex items-center rounded-full border border-edge bg-surface-muted text-xs font-medium text-fg-muted"
                >
                  <button
                    type="button"
                    onClick={() => insertTemplate(tag)}
                    title={t('feed.templates.insert', { tag: `#${tag}` })}
                    className="rounded-l-full py-1 pl-2.5 pr-1 transition hover:text-accent"
                  >
                    #{tag}
                  </button>
                  <button
                    type="button"
                    disabled={savingTemplate}
                    onClick={() => void editTemplate(tag, 'remove')}
                    aria-label={t('feed.templates.remove', { tag: `#${tag}` })}
                    className="rounded-r-full py-1 pl-0.5 pr-2 opacity-50 transition hover:text-danger group-hover:opacity-100"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {tags.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  className="group inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1
 text-xs font-medium text-accent transition hover:bg-accent-soft"
                >
                  #{tag}
                  <X className="h-3 w-3 opacity-50 transition group-hover:opacity-100" aria-hidden="true" />
                </button>
              ))}
            </div>
          )}

          {image && (
            <div className="relative mt-2.5 overflow-hidden rounded-xl border border-edge bg-surface-muted">
              {preview && (
                // eslint-disable-next-line @next/next/no-img-element -- a local
                // object URL, never a remote asset; next/image cannot optimise
                // a blob: URL and would only add a loader hop.
                <img
                  src={preview}
                  alt={image.name}
                  className="max-h-72 w-full object-contain"
                />
              )}
              <div className="flex items-center gap-2 px-3 py-2">
                <ImagePlus className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
                  {image.name} · {(image.size / 1024 / 1024).toFixed(1)} MB
                </span>
                <button
                  type="button"
                  onClick={() => setImage(null)}
                  aria-label={t('common.delete')}
                  className="rounded p-1 text-fg-subtle transition hover:bg-surface-inset hover:text-fg"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {posting && (
                // The upload is a real request now, and a 12 MB image on campus
                // wifi is several seconds. An indeterminate bar is honest here:
                // fetch cannot report upload progress (see the note in the
                // notes form, which uses XHR for exactly that reason).
                <div className="h-1 w-full overflow-hidden bg-surface-inset">
                  <div className="h-full w-1/3 animate-marquee rounded-full bg-accent" />
                </div>
              )}
            </div>
          )}

          {tagPickerOpen && (
            <div className="mt-3 flex flex-wrap gap-1.5 rounded-lg bg-surface-muted p-2.5">
              {SUGGESTED_TAGS.map((tag) => {
                const selected = tags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(tag)}
                    aria-pressed={selected}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                      selected
                        ? 'bg-accent text-accent-fg'
                        : 'bg-surface text-fg-muted hover:bg-surface-inset'
                    }`}
                  >
                    #{tag}
                  </button>
                );
              })}
            </div>
          )}

          {error && (
            <p className="mt-2.5 text-xs text-danger" role="alert">
              {t(error)}
            </p>
          )}

          <div className="mt-3 flex items-center justify-between gap-3 border-t border-edge pt-3">
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                aria-label={t('feed.attachImage')}
                title={t('feed.image.maxSize', { mb: MAX_IMAGE_MB })}
                className="rounded-lg p-2 text-fg-subtle transition hover:bg-accent-soft hover:text-accent"
              >
                <ImagePlus className="h-[1.15rem] w-[1.15rem]" />
              </button>
              <button
                type="button"
                onClick={() => setTagPickerOpen((v) => !v)}
                aria-expanded={tagPickerOpen}
                aria-label={t('feed.addTag')}
                className={`rounded-lg p-2 transition hover:bg-accent-soft hover:text-accent ${
                  tagPickerOpen ? 'bg-accent-soft text-accent' : 'text-fg-subtle'
                }`}
              >
                <Hash className="h-[1.15rem] w-[1.15rem]" />
              </button>
              <input
                ref={fileRef}
                type="file"
                accept={IMAGE_ACCEPT_ATTRIBUTE}
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // The FILE is kept, not just its name. Keeping only the name
                  // is why the previous version could never upload anything -
                  // by submit time the bytes were gone.
                  if (file) {
                    // Instant feedback only. The server re-derives the type
                    // from the bytes and re-checks the size; this just saves a
                    // pointless 12 MB round trip.
                    if (file.size > MAX_IMAGE_BYTES) {
                      setError('feed.image.errors.tooLarge');
                      setImage(null);
                    } else {
                      setError(null);
                      setImage(file);
                    }
                  }
                  e.target.value = '';
                }}
              />
            </div>

            <div className="flex items-center gap-3">
              {body.length > MAX_CHARS * 0.8 && (
                <span
                  aria-live="polite"
                  className={`tabular text-xs font-medium ${
                    remaining < 0 ? 'text-danger' : 'text-fg-subtle'
                  }`}
                >
                  {remaining}
                </span>
              )}
              <button
                type="button"
                onClick={submit}
                disabled={!canPost}
                /* Was `bg-accent text-accent hover:bg-accent`: label and icon
                   painted in the fill colour, so the Share button rendered as a
                   blank pill. `accent-fg` is the on-accent token (white / near-
                   black by theme); disabled uses the inset surface + subtle
                   text pair, which also keeps contrast in both themes. */
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2
 text-sm font-semibold text-accent-fg transition hover:bg-accent-hover
                           active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-surface-inset disabled:text-fg-subtle"
              >
                {posting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Send className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {t('feed.post')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
