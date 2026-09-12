/**
 * Study-note upload validation.
 *
 * This is the notes counterpart to src/lib/verification/fileValidation.ts and
 * follows the same rule that module states in its header: the client's
 * `file.type` is a string the browser copies from the extension, and an
 * attacker sets it to whatever they like. Everything below is decided from the
 * BYTES.
 *
 * Renaming payload.exe to notes.pdf therefore does not get you anywhere: the
 * sniffer reads the first bytes, finds `MZ`, matches no allowed signature, and
 * the upload is refused. The extension is never consulted for the decision -
 * it is only cross-checked afterwards so a mismatch is reported honestly.
 */

/**
 * 50 MB.
 *
 * Chosen against what a real academic note actually weighs: a scanned
 * semester's lecture notes at 300dpi runs 20-40 MB, and a slide deck with
 * embedded diagrams is comfortably over 10 MB. A 5 or 10 MB cap - the usual
 * reflex - would reject exactly the thorough, hand-annotated material the
 * marketplace exists to sell, while doing nothing about abuse, since ten 5 MB
 * uploads cost the same as one 50 MB upload.
 *
 * The ceiling is enforced three times, and only the last one is a control:
 * the browser checks it for instant feedback, the route rejects an oversized
 * Content-Length before reading the body, and the route re-checks the ACTUAL
 * parsed byte length. A client-declared size is a claim, not a measurement.
 *
 * Exported so the upload form can state the limit in the UI rather than
 * hardcoding a second number that drifts from this one.
 */
// 10 MB: Cloudinary's per-file limit for raw uploads on the account's plan.
// Accepting more here would only fail after the upload finished.
export const MAX_NOTE_BYTES = 10 * 1024 * 1024;
export const MAX_NOTE_MB = MAX_NOTE_BYTES / (1024 * 1024);
export const MIN_NOTE_BYTES = 256; // below this it is not a document

/**
 * Plain text is the exception to the minimum.
 *
 * A genuine set of notes can easily be a few hundred bytes of text, and the
 * 256-byte floor exists to catch truncated binaries rather than short files.
 * Applying it to .txt would reject legitimate uploads.
 */
export const MIN_TEXT_BYTES = 16;

export const ALLOWED_NOTE_MIME = [
  'application/pdf',
  // Office Open XML (docx / xlsx / pptx)
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Legacy binary Office (doc / xls / ppt)
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  // Canva and similar design tools export these
  'image/png',
  'image/jpeg',
  // Plain text: the format a lot of code-heavy and maths-heavy notes are
  // actually written in. It carries no macro or active-content risk at all,
  // which is why it needs no counterpart to the PDF /JavaScript check below -
  // but it DOES need the script-signature check, since a .txt whose first
  // bytes are `<?php` is a text file only by extension.
  'text/plain',
] as const;

export type AllowedNoteMime = (typeof ALLOWED_NOTE_MIME)[number];

export type NoteFileRejection =
  | 'FILE_EMPTY'
  | 'FILE_TOO_SMALL'
  | 'FILE_TOO_LARGE'
  | 'MIME_NOT_ALLOWED'
  | 'MIME_MISMATCH'
  | 'EXTENSION_MISMATCH'
  | 'EXECUTABLE_REJECTED'
  | 'ARCHIVE_NOT_OFFICE'
  | 'PDF_ACTIVE_CONTENT';

export type NoteFileResult =
  | { ok: true; mime: AllowedNoteMime; extension: string }
  | { ok: false; reason: NoteFileRejection };

const startsWith = (buffer: Buffer, bytes: number[], offset = 0) =>
  bytes.every((b, i) => buffer[offset + i] === b);

/**
 * Executable and script signatures, refused before anything else.
 *
 * This list is belt-and-braces: the allow-list below would reject all of these
 * anyway by simply not matching. It exists so the REASON is accurate - an
 * operator reading "executable rejected" in a log learns something that
 * "unsupported type" hides.
 */
