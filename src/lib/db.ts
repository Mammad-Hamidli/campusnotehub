import { PrismaClient } from '@prisma/client';

/**
 * Two clients on purpose.
 *
 * `db` runs as `campushub_app`, a role that has no SELECT grant on the
 * ciphertext columns of verification_documents and no UPDATE/DELETE on
 * audit_logs. Anything the web request handlers do goes through it.
 *
 * `vaultDb` runs as `campushub_verifier` and exists only inside the
 * verification worker process, which is deployed separately and is not
 * reachable from the internet. This is the difference between "a web RCE
 * leaks national ID scans" and "a web RCE does not".
 */
const makeClient = (url: string | undefined) =>
  new PrismaClient({
    datasources: url ? { db: { url } } : undefined,
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'warn', 'error']
        : ['warn', 'error'],
  });

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? makeClient(process.env.DATABASE_URL);

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;

/** Only import this from `src/server/queue/*`. Throws if used in the web tier. */
export function getVaultDb(): PrismaClient {
  if (process.env.CAMPUSHUB_TIER !== 'worker') {
    throw new Error('vaultDb is worker-tier only');
  }
  return makeClient(process.env.VAULT_DATABASE_URL);
}
