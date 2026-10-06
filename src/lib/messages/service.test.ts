import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore } from '@/test/fakeFirestore';

const fake = createFakeFirestore();
vi.mock('@/lib/firebase/admin.core', () => ({ adminDb: () => fake.db }));

const { sendMessage, respondToRequest, blockUser, unblockUser, loadThread, MAX_REQUEST_MESSAGES } = await import('./service');
const { inboxCounts, listInbox, listMessages, conversationId } = await import('@/lib/firebase/repositories/messages');

const follow = (from: string, to: string) => fake.store.set(`users/${from}/following/${to}`, { userId: to, createdAt: new Date() });
const unfollow = (from: string, to: string) => fake.store.delete(`users/${from}/following/${to}`);
const mutual = (a: string, b: string) => {
  follow(a, b);
  follow(b, a);
};

/** Each send a millisecond after the last, as separate requests would be. */
let clock = Date.UTC(2026, 9, 6, 9, 0);
const send = (from: string, to: string, body = 'hi', allowNewRequest = true) =>
  sendMessage({ senderId: from, recipientId: to, body, allowNewRequest, now: new Date(++clock) });
const row = (user: string, peer: string) => fake.store.get(`users/${user}/inbox/${peer}`);
const conversation = (a: string, b: string) => fake.store.get(`conversations/${conversationId(a, b)}`);
const bodies = async (a: string, b: string) =>
  (await listMessages(conversationId(a, b), { take: 50 })).map((m) => m.body);

beforeEach(() => fake.store.clear());

describe('sendMessage', () => {
  it('delivers straight away between mutual followers', async () => {
    mutual('ana', 'bob');
    const result = await send('ana', 'bob', 'hello', false);

    expect(result).toMatchObject({ ok: true, state: 'OPEN', startedRequest: false, message: { body: 'hello', requestId: null } });
    expect(row('ana', 'bob')).toMatchObject({ state: 'ACTIVE', unread: 0, lastBody: 'hello', lastSenderId: 'ana' });
    expect(row('bob', 'ana')).toMatchObject({ state: 'ACTIVE', unread: 1 });
    expect(await inboxCounts('bob')).toEqual({ unread: 1, requests: 0 });
  });

  it('needs both directions: following one way makes it a request', async () => {
    follow('ana', 'bob');
    expect(await send('ana', 'bob', 'hi', false)).toEqual({ ok: false, reason: 'request_needed' });
    expect(conversation('ana', 'bob')).toBeUndefined();

    const result = await send('ana', 'bob', 'hi');
    expect(result).toMatchObject({ ok: true, state: 'REQUEST_OUT', startedRequest: true });
    expect(row('ana', 'bob')).toMatchObject({ state: 'REQUEST_OUT', unread: 0 });
    expect(row('bob', 'ana')).toMatchObject({ state: 'REQUEST_IN', unread: 1 });
    // A request is counted as a request, not as unread chat.
    expect(await inboxCounts('bob')).toEqual({ unread: 0, requests: 1 });
  });

  it('lets a waiting request hold only a few messages', async () => {
    for (let i = 0; i < MAX_REQUEST_MESSAGES; i++) {
      expect(await send('ana', 'bob', `m${i}`)).toMatchObject({ ok: true, startedRequest: i === 0 });
    }
    expect(await send('ana', 'bob', 'one more')).toEqual({ ok: false, reason: 'request_limit' });
    expect(row('bob', 'ana')).toMatchObject({ unread: MAX_REQUEST_MESSAGES });
  });

  it('treats a reply to a request as accepting it', async () => {
    await send('ana', 'bob', 'hi');
    const reply = await send('bob', 'ana', 'hey', false);
    expect(reply).toMatchObject({ ok: true, state: 'OPEN' });
    expect(conversation('ana', 'bob')).toMatchObject({ request: null, acceptedAt: expect.any(Date) });
    expect(row('ana', 'bob')).toMatchObject({ state: 'ACTIVE', unread: 1 });
    expect(await send('ana', 'bob', 'great', false)).toMatchObject({ ok: true, state: 'OPEN' });
  });

  it('sends a conversation open only through mutual follows back to requests when that ends', async () => {
    mutual('ana', 'bob');
    await send('ana', 'bob', 'old chat');
    unfollow('bob', 'ana');

    expect(await send('ana', 'bob', 'still there?', false)).toEqual({ ok: false, reason: 'request_needed' });
    expect(await loadThread('ana', 'bob')).toMatchObject({ state: 'CLOSED', mutual: false });
  });
});

