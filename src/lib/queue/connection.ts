import IORedis from 'ioredis';

/**
 * Lazy Redis connection shared by every producer.
 *
 * Constructing `new IORedis(...)` at module scope opens a socket the moment
 * the module is evaluated. That is wrong in three separate places:
 *
 *  - `next build` evaluates route modules while collecting page data, so the
 *    build tries to dial Redis and fills the log with connection errors on any
 *    machine without a local server.
 *  - In serverless, every cold start opens a connection even for requests that
 *    never enqueue anything.
 *  - Tests importing a route for its handler get a live socket as a side
 *    effect, and then hang on teardown.
 *
 * A getter defers all of that to the first actual enqueue.
 */
let connection: IORedis | null = null;

/**
 * ioredis emits 'error' on every failed connection attempt. With no listener
 * attached it falls back to printing
 *   [ioredis] Unhandled error event: AggregateError ... internalConnectMultiple
 * for each one — roughly 2.5 times a second against a dead server, which is
 * what buried the actual failure in noise.
 *
 * This listener exists to make that failure READABLE, not to suppress it. The
 * throttle collapses repeats of the SAME error code and always reports how many
 * attempts it covered, so a persistent outage is still obvious in the log; a
 * new error code always prints immediately. Recovery is logged too, because
 * "did it come back?" was previously unanswerable from the log alone.
 */
const RESTATE_AFTER_MS = 30_000;
let lastCode: string | null = null;
let lastLoggedAt = 0;
let suppressed = 0;

function attachDiagnostics(client: IORedis): void {
  client.on('error', (error: NodeJS.ErrnoException) => {
    const code = error.code ?? error.name ?? 'UNKNOWN';
    const now = Date.now();

    if (code === lastCode && now - lastLoggedAt < RESTATE_AFTER_MS) {
      suppressed++;
      return;
    }

    const repeat = suppressed > 0 ? ` (+${suppressed} identical in the last ${Math.round((now - lastLoggedAt) / 1000)}s)` : '';
    // ECONNREFUSED here almost always means the server is simply not running.
    // Say so, rather than leaving a bare AggregateError stack.
    const hint =
      code === 'ECONNREFUSED'
        ? ` — nothing is accepting connections at ${process.env.REDIS_URL ?? 'redis://localhost:6379'}; is Redis running?`
        : '';
    // AggregateError from a multi-address dial carries an empty message, so
    // only include the separator when there is something to separate.
    const detail = error.message ? `: ${error.message}` : '';
    console.error(`[redis] ${code}${detail}${hint}${repeat}`);

    lastCode = code;
    lastLoggedAt = now;
    suppressed = 0;
  });

  client.on('ready', () => {
    if (lastCode) console.error('[redis] connection restored');
    lastCode = null;
    suppressed = 0;
  });
}

export function getRedis(): IORedis {
  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null, // required by BullMQ
      enableOfflineQueue: true,
      lazyConnect: true,
    });
    attachDiagnostics(connection);
  }
  return connection;
}
