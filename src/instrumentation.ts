/**
 * Runs once per server instance at startup (Next.js instrumentation hook).
 *
 * Validates configuration so a deployment missing a required secret fails at
 * boot with a list of variable NAMES, instead of failing later inside a
 * request with an unrelated-looking error.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { checkEnvironment } = await import('./server/env-check');
  checkEnvironment();
}
