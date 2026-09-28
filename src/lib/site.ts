/**
 * Public site paths shared by server and client code.
 */

/**
 * Mentor signup, in THIS app. It used to be a link out to
 * mentors.campusnotehub.com, a separate site that was never built; that host
 * now redirects here (src/middleware.ts). The flow has to live on the main
 * host anyway: the session cookies are host-only, so an account created on
 * the subdomain could not have signed anyone in to the app.
 */
export const MENTOR_JOIN_PATH = '/mentors/join';

/** The mentor panel: onboarding checklist, fee reminder, sessions. */
export const MENTOR_DASHBOARD_PATH = '/mentors/dashboard';

/** Redirects to the current Windows installer (src/app/download/windows/route.ts). */
export const WINDOWS_DOWNLOAD_PATH = '/download/windows';
