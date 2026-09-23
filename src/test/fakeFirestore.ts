/**
 * A minimal in-memory Firestore for repository tests: documents, equality
 * queries with limit(), and transactions whose writes apply after the
 * callback returns (as Firestore's do). No contention retries - atomicity is
 * Firestore's guarantee; what tests check is that the code puts each check and
 * its write in one transaction.
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

  function query(collection: string, filters: [string, unknown][] = [], max = Infinity) {
    const run = () => {
      const docs = [...store.keys()]
        .filter((p) => p.startsWith(`${collection}/`) && p.split('/').length === 2)
        .filter((p) => filters.every(([f, v]) => store.get(p)![f] === v))
        .slice(0, max)
        .map(snapshot);
      return { empty: docs.length === 0, size: docs.length, docs };
    };
    return {
      __query: true as const,
      run,
      where: (field: string, _op: '==', value: unknown) => query(collection, [...filters, [field, value]], max),
      limit: (n: number) => query(collection, filters, n),
      get: async () => run(),
    };
  }

  const db = {
    collection: (name: string) => ({
      doc: (id?: string) => docRef(`${name}/${id ?? `auto${++autoId}`}`),
      where: (field: string, op: '==', value: unknown) => query(name).where(field, op, value),
    }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const writes: (() => void)[] = [];
      const tx = {
        get: async (target: Ref | ReturnType<typeof query>) =>
          '__query' in target ? target.run() : snapshot(target.path),
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
