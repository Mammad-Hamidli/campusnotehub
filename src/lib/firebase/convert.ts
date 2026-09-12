import { Timestamp, type DocumentSnapshot, type QueryDocumentSnapshot } from 'firebase-admin/firestore';

/**
 * Firestore <-> application value conversion.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * Prisma hands back JavaScript `Date` objects. Firestore hands back its own
 * `Timestamp` class. Every existing consumer in this codebase calls
 * `.toISOString()`, compares with `<`, or feeds the value to `formatDateTime` -
 * and a Timestamp supports none of that. Without a conversion layer the
 * migration would be a thousand small breakages, each surfacing at runtime as
 * "createdAt.toISOString is not a function".
 *
 * So every document that leaves this layer has already been walked and had its
 * Timestamps turned back into Dates. The API contract the frontend sees is
 * therefore byte-identical to what Prisma produced, which is the whole point:
 * no route handler, serialiser or component had to learn that the database
 * changed.
 *
 * The conversion is recursive because Firestore documents nest - `post.media`
 * is an array of objects each carrying their own dates.
 */

/** Recursively turns Firestore Timestamps into Dates. */
export function fromFirestore<T = Record<string, unknown>>(value: unknown): T {
  if (value === null || value === undefined) return value as T;

  if (value instanceof Timestamp) return value.toDate() as T;

  if (Array.isArray(value)) return value.map((item) => fromFirestore(item)) as T;

  // Plain objects only. A Buffer or a Date must pass through untouched, and
  // `constructor === Object` is what distinguishes a data object from an
  // instance of some class.
  if (typeof value === 'object' && (value as object).constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = fromFirestore(nested);
    }
    return out as T;
  }

  return value as T;
}

/**
 * Turns a snapshot into `{ id, ...data }` with Dates restored.
 *
 * The id is spread FIRST so a document that happens to carry an `id` field of
 * its own does not shadow the real document id - which would silently break
 * every foreign key that reads it back.
 */
export function docToObject<T = Record<string, unknown>>(
  snap: DocumentSnapshot | QueryDocumentSnapshot,
): (T & { id: string }) | null {
  if (!snap.exists) return null;
  const data = fromFirestore<Record<string, unknown>>(snap.data() ?? {});
  return { ...data, id: snap.id } as T & { id: string };
}

/** Same, for a whole query result. */
export function docsToObjects<T = Record<string, unknown>>(
  snaps: (DocumentSnapshot | QueryDocumentSnapshot)[],
): (T & { id: string })[] {
  return snaps
    .map((snap) => docToObject<T>(snap))
    .filter((row): row is T & { id: string } => row !== null);
}

/**
 * Strips `undefined` before a write.
 *
 * Firestore rejects `undefined` outright. The Admin SDK is configured with
 * `ignoreUndefinedProperties`, which handles the top level, but an undefined
 * nested inside an array element still throws - so writes go through here.
 *
 * `null` is preserved deliberately: in this schema a null is a real, queryable
 * absence ("never verified", "not frozen") and collapsing it to a missing
 * field would break `where('deletedAt', '==', null)`.
 */
export function forFirestore<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Sorts in memory.
 *
 * Firestore cannot order by a field it did not filter on without a composite
 * index, and it cannot order by two fields in opposite directions at all. For
 * the small, already-bounded result sets in this application (a page of 20
 * posts, 50 comments) sorting the page after the fact is cheaper than
 * maintaining an index per sort combination - and it keeps the ordering
 * identical to what the SQL `ORDER BY` produced.
 *
 * This is NOT a licence to fetch a whole collection and filter in JS. The
 * query still does the filtering and the limiting; only the final ordering of
 * an already-small page happens here.
 */
export function sortBy<T>(
  rows: T[],
  key: keyof T,
  direction: 'asc' | 'desc' = 'asc',
): T[] {
  return [...rows].sort((a, b) => {
    const left = a[key];
    const right = b[key];
    if (left === right) return 0;
    if (left === null || left === undefined) return direction === 'asc' ? -1 : 1;
    if (right === null || right === undefined) return direction === 'asc' ? 1 : -1;

    const comparison =
      left instanceof Date && right instanceof Date
        ? left.getTime() - right.getTime()
        : typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left).localeCompare(String(right));

    return direction === 'asc' ? comparison : -comparison;
  });
}
