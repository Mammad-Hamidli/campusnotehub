import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeFirestore } from '@/test/fakeFirestore';

const fake = createFakeFirestore();
vi.mock('@/lib/firebase/admin.core', () => ({ adminDb: () => fake.db }));

const rateLimit = vi.fn(async () => ({ ok: true, remaining: 1, retryAfterSeconds: 0 }));
vi.mock('@/lib/security/ratelimit', () => ({
  rateLimit: (...args: unknown[]) => rateLimit(...(args as [])),
  clientIp: () => '127.0.0.1',
}));

vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session');
  return {
    ...actual,
    requireSession: async () => ({ userId: 'me', viewer: { id: 'me', verificationStatus: 'UNVERIFIED' } }),
  };
});

const { GET } = await import('./route');

function user(id: string, nickname: string, extra: Record<string, unknown> = {}) {
  fake.store.set(`users/${id}`, {
    nickname,
    nicknameLower: nickname.toLowerCase(),
    accountStatus: 'ACTIVE',
    deletedAt: null,
    isVerified: false,
    avatarUrl: null,
    headline: null,
    ...extra,
  });
}

const search = async (q: string) => {
  const response = await GET(new NextRequest(`http://localhost/api/search/users?q=${encodeURIComponent(q)}`));
  return ((await response.json()).users as { nickname: string }[]).map((u) => u.nickname);
};

beforeEach(() => {
  fake.store.clear();
  rateLimit.mockClear();
  user('me', 'aysel_me');
  user('u1', 'Aysel_01', { avatarUrl: '/api/media/a1', showAvatar: 'PRIVATE' });
  user('u2', 'ayshan');
  user('u3', 'bayram');
  user('u4', 'aynur', { accountStatus: 'SUSPENDED' });
  user('u5', 'user12345', { profileIncomplete: true });
  user('u6', 'ayla', { deletedAt: new Date() });
});

describe('GET /api/search/users', () => {
  it('matches the start of the username, case-insensitively, in handle order', async () => {
    expect(await search('AYS')).toEqual(['Aysel_01', 'ayshan']);
    expect(await search('@ay')).toEqual(['Aysel_01', 'ayshan']);
    // A prefix, not a substring: "ram" is inside "bayram" but does not start it.
    expect(await search('ram')).toEqual([]);
  });

  it('leaves out the viewer, hidden accounts and temporary handles', async () => {
    expect(await search('a')).toEqual(['Aysel_01', 'ayshan']);
    expect(await search('user')).toEqual([]);
  });

  it('answers a query no username could match without reading or charging anything', async () => {
    for (const q of ['', '  ', 'a b', 'ays%', 'аys', 'x'.repeat(25)]) expect(await search(q)).toEqual([]);
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it('shows a picture only where the owner lets this viewer see it', async () => {
    const response = await GET(new NextRequest('http://localhost/api/search/users?q=aysel'));
    expect((await response.json()).users).toEqual([
      { id: 'u1', nickname: 'Aysel_01', avatarUrl: null, isVerified: false, headline: null },
    ]);
  });
});

describe('GET /api/search/users pagination', () => {
  const page = async (query: string) => {
    const response = await GET(new NextRequest(`http://localhost/api/search/users?${query}`));
    const body = (await response.json()) as { users: { nickname: string }[]; nextCursor: string | null };
    return { names: body.users.map((u) => u.nickname), next: body.nextCursor };
  };

  beforeEach(() => {
    // 25 visible "zz" handles, with hidden ones interleaved to be skipped.
    for (let i = 0; i < 25; i += 1) user(`z${i}`, `zz${String(i).padStart(2, '0')}`);
    user('zh1', 'zz04x', { accountStatus: 'SUSPENDED' });
    user('zh2', 'zz10x', { deletedAt: new Date() });
  });

  it('returns ten by default, with a cursor while more remain', async () => {
    const first = await page('q=zz');
    expect(first.names).toEqual(Array.from({ length: 10 }, (_, i) => `zz${String(i).padStart(2, '0')}`));
    expect(first.next).toBe('zz09');
  });

  it('walks every visible match exactly once, then stops', async () => {
    const seen: string[] = [];
    let after: string | null = null;
    do {
      const result: { names: string[]; next: string | null } = await page(
        `q=zz&limit=7${after ? `&after=${after}` : ''}`,
      );
      seen.push(...result.names);
      after = result.next;
    } while (after);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen).not.toContain('zz04x');
  });

  it('gives no cursor when everything fits', async () => {
    expect(await page('q=ays')).toEqual({ names: ['Aysel_01', 'ayshan'], next: null });
  });

  it('caps the page size and ignores a cursor outside the prefix', async () => {
    expect((await page('q=zz&limit=500')).names).toHaveLength(25);
    expect(await page('q=zz&after=aaa')).toEqual({ names: [], next: null });
  });
});
