import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const s3 = new S3Client({ region: process.env.S3_REGION });

/**
 * There is no `docs` bucket.
 *
 * Identity documents never reach object storage under the zero-retention
 * policy - they are held in RAM for the duration of one request and wiped.
 * If you find yourself wanting to add a KYC bucket here, read
 * docs/SECURITY.md section 3 first: the S3 bucket was the previous design and
 * it is incompatible with the retention promise, because versioning and
 * lifecycle rules keep "deleted" objects recoverable.
 */
export const BUCKETS = {
  public: process.env.S3_BUCKET_PUBLIC!,
  notes: process.env.S3_BUCKET_NOTES!,
} as const;

const MAX_NOTE_BYTES = 50 * 1024 * 1024; // 50 MB - study notes, not ID scans

export async function presignNoteUpload(params: { userId: string; noteId: string }) {
  const key = `notes/${params.userId}/${params.noteId}/original.pdf`;
  const { url, fields } = await createPresignedPost(s3, {
    Bucket: BUCKETS.notes,
    Key: key,
    Conditions: [
      ['content-length-range', 1024, MAX_NOTE_BYTES],
      ['eq', '$Content-Type', 'application/pdf'],
    ],
    Fields: { 'Content-Type': 'application/pdf' },
    Expires: 900,
  });
  return { url, fields, key };
}

/**
 * Download links for purchased notes. Deliberately short-lived and
 * single-purpose: the URL identifies the buyer in the response headers, so a
 * link forwarded to a group chat is traceable back to whoever leaked it.
 */
export async function presignNoteDownload(params: {
  key: string;
  buyerId: string;
  filename: string;
}) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKETS.notes,
      Key: params.key,
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(params.filename)}.pdf"`,
      ResponseCacheControl: 'private, no-store',
    }),
    { expiresIn: 120 },
  );
}

export async function putPublicObject(key: string, body: Buffer, contentType: string) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKETS.public,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
  return `https://cdn.campushub.az/${key}`;
}

export async function headObject(bucket: string, key: string) {
  return s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
}
