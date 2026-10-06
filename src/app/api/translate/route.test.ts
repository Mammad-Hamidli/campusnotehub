import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const viewer = vi.fn<() => Promise<{ id: string } | null>>(async () => null);
vi.mock('@/lib/auth/session', () => ({ getViewer: () => viewer() }));

type RateLimitResult = { ok: boolean; remaining: number; retryAfterSeconds: number };
const rateLimit = vi.fn<(key: string, identity: unknown) => Promise<RateLimitResult>>(async () => ({
  ok: true,
  remaining: 1,
  retryAfterSeconds: 0,
}));
vi.mock('@/lib/security/ratelimit', () => ({
  rateLimit: (key: string, identity: unknown) => rateLimit(key, identity),
  clientIp: () => '203.0.113.7',
}));

const { POST } = await import('./route');

const post = (body: unknown) =>
  POST(
    new NextRequest('http://localhost/api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

/** A LibreTranslate that answers every piece with `answer` and records request bodies. */
function stubProvider(answer: string) {
  const sent: { source: string; target: string; q: string[] }[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push(body);
    return Response.json({ translatedText: body.q.map(() => answer) });
  });
  return sent;
}

beforeEach(() => {
  process.env.LIBRETRANSLATE_URL = 'https://lt.test';
  viewer.mockResolvedValue(null);
  rateLimit.mockClear();
});

afterEach(() => {
  delete process.env.LIBRETRANSLATE_URL;
  vi.unstubAllGlobals();
});

describe('POST /api/translate', () => {
  it('returns the translation', async () => {
    stubProvider('good luck on the exam');
    const response = await post({ text: 'удачи на экзамене', target: 'en' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ translation: 'good luck on the exam' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('accepts a target alias and sends the canonical code', async () => {
    const sent = stubProvider('你好');
    await post({ text: 'привет друзья', target: 'ch' });
    expect(sent[0].target).toBe('zh');
  });

  it('is open to signed-out readers, limited per address', async () => {
    stubProvider('hello everyone');
    await post({ text: 'всем привет', target: 'en' });
    expect(rateLimit).toHaveBeenCalledWith('translate', { userId: undefined, ip: '203.0.113.7' });
  });

  it('limits a signed-in reader per account', async () => {
    viewer.mockResolvedValue({ id: 'u1' });
    stubProvider('see you all');
    await post({ text: 'всем пока', target: 'en' });
    expect(rateLimit).toHaveBeenCalledWith('translate', { userId: 'u1', ip: '203.0.113.7' });
  });

  it('answers 429 with Retry-After when the bucket is spent, without calling the provider', async () => {
    rateLimit.mockResolvedValueOnce({ ok: false, remaining: 0, retryAfterSeconds: 42 });
    const sent = stubProvider('x');
    const response = await post({ text: 'доброй ночи', target: 'en' });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expect(await response.json()).toEqual({ error: 'feed.translate.errors.quota' });
    expect(sent).toHaveLength(0);
  });

  it('says unavailable, and charges nothing, when no instance is configured', async () => {
    delete process.env.LIBRETRANSLATE_URL;
    const response = await post({ text: 'спасибо', target: 'en' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'feed.translate.errors.unavailable' });
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', '{'],
    ['an unknown target', { text: 'salam', target: 'xx' }],
    ['text longer than a post', { text: 'a'.repeat(2001), target: 'en' }],
    ['no text', { target: 'en' }],
  ])('rejects %s with 400', async (_case, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'feed.translate.errors.failed' });
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it('refuses blank text as empty', async () => {
    const response = await post({ text: '   ', target: 'en' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'feed.translate.errors.empty' });
  });

  it('passes the provider failure on as its locale key', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: 'Slowdown: 30 per 1 minute' }, { status: 429 }));
    const response = await post({ text: 'с днём рождения', target: 'en' });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'feed.translate.errors.quota' });
  });
});
