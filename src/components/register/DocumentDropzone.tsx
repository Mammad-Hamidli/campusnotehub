'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { AlertTriangle, Check, FileText, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

export type DocKind = 'STUDENT_CARD_FRONT' | 'STUDENT_CARD_BACK' | 'ID_FRONT' | 'ID_BACK';

export type DocState =
  | { phase: 'empty' }
  | { phase: 'preparing'; previewUrl: string; fileName: string }
  | { phase: 'rejected'; previewUrl: string; fileName: string; messageKey: string }
  | { phase: 'ready'; previewUrl: string; fileName: string; file: File; bytes: number };

/** Matches ALLOWED_MIME in src/lib/verification/fileValidation.ts. */
const ACCEPTED = ['image/jpeg', 'image/png', 'application/pdf'] as const;
const MAX_MB = 5;
const MAX_BYTES = MAX_MB * 1024 * 1024;
const MIN_EDGE = 600;

type Props = {
  kind: DocKind;
  labelKey: string;
  state: DocState;
  onChange: (kind: DocKind, next: DocState) => void;
};

/**
 * One document slot.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED FROM THE PREVIOUS VERSION
 * ---------------------------------------------------------------------------
 * This component no longer uploads anything on its own. It used to request a
 * presigned S3 POST and push the file straight to a bucket; under the
 * zero-retention policy there is no bucket, so the file is held in local
 * component state and submitted with the rest of the form as one multipart
 * request. The bytes go to the verification pipeline, get analysed in memory,
 * and are wiped - they are never written anywhere.
 *
 * Practical consequence worth knowing: the file sits in the browser tab until
 * submit. That is fine (it was already there when the user picked it) but it
 * does mean a page refresh loses the selection, which is why the wizard warns
 * before navigating away.
 *
 * ---------------------------------------------------------------------------
 * THE 5 MB CAP AND WHY DOWNSCALING IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 * A modern phone camera produces 4-9 MB JPEGs at full resolution, so a naive
 * 5 MB limit would reject a large share of perfectly good photos and the user
 * would have no idea what to do about it. Every image is therefore downscaled
 * in the browser before it counts against the cap: long edge to 2000px, JPEG
 * quality stepped down until it fits.
 *
 * 2000px is chosen deliberately - an ID-1 card at 2000px on the long edge is
 * roughly 300 DPI, which is comfortably above what the OCR stage needs, so the
 * compression costs nothing in accuracy while removing the most common reason
 * an honest submission fails.
 */
