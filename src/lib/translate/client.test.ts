import { afterEach, describe, expect, it, vi } from 'vitest';
import { translateText } from './client';
import { TranslationError } from './errors';

/** One canned reply per call, in order. */
function stubReplies(...replies: (Response | Error)[]) {
  const fetch = vi.fn();
  for (const reply of replies) {
    if (reply instanceof Error) fetch.mockRejectedValueOnce(reply);
    else fetch.mockResolvedValueOnce(reply);
  }
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(TranslationError);
  return (error as TranslationError).code;
}

afterEach(() => vi.unstubAllGlobals());

describe('translateText', () => {
  it('POSTs the trimmed text to /api/translate and caches the answer for the tab', async () => {
    const fetch = stubReplies(Response.json({ translation: 'hello friends' }));
    await expect(translateText('  salam dostlar ', 'en')).resolves.toBe('hello friends');
    await expect(translateText('salam dostlar', 'en')).resolves.toBe('hello friends');

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/translate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ text: 'salam dostlar', target: 'en' });
  });

  it('throws the locale key the API sent', async () => {
    stubReplies(Response.json({ error: 'feed.translate.errors.sameLanguage' }, { status: 422 }));
    expect(await codeOf(translateText('already english', 'en'))).toBe('sameLanguage');
  });

  it.each([
    [429, 'quota'],
    [502, 'unavailable'],
    [504, 'unavailable'],
    [400, 'failed'],
  ] as const)('falls back on the status when there is no usable key: %i', async (status, code) => {
    stubReplies(new Response('<html>error</html>', { status }));
    expect(await codeOf(translateText(`status ${status}`, 'en'))).toBe(code);
  });

  it('ignores error keys that are not translation errors', async () => {
    stubReplies(Response.json({ error: 'errors.sessionExpired' }, { status: 401 }));
    expect(await codeOf(translateText('who am i', 'en'))).toBe('failed');
  });

  it('reports a network failure as unavailable, and lets an abort through', async () => {
    stubReplies(new TypeError('Failed to fetch'));
    expect(await codeOf(translateText('offline', 'en'))).toBe('unavailable');

    const abort = new DOMException('aborted', 'AbortError');
    stubReplies(abort);
    await expect(translateText('aborted', 'en')).rejects.toBe(abort);
  });

  it('refuses blank text without a request', async () => {
    const fetch = stubReplies();
    expect(await codeOf(translateText('   ', 'en'))).toBe('empty');
    expect(fetch).not.toHaveBeenCalled();
  });
});
