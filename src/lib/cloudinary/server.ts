import { v2 as cloudinary, type UploadApiOptions, type UploadApiResponse } from 'cloudinary';

/**
 * Cloudinary, server side only.
 *
 * This module holds the API secret. Like src/lib/firebase/admin.core.ts it is
 * imported only by server modules and CLI scripts, and for the same reason it
 * does not import 'server-only': the tsx scheduler reaches it through
 * src/lib/verification/reviewBuffer.ts, and 'server-only' throws outside
 * Next's bundler. The secret is not a NEXT_PUBLIC_* variable, so it is never
 * inlined into a client bundle even by mistake.
 *
 * Cloudinary is the application's only file store: registration documents,
 * post images and note files all live here as `type: 'authenticated'` assets.
 * Firebase Storage is not provisioned for this project, and every write to it
 * failed - which is what broke post image uploads.
 *
 * Configuration, first complete source wins:
 *   1. CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET
 *      (NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME / NEXT_PUBLIC_CLOUDINARY_API_KEY are
 *      accepted for the two public halves, which are identifiers, not secrets)
 *   2. CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>
 */
let configured = false;

export function cloudinaryClient(): typeof cloudinary {
  if (configured) return cloudinary;

  const cloudName =
    process.env.CLOUDINARY_CLOUD_NAME ?? process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY ?? process.env.NEXT_PUBLIC_CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (cloudName && apiKey && apiSecret) {
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
  } else if (process.env.CLOUDINARY_URL) {
    // The SDK parses CLOUDINARY_URL itself on first config().
    cloudinary.config({ secure: true });
  } else {
    throw new Error(
      'Cloudinary is not configured: set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and ' +
        'CLOUDINARY_API_SECRET (or CLOUDINARY_URL).',
    );
  }

  configured = true;
  return cloudinary;
}

/**
 * Signed server-side upload of an in-memory buffer.
 *
 * The SDK signs the request with the API secret here, on the server; the
 * browser never receives a signature or an upload preset it could reuse.
 */
export function uploadBuffer(bytes: Buffer, options: UploadApiOptions): Promise<UploadApiResponse> {
  const client = cloudinaryClient();
  return new Promise((resolve, reject) => {
    const stream = client.uploader.upload_stream(options, (error, result) => {
      if (error || !result) {
        reject(new Error(`Cloudinary upload failed: ${error?.message ?? 'no result'}`));
      } else {
        resolve(result);
      }
    });
    stream.end(bytes);
  });
}

export type AuthenticatedAsset = {
  publicId: string;
  resourceType: 'image' | 'raw';
  version?: number | null;
  format?: string | null;
};

/**
 * Fetches an authenticated asset's ORIGINAL bytes, server-side.
 *
 * Images go through a signed CDN URL. Raw files (PDF, Word) go through a
 * short-lived private download URL on the API host instead: accounts on the
 * free plan refuse CDN delivery of PDFs, and the API download is not subject
 * to that restriction. Neither URL ever reaches the browser.
 */
export async function downloadAuthenticated(asset: AuthenticatedAsset): Promise<Buffer> {
  const client = cloudinaryClient();
  const url =
    asset.resourceType === 'raw'
      ? client.utils.private_download_url(asset.publicId, '', {
          resource_type: 'raw',
          type: 'authenticated',
          expires_at: Math.floor(Date.now() / 1000) + 300,
        })
      : client.url(asset.publicId, {
          resource_type: 'image',
          type: 'authenticated',
          sign_url: true,
          secure: true,
          ...(asset.version ? { version: asset.version } : {}),
          ...(asset.format ? { format: asset.format } : {}),
        });

  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Cloudinary download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Deletes one authenticated asset. A missing asset counts as deleted. */
export async function deleteAuthenticated(
  publicId: string,
  resourceType: 'image' | 'raw',
): Promise<void> {
  const result = await cloudinaryClient().uploader.destroy(publicId, {
    resource_type: resourceType,
    type: 'authenticated',
    invalidate: true,
  });
  if (result.result !== 'ok' && result.result !== 'not found') {
    throw new Error(`Cloudinary delete failed: ${result.result}`);
  }
}
