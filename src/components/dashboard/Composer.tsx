'use client';

import { useRef, useState } from 'react';
import { Hash, ImagePlus, Loader2, Send, X } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

const MAX_CHARS = 2000;
const SUGGESTED_TAGS = ['ExamAlert', 'Career', 'Notes', 'Internship', 'Scholarship', 'Deadline'];

/**
 * Post composer.
 *
 * Note that posting is available to UNVERIFIED accounts. That is deliberate
 * and matches the capability table in src/lib/permissions.ts: unverified users
 * get the whole social product and can spend money, but cannot earn, withdraw,
 * or book a mentor. Gating the feed too would leave a new signup with an empty
 * product for 24 hours and tank funnel completion.
 */
export function Composer({
  author,
  onPost,
}: {
  author: { initials: string; name: string };
  onPost: (post: { body: string; tags: string[]; imageName?: string }) => void;
}) {
  const t = useT();
  const [body, setBody] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [imageName, setImageName] = useState<string | null>(null);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [posting, setPosting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
   * BACKEND INTEGRATION
   * -------------------
   *   POST /api/feed
   *   body: { body, visibility, tags: string[], media: [{ storageKey, width, height, altText }] }
   *   -> 201 { post }
   *   -> 429 errors.rateLimited  (20 posts/hour, see LIMITS in ratelimit.ts)
   *
   * Images follow the same direct-to-S3 path as verification documents:
   * POST /api/media/presign first, upload to S3, then send only the returned
   * storageKey. Image bytes never pass through the Next.js server.
   *
   * `visibility` is resolved server-side for UNIVERSITY_ONLY — the client may
   * request it but cannot choose which university, otherwise anyone could post
   * into any university's private feed.
   */
  async function submit() {
    if (!canPost) return;
    setPosting(true);

    // await fetch('/api/feed', {
    //   method: 'POST',
    //   headers: { 'content-type': 'application/json' },
    //   body: JSON.stringify({ body: body.trim(), visibility: 'PUBLIC', tags, media: [] }),
    // });
    await new Promise((r) => setTimeout(r, 450));

    onPost({ body: body.trim(), tags, imageName: imageName ?? undefined });
    setBody('');
    setTags([]);
    setImageName(null);
    setTagPickerOpen(false);
    setPosting(false);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }

  return (
    <div className="card p-4">
      <div className="flex gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full
 bg-surface-inset text-xs font-bold text-accent-fg"
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

          {imageName && (
            <div className="mt-2.5 flex items-center gap-2 rounded-lg bg-surface-muted px-3 py-2">
              <ImagePlus className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{imageName}</span>
              <button
                type="button"
                onClick={() => setImageName(null)}
                aria-label={t('common.delete')}
                className="rounded p-1 text-fg-subtle transition hover:bg-surface-inset hover:text-fg"
              >
                <X className="h-3.5 w-3.5" />
              </button>
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

          <div className="mt-3 flex items-center justify-between gap-3 border-t border-edge pt-3">
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                aria-label={t('feed.attachImage')}
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
                accept="image/*"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) setImageName(file.name);
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
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2
 text-sm font-semibold text-accent-fg transition hover:bg-accent
                           active:scale-[0.98] disabled:bg-surface-inset disabled:text-fg-subtle"
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
