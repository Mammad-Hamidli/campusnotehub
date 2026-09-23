/**
 * Public site links shared by server and client code.
 *
 * Mentors apply on their own subdomain; the main app only links out to it.
 * NEXT_PUBLIC_ so the value is inlined into client bundles at build time.
 */
export const MENTORS_URL = process.env.NEXT_PUBLIC_MENTORS_URL?.trim() || 'https://mentors.campusnotehub.com';
