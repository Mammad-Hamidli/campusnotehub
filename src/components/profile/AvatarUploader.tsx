'use client';

import { useRef, useState } from 'react';
import { Camera, Loader2, Trash2 } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { IMAGE_ACCEPT_ATTRIBUTE, MAX_IMAGE_BYTES } from '@/lib/media/constants';

/**
 * The profile picture with change / remove controls.
 *
 * Uploads to POST /api/me/avatar, which re-encodes to a square WebP (EXIF and
 * GPS destroyed) - so what comes back is always safe to show immediately.
 * The ring around the picture is the verification state (see UserAvatar).
 */
export function AvatarUploader({
  nickname,
  avatarUrl,
  verified,
  onChange,
}: {
  nickname: string;
  avatarUrl: string | null;
  verified: boolean;
  onChange: (avatarUrl: string | null) => void;
}) {
  const t = useT();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    // Fast reject only; the server re-checks the actual bytes.
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error(t('feed.image.errors.tooLarge'));
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/me/avatar', { method: 'POST', body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(t(body.error ?? 'feed.image.errors.uploadFailed'));
        return;
      }
      onChange(body.avatarUrl);
      toast.success(t('profile.avatar.updated'));
    } catch {
      toast.error(t('feed.image.errors.uploadFailed'));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch('/api/me/avatar', { method: 'DELETE' });
      if (!res.ok) {
        toast.error(t('errors.generic'));
        return;
      }
      onChange(null);
      toast.success(t('profile.avatar.removed'));
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        className="group relative rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        aria-label={t(avatarUrl ? 'profile.avatar.change' : 'profile.avatar.upload')}
      >
        <UserAvatar nickname={nickname} src={avatarUrl} verified={verified} size="xl" verifiedLabel={t('profile.verified')} />
        <span
          className="absolute inset-[6px] flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          aria-hidden="true"
        >
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Camera className="h-5 w-5" />}
        </span>
      </button>

      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT_ATTRIBUTE}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />

      <div className="flex items-center gap-1">
        <button type="button" onClick={() => input.current?.click()} disabled={busy} className="btn-ghost h-7 px-2 text-2xs">
          <Camera className="h-3.5 w-3.5" aria-hidden="true" />
          {t(avatarUrl ? 'profile.avatar.change' : 'profile.avatar.upload')}
        </button>
        {avatarUrl && (
          <button type="button" onClick={remove} disabled={busy} className="btn-ghost h-7 px-2 text-2xs text-danger">
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t('profile.avatar.remove')}
          </button>
        )}
      </div>
    </div>
  );
}
