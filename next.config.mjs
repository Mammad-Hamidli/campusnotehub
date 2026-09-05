/**
 * Security headers.
 *
 * The registration flow handles national ID images, so a single injected
 * script is a reportable data breach. CSP itself is set per-request in
 * middleware.ts with a nonce plus `strict-dynamic`, rather than a host
 * allowlist here - allowlists degrade silently every time someone adds a CDN.
 */
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-site' },
  {
    key: 'Permissions-Policy',
    // camera=(self) because the document capture flow uses getUserMedia.
    value: 'camera=(self), microphone=(), geolocation=(), payment=(), browsing-topics=()',
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'cdn.campushub.az' },
      { protocol: 'https', hostname: 'campushub-public.s3.eu-central-1.amazonaws.com' },
    ],
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  // Uploads never pass through a Server Action; they go straight to S3 with a
  // presigned POST, so the body limit stays small on purpose.
  experimental: { serverActions: { bodySizeLimit: '1mb' } },
};

export default nextConfig;
