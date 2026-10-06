/**
 * A minimal in-memory Firestore for repository tests: documents and
 * subcollections, queries (==, in, and ranges; Dates compare by instant) with
 * orderBy(), limit(), select() and count(), and transactions whose writes
 * apply after the callback returns (as Firestore's do). No contention retries
 * - atomicity is Firestore's guarantee; what tests check is that the code puts
 * each check and its write in one transaction.
 */
type Data = Record<string, unknown>;

export function createFakeFirestore() {
  const store = new Map<string, Data>();
  let autoId = 0;

  const snapshot = (path: string) => {
    const data = store.get(path);
    return {
      exists: !!data,
      id: path.split('/').pop()!,
      ref: docRef(path),
      data: () => (data ? structuredClone(data) : undefined),
      get: (field: string) => data?.[field],
    };
  };

  function docRef(path: string) {
    return {
      path,
      id: path.split('/').pop()!,
      get: async () => snapshot(path),
      delete: async () => void store.delete(path),
      set: async (data: Data) => void store.set(path, structuredClone(data)),
      update: async (data: Data) => void store.set(path, { ...store.get(path)!, ...structuredClone(data) }),
      create: async (data: Data) => {
        if (store.has(path)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
        store.set(path, structuredClone(data));
      },
    };
  }
  type Ref = ReturnType<typeof docRef>;

  type Op = '==' | 'in' | '<' | '<=' | '>' | '>=';
  /** Dates compare by instant, as Firestore Timestamps do. */
  const comparable = (v: unknown) => (v instanceof Date ? v.getTime() : v) as number | string;
  function matches(actual: unknown, op: Op, expected: unknown): boolean {
    if (op === '==') return comparable(actual) === comparable(expected);
    if (op === 'in') return (expected as unknown[]).some((v) => comparable(v) === comparable(actual));
    if (actual === undefined || actual === null) return false;
    const [a, b] = [comparable(actual), comparable(expected)];
    return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
  }

  type Order = [field: string, direction: 'asc' | 'desc'];

  function query(collection: string, filters: [string, Op, unknown][] = [], max = Infinity, orders: Order[] = []) {
    // Direct children only: `users/u1/inbox` holds `users/u1/inbox/x`, not deeper paths.
    const depth = collection.split('/').length + 1;
    const run = () => {
      let paths = [...store.keys()]
        .filter((p) => p.startsWith(`${collection}/`) && p.split('/').length === depth)
        .filter((p) => filters.every(([f, op, v]) => matches(store.get(p)![f], op, v)));
      if (orders.length > 0) {
        paths = paths.sort((x, y) => {
          for (const [field, direction] of orders) {
            const [a, b] = [comparable(store.get(x)![field]), comparable(store.get(y)![field])];
            if (a !== b) return (a < b ? -1 : 1) * (direction === 'desc' ? -1 : 1);
          }
          return 0;
        });
      }
      const docs = paths.slice(0, max).map(snapshot);
      return { empty: docs.length === 0, size: docs.length, docs };
    };
    const self = {
      __query: true as const,
      run,
      where: (field: string, op: Op, value: unknown) => query(collection, [...filters, [field, op, value]], max, orders),
      orderBy: (field: string, direction: 'asc' | 'desc' = 'asc') =>
        query(collection, filters, max, [...orders, [field, direction]]),
      limit: (n: number) => query(collection, filters, n, orders),
      /** Projection is a cost optimisation; the fake returns whole documents. */
      select: () => self,
      count: () => ({ get: async () => ({ data: () => ({ count: run().size }) }) }),
      get: async () => run(),
    };
    return self;
  }

  const db = {
    collection: (name: string) => ({
      doc: (id?: string) => docRef(`${name}/${id ?? `auto${++autoId}`}`),
      add: async (data: Data) => {
        const ref = docRef(`${name}/auto${++autoId}`);
        await ref.set(data);
        return ref;
      },
      where: (field: string, op: Op, value: unknown) => query(name).where(field, op, value),
      orderBy: (field: string, direction: 'asc' | 'desc' = 'asc') => query(name).orderBy(field, direction),
      limit: (n: number) => query(name).limit(n),
      count: () => query(name).count(),
      get: async () => query(name).run(),
    }),
    /** Batched point reads, in argument order; a missing document is `exists: false`. */
    getAll: async (...refs: Ref[]) => refs.map((r) => snapshot(r.path)),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const writes: (() => void)[] = [];
      const tx = {
        get: async (target: Ref | ReturnType<typeof query>) =>
          '__query' in target ? target.run() : snapshot(target.path),
        getAll: async (...refs: Ref[]) => refs.map((r) => snapshot(r.path)),
        update: (r: Ref, d: Data) => writes.push(() => store.set(r.path, { ...store.get(r.path)!, ...structuredClone(d) })),
        set: (r: Ref, d: Data) => writes.push(() => store.set(r.path, structuredClone(d))),
        delete: (r: Ref) => writes.push(() => store.delete(r.path)),
        create: (r: Ref, d: Data) =>
          writes.push(() => {
            if (store.has(r.path)) throw new Error('ALREADY_EXISTS');
            store.set(r.path, structuredClone(d));
          }),
      };
      const result = await fn(tx);
      for (const write of writes) write();
      return result;
    },
    batch: () => {
      const writes: (() => void)[] = [];
      return {
        update: (r: Ref, d: Data) => writes.push(() => store.set(r.path, { ...store.get(r.path)!, ...structuredClone(d) })),
        set: (r: Ref, d: Data) => writes.push(() => store.set(r.path, structuredClone(d))),
        delete: (r: Ref) => writes.push(() => store.delete(r.path)),
        commit: async () => {
          for (const write of writes) write();
        },
      };
    },
  };

  return { db, store };
}
