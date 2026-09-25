'use client';

import {
  Download,
  FileImage,
  FileSpreadsheet,
  FileText,
  Lock,
  Presentation,
  type LucideIcon,
} from 'lucide-react';

/**
 * One attached file: type icon, name, size, download link.
 *
 * Rendered wherever a note appears. The download always points at
 * /api/notes/:id/file rather than at a storage URL, because that route is
 * where the "may this person read this file" decision is made - seller,
 * paying buyer, free published note, or staff. A direct storage link would
 * bypass all of it.
 */

const ICON_FOR: { match: (mime: string) => boolean; icon: LucideIcon; label: string }[] = [
  { match: (m) => m === 'application/pdf', icon: FileText, label: 'PDF' },
  { match: (m) => m.includes('word'), icon: FileText, label: 'DOC' },
  { match: (m) => m.includes('sheet') || m.includes('excel'), icon: FileSpreadsheet, label: 'XLS' },
  { match: (m) => m.includes('presentation') || m.includes('powerpoint'), icon: Presentation, label: 'PPT' },
  { match: (m) => m.startsWith('image/'), icon: FileImage, label: 'IMG' },
];

function describe(mime: string) {
  return ICON_FOR.find((entry) => entry.match(mime)) ?? { icon: FileText, label: 'FILE' };
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FileChip({
  noteId,
  fileName,
  mime,
  sizeBytes,
  downloadLabel,
  locked = false,
  lockedLabel,
}: {
  noteId: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  downloadLabel: string;
  /** Signed out: no link is rendered at all (the route would 401 anyway). */
  locked?: boolean;
  lockedLabel?: string;
}) {
  const { icon: Icon, label } = describe(mime);

  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-edge bg-surface-muted p-2.5">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-edge bg-surface"
        aria-hidden="true"
      >
        <Icon className="h-4 w-4 text-fg-muted" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg" title={fileName}>
          {fileName}
        </span>
        <span className="text-2xs text-fg-subtle">
          {label} · {humanSize(sizeBytes)}
        </span>
      </span>

      {locked ? (
        <span className="inline-flex shrink-0 items-center gap-1 px-2 py-1 text-2xs text-fg-subtle">
          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
          {lockedLabel}
        </span>
      ) : (
        <a
          href={`/api/notes/${noteId}/file`}
          className="btn-secondary shrink-0 px-2 py-1 text-2xs"
          // The server sets Content-Disposition: attachment; this only supplies
          // a sensible default name if the browser asks where to save it.
          download={fileName}
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          {downloadLabel}
        </a>
      )}
    </div>
  );
}