const EXECUTABLE_SIGNATURES: { label: string; bytes: number[] }[] = [
  { label: 'PE/EXE/DLL', bytes: [0x4d, 0x5a] }, // MZ
  { label: 'ELF', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { label: 'Mach-O 64', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { label: 'Mach-O 32', bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { label: 'Java class', bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { label: 'shebang', bytes: [0x23, 0x21] }, // #!
  { label: 'MS-DOS COM/BAT heuristic', bytes: [0x40, 0x65, 0x63, 0x68, 0x6f] }, // @echo
];

/** `<?php`, and a lone `<script` at the very start of a file. */
function looksLikeScript(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 64).toString('latin1').toLowerCase().trimStart();
  return head.startsWith('<?php') || head.startsWith('<script') || head.startsWith('<%');
}

/**
 * Plain text has NO magic bytes, so it cannot be sniffed like every other type
 * here - it has to be recognised by what it does NOT contain.
 *
 * The rule: a file is text if the bytes decode as UTF-8 and carry no control
 * characters other than tab, newline and carriage return. That is deliberately
 * strict rather than "mostly printable":
 *
 *   - a NUL byte is the single most reliable binary marker, and any format
 *     that reaches this point unrecognised and contains one is not a document;
 *   - decoding through TextDecoder with fatal:true rejects invalid UTF-8, so a
 *     binary blob that happens to avoid control bytes still fails;
 *   - the executable and script signature checks have ALREADY run by the time
 *     this is consulted, so a .txt beginning `<?php` or `#!` was refused
 *     earlier and cannot be smuggled through as "just text".
 *
 * A BOM is tolerated because Windows editors write one and it is not content.
 */
function looksLikeText(buffer: Buffer): boolean {
  // Strip a UTF-8 BOM before decoding; it is metadata, not a control byte.
  const body =
    buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      ? buffer.subarray(3)
      : buffer;

  if (body.length === 0) return false;

  try {
    // fatal: true makes an invalid sequence throw rather than yield U+FFFD,
    // which is what stops arbitrary binary being read as lossy "text".
    new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return false;
  }

  for (const byte of body) {
    // Allow tab (0x09), LF (0x0a), CR (0x0d). Reject every other C0 control
    // and DEL. Bytes >= 0x80 are already validated as UTF-8 above.
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte < 0x20 || byte === 0x7f) return false;
  }

  return true;
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * docx/xlsx/pptx are ZIP containers, so the magic bytes alone cannot tell them
 * apart from any other ZIP - including a renamed .jar or a zip bomb full of
 * scripts. The OOXML content type is declared inside `[Content_Types].xml`,
 * which OOXML writers place at the very start of the archive, so the marker is
 * reliably inside the first few kilobytes without unzipping anything.
 *
 * A ZIP that carries no OOXML marker is refused rather than guessed at.
 */
function sniffOoxml(buffer: Buffer): AllowedNoteMime | null {
  const head = buffer.subarray(0, 8192).toString('latin1');
  if (!head.includes('[Content_Types].xml')) return null;
  if (head.includes('word/')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (head.includes('xl/')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (head.includes('ppt/')) {
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }
  return null;
}

/**
 * Legacy Office files share one OLE2 container signature, so doc/xls/ppt are
 * indistinguishable from the header alone. The declared type is used only to
 * choose between the three, and only after the container itself is confirmed -
 * a lie there gets you a different legacy Office MIME, never a script.
 */
function sniffOle2(declared: string): AllowedNoteMime {
  if (declared.includes('excel') || declared.includes('spreadsheet')) return 'application/vnd.ms-excel';
  if (declared.includes('powerpoint') || declared.includes('presentation')) return 'application/vnd.ms-powerpoint';
  return 'application/msword';
}

const EXTENSION_FOR: Record<AllowedNoteMime, string[]> = {
  'application/pdf': ['pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/msword': ['doc'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.ms-powerpoint': ['ppt'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  // md and csv are plain text in every respect that matters here; refusing
  // them while accepting .txt would be arbitrary.
  'text/plain': ['txt', 'md', 'csv'],
};

/** The accept= attribute for the file input, derived from the same table. */
export const ACCEPT_ATTRIBUTE = [
  ...ALLOWED_NOTE_MIME,
  ...Object.values(EXTENSION_FOR).flat().map((ext) => `.${ext}`),
].join(',');

export function validateNoteFile(
  buffer: Buffer,
  declaredMime: string,
  fileName: string,
): NoteFileResult {
  if (buffer.length === 0) return { ok: false, reason: 'FILE_EMPTY' };
  if (buffer.length > MAX_NOTE_BYTES) return { ok: false, reason: 'FILE_TOO_LARGE' };
  /**
   * The 256-byte floor exists to catch truncated binaries, and applying it to
   * plain text would reject legitimate short notes - a page of formulae is
   * genuinely a few hundred bytes. Text gets the lower MIN_TEXT_BYTES floor;
   * everything else keeps the original one. The extension is only a HINT for
   * choosing the floor - the real type decision is still made from the bytes.
   */
  const extension = (fileName.split('.').pop() ?? '').toLowerCase();
  const textLike = ['txt', 'md', 'csv'].includes(extension);
  const floor = textLike ? MIN_TEXT_BYTES : MIN_NOTE_BYTES;
  if (buffer.length < floor) return { ok: false, reason: 'FILE_TOO_SMALL' };

  // Refused first so the reported reason is the accurate one.
  for (const signature of EXECUTABLE_SIGNATURES) {
    if (startsWith(buffer, signature.bytes)) return { ok: false, reason: 'EXECUTABLE_REJECTED' };
  }
  if (looksLikeScript(buffer)) return { ok: false, reason: 'EXECUTABLE_REJECTED' };

  const declared = (declaredMime || '').toLowerCase();
  let mime: AllowedNoteMime | null = null;

  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    // %PDF-
    mime = 'application/pdf';
    /**
     * Reuses the reasoning already applied to KYC PDFs: /JavaScript and
     * /Launch turn a "document" into something that executes on open. A study
     * note has no legitimate need for either.
     */
    const body = buffer.toString('latin1');
    if (/\/JavaScript\b|\/JS\b|\/Launch\b|\/EmbeddedFile\b|\/OpenAction\b/.test(body)) {
      return { ok: false, reason: 'PDF_ACTIVE_CONTENT' };
    }
  } else if (startsWith(buffer, ZIP_MAGIC)) {
    mime = sniffOoxml(buffer);
    if (!mime) return { ok: false, reason: 'ARCHIVE_NOT_OFFICE' };
  } else if (startsWith(buffer, OLE2_MAGIC)) {
    mime = sniffOle2(declared);
  } else if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    mime = 'image/png';
  } else if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    mime = 'image/jpeg';
  } else if (looksLikeText(buffer)) {
    /**
     * LAST, deliberately.
     *
     * Text is recognised by exclusion, so it must only be reached once every
     * signature-based branch above has declined - otherwise a format whose
     * header happens to be printable ASCII would be classified as text rather
     * than identified properly or refused.
     */
    mime = 'text/plain';
  }

  if (!mime) return { ok: false, reason: 'MIME_NOT_ALLOWED' };

  // The client's claim is not trusted, but a mismatch is still worth refusing:
  // it means the browser and the bytes disagree, which is either a broken
  // client or a deliberate attempt.
  if (declared && declared !== mime && !(mime === 'image/jpeg' && declared === 'image/jpg')) {
    const legacyOle = ['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint'];
    /**
     * Browsers disagree about the type of a .md or .csv file - Chrome sends
     * text/markdown or text/csv, Firefox often sends an empty string, and some
     * send application/octet-stream. All of them are the same bytes, and the
     * BYTES are what decided this is text, so a disagreement about the label
     * is not evidence of anything.
     */
    const textish =
      mime === 'text/plain' &&
      (declared.startsWith('text/') || declared === 'application/octet-stream');

    if (!textish && !(legacyOle.includes(mime) && legacyOle.includes(declared))) {
      return { ok: false, reason: 'MIME_MISMATCH' };
    }
  }

  if (!EXTENSION_FOR[mime].includes(extension)) {
    return { ok: false, reason: 'EXTENSION_MISMATCH' };
  }

  return { ok: true, mime, extension };
}

/** Locale keys, so a rejection tells the uploader what to actually do. */
export const REJECTION_KEY: Record<NoteFileRejection, string> = {
  FILE_EMPTY: 'notes.upload.errors.empty',
  FILE_TOO_SMALL: 'notes.upload.errors.tooSmall',
  FILE_TOO_LARGE: 'notes.upload.errors.tooLarge',
  MIME_NOT_ALLOWED: 'notes.upload.errors.typeNotAllowed',
  MIME_MISMATCH: 'notes.upload.errors.mimeMismatch',
  EXTENSION_MISMATCH: 'notes.upload.errors.extensionMismatch',
  EXECUTABLE_REJECTED: 'notes.upload.errors.executable',
  ARCHIVE_NOT_OFFICE: 'notes.upload.errors.archiveNotOffice',
  PDF_ACTIVE_CONTENT: 'notes.upload.errors.pdfUnsafe',
};

/**
 * The UniNotes UPLOAD policy: PDF and Word only (.pdf, .doc, .docx).
 *
 * validateNoteFile() above still recognises more formats - it decides what a
 * file IS from its bytes - and this list decides what may be uploaded.
 * Keeping them separate means existing notes in other formats still download.
 */
export const NOTE_UPLOAD_MIME: readonly AllowedNoteMime[] = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

export const NOTE_UPLOAD_ACCEPT = [...NOTE_UPLOAD_MIME, '.pdf', '.doc', '.docx'].join(',');
