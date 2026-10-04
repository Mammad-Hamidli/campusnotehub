import { after } from 'next/server';

/**
 * Work that must not delay the response but must still finish: post-commit
 * emails, a Google call the user should not wait for.
 *
 * Inside a request, after() keeps the serverless invocation alive until the
 * task settles - a bare floating promise is frozen with the function on
 * Vercel and silently never completes. Outside one (the scheduler worker,
 * scripts, tests) after() throws, and the task simply runs in the background.
 * Never rejects: failures are logged under `label`.
 */
export function afterResponse(label: string, task: () => Promise<unknown>): void {
  const run = () => task().catch((error) => console.error(`[${label}] background task failed`, error));
  try {
    after(run);
  } catch {
    void run();
  }
}
