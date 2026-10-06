import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeFirestore } from '@/test/fakeFirestore';

const fake = createFakeFirestore();
vi.mock('@/lib/firebase/admin.core', () => ({ adminDb: () => fake.db }));

const quota = { 'messages:send': true, 'messages:request': true } as Record<string, boolean>;
const charged: string[] = [];
vi.mock('@/lib/security/ratelimit', () => ({
  clientIp: () => '127.0.0.1',
  rateLimit: async (key: string) => {
    charged.push(key);
    return { ok: quota[key] ?? true, remaining: 0, retryAfterSeconds: 60 };
  },
}));

let viewer: Record<string, unknown> = {};
vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session');
  return { ...actual, requireSession: async () => ({ userId: viewer.id, viewer }) };
});

const { GET, POST } = await import('./route');
const { POST: RESPOND } = await import('./respond/route');

const as = (id: string, extra: Record<string, unknown> = {}) => {
  viewer = { id, role: 'STUDENT', accountStatus: 'ACTIVE', verificationStatus: 'UNVERIFIED', ...extra };
};
const user = (id: string, extra: Record<string, unknown> = {}) =>
  fake.store.set(`users/${id}`, {
    nickname: `nick_${id}`,
    nicknameLower: `nick_${id}`,
    accountStatus: 'ACTIVE',
    deletedAt: null,
    isVerified: true,
    avatarUrl: null,
    ...extra,
  });
const follow = (from: string, to: string) => fake.store.set(`users/${from}/following/${to}`, { userId: to });
const params = (peerId: string) => ({ params: Promise.resolve({ peerId }) });

const post = (peerId: string, body: unknown) =>
  POST(
    new NextRequest(`http://localhost/api/messages/${peerId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(peerId),
  );
const thread = async (peerId: string) =>
  (await GET(new NextRequest(`http://localhost/api/messages/${peerId}`), params(peerId))).json();
const respond = (peerId: string, action: string) =>
  RESPOND(
    new NextRequest(`http://localhost/api/messages/${peerId}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    }),
    params(peerId),
  );

beforeEach(() => {
  fake.store.clear();
  charged.length = 0;
  quota['messages:send'] = true;
  quota['messages:request'] = true;
  user('ana');
  user('bob');
});

describe('POST /api/messages/:peerId', () => {
  it('delivers between mutual followers without touching the request quota', async () => {
    follow('ana', 'bob');
    follow('bob', 'ana');
    as('ana');
    const response = await post('bob', { body: '  hello  ' });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ state: 'OPEN', message: { body: 'hello', fromMe: true } });
    expect(charged).toEqual(['messages:send']);
  });

  it('spends the request quota only when a message starts a request', async () => {
    as('ana');
    expect(await (await post('bob', { body: 'hi' })).json()).toMatchObject({ state: 'REQUEST_OUT' });
    expect(charged).toEqual(['messages:send', 'messages:request']);

    charged.length = 0;
    await post('bob', { body: 'second' });
    expect(charged).toEqual(['messages:send']);

    quota['messages:request'] = false;
    user('carl');
    const refused = await post('carl', { body: 'hi' });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'messages.errors.requestQuota' });
  });

  it('refuses view-only accounts, empty or oversized messages, and accounts that cannot be messaged', async () => {
    as('ana', { profileIncomplete: true });
    expect((await post('bob', { body: 'hi' })).status).toBe(403);

    as('ana');
    expect((await post('bob', { body: '   ' })).status).toBe(400);
    expect((await post('bob', { body: 'x'.repeat(2001) })).status).toBe(400);
    expect((await post('ana', { body: 'me' })).status).toBe(404);
    user('gone', { deletedAt: new Date() });
    expect((await post('gone', { body: 'hi' })).status).toBe(404);
    expect((await post('../users', { body: 'hi' })).status).toBe(404);
  });

  it('reports a block by the recipient as unavailable, never as a block', async () => {
    as('bob');
    await respond('ana', 'block');
    as('ana');
    const response = await post('bob', { body: 'hi' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'messages.errors.unavailable' });
    expect(await thread('bob')).toMatchObject({ canSend: false, reason: 'messages.errors.unavailable', blockedByMe: false });
  });
});

describe('GET /api/messages/:peerId', () => {
  it('shows the recipient a request with its messages, and marks it read', async () => {
    as('ana');
    await post('bob', { body: 'hi' });
    expect(await thread('bob')).toMatchObject({ state: 'REQUEST_OUT', asRequest: true, canSend: true, requestRoom: 2 });

    as('bob');
    expect(fake.store.get('users/bob/inbox/ana')).toMatchObject({ unread: 1 });
    const body = await thread('ana');
    expect(body).toMatchObject({ state: 'REQUEST_IN', peer: { id: 'ana', nickname: 'nick_ana' } });
    expect(body.messages.map((m: { body: string; fromMe: boolean }) => [m.body, m.fromMe])).toEqual([['hi', false]]);
    expect(fake.store.get('users/bob/inbox/ana')).toMatchObject({ unread: 0 });
  });

  it('stops the sender at the request cap until the request is answered', async () => {
    as('ana');
    for (const body of ['1', '2', '3']) expect((await post('bob', { body })).status).toBe(201);
    expect((await post('bob', { body: '4' })).status).toBe(429);
    expect(await thread('bob')).toMatchObject({ canSend: false, reason: 'messages.errors.requestLimit', requestRoom: 0 });

    as('bob');
    expect((await respond('ana', 'accept')).status).toBe(200);
    expect((await respond('ana', 'accept')).status).toBe(404);
    as('ana');
    expect(await thread('bob')).toMatchObject({ state: 'OPEN', canSend: true, asRequest: false });
  });
});