describe('respondToRequest', () => {
  it('accept opens the conversation for good, whatever the follow graph does later', async () => {
    await send('ana', 'bob', 'hi');
    expect(await respondToRequest({ userId: 'bob', peerId: 'ana', action: 'accept' })).toBe('accepted');

    expect(row('bob', 'ana')).toMatchObject({ state: 'ACTIVE' });
    expect(row('ana', 'bob')).toMatchObject({ state: 'ACTIVE' });
    expect(await send('ana', 'bob', 'thanks', false)).toMatchObject({ ok: true, state: 'OPEN' });
    expect(await send('bob', 'ana', 'np', false)).toMatchObject({ ok: true, state: 'OPEN' });
    expect(await bodies('ana', 'bob')).toEqual(['hi', 'thanks', 'np']);
  });

  it('reject removes the request and its messages from both sides; the sender may ask again', async () => {
    await send('ana', 'bob', 'hi');
    await send('ana', 'bob', 'please');
    expect(await respondToRequest({ userId: 'bob', peerId: 'ana', action: 'reject' })).toBe('rejected');

    expect(conversation('ana', 'bob')).toBeUndefined();
    expect(row('bob', 'ana')).toBeUndefined();
    expect(row('ana', 'bob')).toBeUndefined();
    expect(await bodies('ana', 'bob')).toEqual([]);
    expect(await send('ana', 'bob', 'again')).toMatchObject({ ok: true, startedRequest: true });
  });

  it('reject keeps earlier history and drops only the request', async () => {
    mutual('ana', 'bob');
    await send('ana', 'bob', 'old chat');
    unfollow('bob', 'ana');
    await send('ana', 'bob', 'new request');

    await respondToRequest({ userId: 'bob', peerId: 'ana', action: 'reject' });
    expect(await bodies('ana', 'bob')).toEqual(['old chat']);
    expect(conversation('ana', 'bob')).toMatchObject({ request: null });
  });

  it('only the recipient can answer, and only once', async () => {
    await send('ana', 'bob', 'hi');
    expect(await respondToRequest({ userId: 'ana', peerId: 'bob', action: 'accept' })).toBe('missing');
    expect(await respondToRequest({ userId: 'carl', peerId: 'ana', action: 'accept' })).toBe('missing');
    expect(await respondToRequest({ userId: 'bob', peerId: 'ana', action: 'reject' })).toBe('rejected');
    expect(await respondToRequest({ userId: 'bob', peerId: 'ana', action: 'accept' })).toBe('missing');
  });
});

describe('blocking', () => {
  it('drops the pending request and stops every later message, even between mutual followers', async () => {
    await send('ana', 'bob', 'hi');
    await blockUser({ userId: 'bob', peerId: 'ana' });

    expect(row('bob', 'ana')).toBeUndefined();
    expect(await bodies('ana', 'bob')).toEqual([]);
    mutual('ana', 'bob');
    expect(await send('ana', 'bob', 'hello?')).toEqual({ ok: false, reason: 'unavailable' });
    expect(await send('bob', 'ana', 'oops')).toEqual({ ok: false, reason: 'you_blocked' });
    expect(await respondToRequest({ userId: 'bob', peerId: 'ana', action: 'accept' })).toBe('missing');
    expect(await loadThread('ana', 'bob')).toMatchObject({ blockedMe: true, blockedByMe: false });
    expect(await loadThread('bob', 'ana')).toMatchObject({ blockedMe: false, blockedByMe: true });
  });

  it('hides an open conversation from the blocker only, and unblocking lets messages through again', async () => {
    mutual('ana', 'bob');
    await send('ana', 'bob', 'hi');
    await blockUser({ userId: 'bob', peerId: 'ana' });
    // Idempotent.
    await blockUser({ userId: 'bob', peerId: 'ana' });

    expect(row('bob', 'ana')).toBeUndefined();
    expect(row('ana', 'bob')).toMatchObject({ state: 'ACTIVE' });
    expect(await bodies('ana', 'bob')).toEqual(['hi']);

    await unblockUser('bob', 'ana');
    expect(await send('ana', 'bob', 'back', false)).toMatchObject({ ok: true, state: 'OPEN' });
    expect(row('bob', 'ana')).toMatchObject({ state: 'ACTIVE', unread: 1, lastBody: 'back' });
  });
});

describe('inbox', () => {
  it('lists the most recent conversation first and sums unread over open ones only', async () => {
    mutual('ana', 'bob');
    mutual('ana', 'dan');
    await sendMessage({ senderId: 'bob', recipientId: 'ana', body: '1', allowNewRequest: false, now: new Date('2026-10-06T10:00:00Z') });
    await sendMessage({ senderId: 'bob', recipientId: 'ana', body: '2', allowNewRequest: false, now: new Date('2026-10-06T10:01:00Z') });
    await sendMessage({ senderId: 'carl', recipientId: 'ana', body: 'req', allowNewRequest: true, now: new Date('2026-10-06T10:02:00Z') });
    await sendMessage({ senderId: 'dan', recipientId: 'ana', body: 'yo', allowNewRequest: false, now: new Date('2026-10-06T09:00:00Z') });

    expect((await listInbox('ana')).map((r) => [r.peerId, r.state, r.unread])).toEqual([
      ['carl', 'REQUEST_IN', 1],
      ['bob', 'ACTIVE', 2],
      ['dan', 'ACTIVE', 1],
    ]);
    expect(await inboxCounts('ana')).toEqual({ unread: 3, requests: 1 });
  });

  it('pages messages oldest-first, newest page by default', async () => {
    mutual('ana', 'bob');
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 10, minute));
    for (let minute = 0; minute < 5; minute++) {
      await sendMessage({ senderId: 'ana', recipientId: 'bob', body: `m${minute}`, allowNewRequest: false, now: at(minute) });
    }
    const id = conversationId('ana', 'bob');
    expect((await listMessages(id, { take: 2 })).map((m) => m.body)).toEqual(['m3', 'm4']);
    expect((await listMessages(id, { before: at(3), take: 2 })).map((m) => m.body)).toEqual(['m1', 'm2']);
    expect((await listMessages(id, { after: at(2), take: 10 })).map((m) => m.body)).toEqual(['m3', 'm4']);
  });
});
