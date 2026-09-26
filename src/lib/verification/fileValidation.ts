/**
 * File validation for identity-document uploads.
 *
 * Everything here runs on the SERVER against the actual bytes. The client also
 * checks, but a client check is a courtesy to honest users and nothing more:
 * `file.type` is a string the browser copies from the file extension, and an
 * attacker sets it to whatever they like.
 */

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB, per the spec
export const MAX_TOTAL_BYTES = 4 * MAX_UPLOAD_BYTES;

export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export type AllowedMime = (typeof ALLOWED_MIME)[number];

export type ValidationFailure =
  | 'FILE_TOO_LARGE'
  | 'FILE_EMPTY'
  | 'MIME_NOT_ALLOWED'
  | 'MIME_MISMATCH'
  | 'PDF_ACTIVE_CONTENT'
  | 'PDF_ENCRYPTED'
  | 'IMAGE_DIMENSIONS_INVALID'
  | 'POLYGLOT_FILE';

export type ValidationResult =
  | { ok: true; mime: AllowedMime; bytes: number }
  | { ok: false; reason: ValidationFailure };

/**
 * Magic-byte signatures. Content type is derived from the bytes, never from
 * the client's Content-Type header or the filename.
 */
const SIGNATURES: { mime: AllowedMime; magic: number[]; offset: number }[] = [
  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff], offset: 0 },
  { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0 },
  { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d], offset: 0 }, // %PDF-
];

function sniff(buffer: Buffer): AllowedMime | null {
  for (const sig of SIGNATURES) {
    const slice = buffer.subarray(sig.offset, sig.offset + sig.magic.length);
    if (slice.length === sig.magic.length && sig.magic.every((b, i) => slice[i] === b)) {
      return sig.mime;
    }
  }
  return null;
}

/**
 * Validates one uploaded document.
 *
 * @param buffer          the complete file, already size-capped by the stream reader
 * @param declaredMime    what the client claimed; used only to detect a mismatch
 */
export function validateDocument(buffer: Buffer, declaredMime: string): ValidationResult {
  if (buffer.length === 0) return { ok: false, reason: 'FILE_EMPTY' };
  if (buffer.length > MAX_UPLOAD_BYTES) return { ok: false, reason: 'FILE_TOO_LARGE' };

  const actual = sniff(buffer);
  if (!actual) return { ok: false, reason: 'MIME_NOT_ALLOWED' };

  // A mismatch is not automatically fatal (browsers mislabel HEIC as JPEG
  // often enough), but it is logged as a signal. What matters is that we
  // proceed on `actual`, never on `declared`.
  if (declaredMime !== actual && !declaredMime.startsWith('image/')) {
    return { ok: false, reason: 'MIME_MISMATCH' };
  }

  if (actual === 'application/pdf') {
    const pdfCheck = validatePdf(buffer);
    if (!pdfCheck.ok) return pdfCheck;
  } else {
    const imageCheck = validateImageHeader(buffer, actual);
    if (!imageCheck.ok) return imageCheck;
  }

  // Polyglot check: a file that is a valid JPEG *and* a valid ZIP/PHP payload.
  // Cheap heuristic - look for a second file signature well inside the body.
  if (isPolyglot(buffer)) return { ok: false, reason: 'POLYGLOT_FILE' };

  return { ok: true, mime: actual, bytes: buffer.length };
}

/**
 * PDFs are the highest-risk format we accept, and we accept them only because
 * some students photograph their card with a scanner app that outputs PDF.
 *
 * A PDF is a scripting environment: it can carry JavaScript, launch actions,
 * embedded files, and remote references that fire when a moderator opens it.
 * Rather than trying to sanitise, the pipeline RASTERISES every PDF to a
 * bitmap immediately and discards the original - so this function only has to
 * reject the cases that are dangerous to rasterise or obviously hostile.
 */
function validatePdf(buffer: Buffer): ValidationResult {
  // Scan as latin1 so byte offsets line up with the raw file.
  const text = buffer.toString('latin1');

  if (/\/Encrypt\s/.test(text)) {
    return { ok: false, reason: 'PDF_ENCRYPTED' };
  }

  const activeContent = [
    /\/JavaScript\s/,
    /\/JS\s*[[(<]/,
    /\/Launch\s/,
    /\/EmbeddedFile\s/,
    /\/OpenAction\s/,
    /\/AA\s*<</, // additional-actions dictionary
    /\/RichMedia\s/,
    /\/XFA\s/,
  ];
  if (activeContent.some((pattern) => pattern.test(text))) {
    return { ok: false, reason: 'PDF_ACTIVE_CONTENT' };
  }

  return { ok: true, mime: 'application/pdf', bytes: buffer.length };
}

/**
 * Reads dimensions straight out of the header without decoding the image.
 *
 * Two things this stops before any decoder touches the file:
 *  - decompression bombs: a 40000x40000 PNG is a few KB on disk and ~6 GB in
 *    memory once expanded, which is a one-request OOM kill of the pipeline;
 *  - documents too small to carry legible text, which waste an OCR pass.
 */
function validateImageHeader(buffer: Buffer, mime: AllowedMime): ValidationResult {
  const dims = mime === 'image/png' ? pngDimensions(buffer) : jpegDimensions(buffer);
  if (!dims) return { ok: false, reason: 'IMAGE_DIMENSIONS_INVALID' };

  const { width, height } = dims;
  const MIN_EDGE = 600;
  const MAX_EDGE = 12000;
  const MAX_PIXELS = 50_000_000; // ~200 MB decoded at 4 bytes/px

  if (width < MIN_EDGE && height < MIN_EDGE) {
    return { ok: false, reason: 'IMAGE_DIMENSIONS_INVALID' };
  }
  if (width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
    return { ok: false, reason: 'IMAGE_DIMENSIONS_INVALID' };
  }

  return { ok: true, mime, bytes: buffer.length };
}

function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  // IHDR is always the first chunk: 8-byte signature, 4-byte length,
  // 4-byte type, then width and height as big-endian uint32.
  if (buffer.length < 24) return null;
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2; // skip SOI
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    const segmentLength = buffer.readUInt16BE(offset + 2);

    // SOF0..SOF15, excluding DHT (0xc4), JPG (0xc8) and DAC (0xcc).
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isStartOfFrame) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

/** Detects a second container signature embedded past the header. */
function isPolyglot(buffer: Buffer): boolean {
  const suspicious = [
    Buffer.from('PK\x03\x04', 'latin1'), // ZIP / OOXML / JAR
    Buffer.from('<?php', 'latin1'),
    Buffer.from('<script', 'latin1'),
    Buffer.from('<!DOCTYPE html', 'latin1'),
  ];
  // Skip the first 64 bytes: a legitimate header cannot contain these, and
  // scanning from 0 would false-positive on the format's own magic.
  const body = buffer.subarray(64);
  return suspicious.some((needle) => body.includes(needle));
}

/**
 * Overwrites buffers before releasing them.
 *
 * Node will not zero freed memory, and a heap snapshot taken after a crash can
 * still contain a national ID scan sitting in a reclaimed-but-not-overwritten
 * page. Zeroing is cheap and makes the retention claim true at the process
 * level, not just the storage level.
 */
export function wipe(buffer: Buffer): void {
  buffer.fill(0);
}