export function DocumentDropzone({ kind, labelKey, state, onChange }: Props) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const id = useId();
  const statusId = `${id}-status`;

  const handleFile = useCallback(
    async (file: File) => {
      if (!ACCEPTED.includes(file.type as (typeof ACCEPTED)[number])) {
        onChange(kind, {
          phase: 'rejected',
          previewUrl: '',
          fileName: file.name,
          messageKey: 'verification.quality.wrongFormat',
        });
        return;
      }

      const previewUrl = file.type === 'application/pdf' ? '' : URL.createObjectURL(file);
      onChange(kind, { phase: 'preparing', previewUrl, fileName: file.name });

      // PDFs are passed through untouched - re-encoding them in the browser is
      // not possible and the server rasterises them anyway.
      if (file.type === 'application/pdf') {
        if (file.size > MAX_BYTES) {
          onChange(kind, {
            phase: 'rejected',
            previewUrl,
            fileName: file.name,
            messageKey: 'verification.quality.tooLarge',
          });
          return;
        }
        onChange(kind, { phase: 'ready', previewUrl, fileName: file.name, file, bytes: file.size });
        return;
      }

      const prepared = await prepareImage(file);
      if (!prepared.ok) {
        onChange(kind, {
          phase: 'rejected',
          previewUrl,
          fileName: file.name,
          messageKey: prepared.messageKey,
        });
        return;
      }

      // Replace the preview with the downscaled version so what the user sees
      // is what the server will actually receive.
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const finalPreview = URL.createObjectURL(prepared.file);

      onChange(kind, {
        phase: 'ready',
        previewUrl: finalPreview,
        fileName: file.name,
        file: prepared.file,
        bytes: prepared.file.size,
      });
    },
    [kind, onChange],
  );

  const clear = () => {
    if ('previewUrl' in state && state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    onChange(kind, { phase: 'empty' });
  };

  const previewUrl = 'previewUrl' in state ? state.previewUrl : '';
  const isReady = state.phase === 'ready';
  const isRejected = state.phase === 'rejected';
  const isBusy = state.phase === 'preparing';
  const isPdf = isReady && state.file.type === 'application/pdf';

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) void handleFile(file);
      }}
      className={`group relative flex flex-col overflow-hidden rounded-xl border-2 bg-surface
                  transition-all duration-200
        ${
          dragging
            ? 'border-dashed border-accent bg-accent-soft/60 shadow-raised'
            : isReady
              ? 'border-solid border-verified/40 '
              : isRejected
                ? 'border-solid border-danger/40 '
                : 'border-dashed border-edge  hover:border-edge-strong'
        }`}
    >
      <div className="flex items-start justify-between gap-2 px-3.5 pt-3.5">
        <label htmlFor={id} className="text-sm font-semibold leading-snug text-fg">
          {t(labelKey)}
          <span className="ml-0.5 text-danger" aria-hidden="true">
            *
          </span>
        </label>
        {isReady && (
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-verified"
            aria-hidden="true"
          >
            <Check className="h-3 w-3 text-white" strokeWidth={3} />
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={isBusy}
        aria-describedby={statusId}
        className="relative mx-3.5 mt-3 aspect-[8/5] overflow-hidden rounded-lg bg-surface-inset
 transition disabled:cursor-wait"
      >
        {isPdf ? (
          <span className="flex h-full flex-col items-center justify-center gap-2 text-fg-muted">
            <FileText className="h-8 w-8" aria-hidden="true" />
            <span className="text-xs font-medium">PDF</span>
          </span>
        ) : previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- object URL, no loader
          <img src={previewUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <span
              className="flex h-9 w-9 items-center justify-center rounded-full bg-surface 
 transition group-hover:bg-accent"
            >
              <Upload
                className="h-4 w-4 text-fg-muted transition group-hover:text-accent-fg"
                aria-hidden="true"
              />
            </span>
            <span className="text-xs leading-snug text-fg-muted">
              {t('verification.upload.dropHere')}
            </span>
          </span>
        )}

        {isBusy && (
          <span className="absolute inset-0 flex items-center justify-center bg-surface/45 backdrop-blur-[2px]">
            <Loader2 className="h-6 w-6 animate-spin text-accent-fg" aria-hidden="true" />
          </span>
        )}
      </button>

      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={ACCEPTED.join(',')}
        capture="environment"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
          e.target.value = ''; // allow re-picking the same file after a rejection
        }}
      />

      <div className="flex min-h-[2.75rem] items-center gap-2 px-3.5 py-2.5">
        <p
          id={statusId}
          aria-live="polite"
          className={`min-w-0 flex-1 text-xs leading-snug ${
            isRejected ? 'text-danger' : isReady ? 'text-verified-fg' : 'text-fg-muted'
          }`}
        >
          {state.phase === 'empty' && `JPG / PNG / PDF · max ${MAX_MB} MB`}
          {isBusy && t('verification.upload.checking')}
          {isReady && `${t('verification.upload.ready')} · ${(state.bytes / 1024 / 1024).toFixed(1)} MB`}
          {isRejected && (
            <span className="flex items-start gap-1.5">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {t(state.messageKey, { max: MAX_MB })}
            </span>
          )}
        </p>

        {(isReady || isRejected) && (
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              aria-label={t('verification.upload.replace')}
              className="rounded-md p-1.5 text-fg-subtle transition hover:bg-surface-inset hover:text-fg"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={clear}
              aria-label={t('verification.upload.remove')}
              className="rounded-md p-1.5 text-fg-subtle transition hover:bg-danger-soft hover:text-danger"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

type PrepareResult = { ok: true; file: File } | { ok: false; messageKey: string };

/**
 * Downscale, re-encode, and run a cheap blur check - all in the browser.
 *
 * The blur estimate mirrors the first stage of the real analysis in
 * services/doc-verifier/app/main.py, with a deliberately laxer threshold. The
 * browser should reject only what is unambiguously unusable; every judgement
 * call belongs to the server, which sees all four documents together.
 *
 * Re-encoding has a privacy side effect worth naming: it strips EXIF, which on
 * a phone photo includes GPS coordinates. The user gets to prove they are a
 * student without also telling us the address they were standing at.
 */
async function prepareImage(file: File): Promise<PrepareResult> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return { ok: false, messageKey: 'verification.quality.wrongFormat' };

  try {
    if (Math.max(bitmap.width, bitmap.height) < MIN_EDGE) {
      return { ok: false, messageKey: 'verification.quality.tooSmall' };
    }

    const MAX_EDGE = 2000;
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
    if (!ctx) return { ok: true, file }; // no canvas: let the server decide

    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);

    if (isBlurry(ctx, width, height)) {
      return { ok: false, messageKey: 'verification.quality.tooBlurry' };
    }

    // Step quality down until it fits. Starting at 0.92 keeps the text crisp;
    // most photos fit on the first pass and never reach the lower steps.
    for (const quality of [0.92, 0.85, 0.75, 0.65, 0.55]) {
      const blob = await toBlob(canvas, quality);
      if (!blob) break;
      if (blob.size <= MAX_BYTES) {
        return {
          ok: true,
          file: new File([blob], replaceExtension(file.name, 'jpg'), { type: 'image/jpeg' }),
        };
      }
    }

    return { ok: false, messageKey: 'verification.quality.tooLarge' };
  } finally {
    bitmap.close();
  }
}

function createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function toBlob(canvas: OffscreenCanvas | HTMLCanvasElement, quality: number): Promise<Blob | null> {
  if (canvas instanceof HTMLCanvasElement) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  }
  return canvas.convertToBlob({ type: 'image/jpeg', quality });
}

/** Laplacian variance on a downscaled copy. Low variance means few sharp edges. */
function isBlurry(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): boolean {
  const w = Math.min(320, width);
  const h = Math.max(1, Math.round((height / width) * w));

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, width, height).data;
  } catch {
    return false; // tainted canvas or a browser quirk - defer to the server
  }

  const stepX = width / w;
  const stepY = height / h;
  const grey = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (Math.floor(y * stepY) * width + Math.floor(x * stepX)) * 4;
      grey[y * w + x] = 0.299 * data[src] + 0.587 * data[src + 1] + 0.114 * data[src + 2];
    }
  }

  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - w] - grey[i + w];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const variance = sumSq / n - (sum / n) ** 2;
  return variance < 60;
}

const replaceExtension = (name: string, ext: string) => `${name.replace(/\.[^.]+$/, '')}.${ext}`;
