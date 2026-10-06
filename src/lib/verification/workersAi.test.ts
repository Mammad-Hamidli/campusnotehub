import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runVisionModel, VISION_MODEL, WorkersAiStopError } from './workersAi';

/**
 * The Workers AI client's one real job besides the request: telling "out of
 * neurons for today" apart from "down" and "misconfigured", because each of
 * those stops the nightly batch for a different reason.
 */

const fetchMock = vi.fn();
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const call = () => runVisionModel({ system: 'sys', prompt: 'extract', jpeg });

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (status: number, code: number) => reply(status, { success: false, errors: [{ code, message: 'x' }] });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'acc123');
  vi.stubEnv('CLOUDFLARE_AI_API_TOKEN', 'tok');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  fetchMock.mockReset();
});

async function stopReason(promise: Promise<unknown>) {
  const error = await promise.catch((e) => e);
  expect(error).toBeInstanceOf(WorkersAiStopError);
  return (error as WorkersAiStopError).reason;
}

describe('runVisionModel', () => {
  it('posts the image as a data URI to the account run endpoint and returns the text', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { success: true, result: { response: '{"a":1}' } }));
    await expect(call()).resolves.toBe('{"a":1}');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/${VISION_MODEL}`);
    expect(init.headers.authorization).toBe('Bearer tok');
    const body = JSON.parse(init.body);
    expect(body.image).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'extract' },
    ]);
    expect(body.temperature).toBe(0);
  });

  it('accepts a response the API already parsed as JSON', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { success: true, result: { response: { a: 1 } } }));
    await expect(call()).resolves.toBe('{"a":1}');
  });

  it('stops for QUOTA on the daily neuron limit (3036), and on any other 429', async () => {
    fetchMock.mockResolvedValueOnce(failure(429, 3036));
    expect(await stopReason(call())).toBe('QUOTA');
    fetchMock.mockResolvedValueOnce(reply(429, {}));
    expect(await stopReason(call())).toBe('QUOTA');
    expect(fetchMock).toHaveBeenCalledTimes(2); // no retries spent on a spent quota
  });

  it('stops for CONFIG when the Llama licence was not accepted (5016) or the token is refused', async () => {
    fetchMock.mockResolvedValueOnce(failure(403, 5016));
    const error = await call().catch((e) => e);
    expect(error.reason).toBe('CONFIG');
    expect(error.message).toMatch(/agree/);

    fetchMock.mockResolvedValueOnce(failure(401, 10000));
    expect(await stopReason(call())).toBe('CONFIG');
  });

  it('stops for CONFIG without calling out when the env is missing', async () => {
    vi.stubEnv('CLOUDFLARE_AI_API_TOKEN', '');
    expect(await stopReason(call())).toBe('CONFIG');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries capacity errors (3040) and then gives up as UNAVAILABLE', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => failure(429, 3040));
    const pending = stopReason(call());
    await vi.runAllTimersAsync();
    expect(await pending).toBe('UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('recovers when capacity frees up during a retry', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(failure(429, 3040))
      .mockResolvedValueOnce(reply(200, { success: true, result: { response: 'ok' } }));
    const pending = call();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe('ok');
  });

  it('stops for UNAVAILABLE on 5xx and on network failure', async () => {
    fetchMock.mockResolvedValueOnce(reply(502, {}));
    expect(await stopReason(call())).toBe('UNAVAILABLE');
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await stopReason(call())).toBe('UNAVAILABLE');
  });
});
