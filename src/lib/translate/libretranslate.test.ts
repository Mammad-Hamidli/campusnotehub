import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { TranslationError } from './errors';
import { echoRatio, libreTranslateConfig, splitForTranslation, translatePost } from './libretranslate';

const CONFIG = { endpoint: 'https://lt.test/translate', apiKey: null };

type Sent = { q: string[]; source: string; target: string; format: string; api_key?: string };

/**
 * Answers like LibreTranslate: `translate` maps each piece (undefined echoes it
 * back), and `auto` requests report `detected`. Records every request body.
 */
function stubProvider(translate: (q: string, source: string) => string | undefined, detected = 'en') {
  const sent: Sent[] = [];
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Sent;
    urls.push(url);
    sent.push(body);
    return Response.json({
      translatedText: body.q.map((q) => translate(q, body.source) ?? q),
      ...(body.source === 'auto'
        ? { detectedLanguage: body.q.map(() => ({ language: detected, confidence: 90 })) }
        : {}),
    });
  });
  return { sent, urls, asked: () => sent.map((body) => `${body.source}|${body.target} ${body.q.join(' / ')}`) };
}

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

const failure = (status: number, error?: string) => Response.json(error ? { error } : {}, { status });

/** The TranslationError code a promise rejects with. */
async function codeOf(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(TranslationError);
  return (error as TranslationError).code;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('libreTranslateConfig', () => {
  it.each([
    ['http://localhost:5000', 'http://localhost:5000/translate'],
    ['https://libretranslate.com/', 'https://libretranslate.com/translate'],
    ['https://example.org/lt', 'https://example.org/lt/translate'],
    ['https://example.org/lt/translate', 'https://example.org/lt/translate'],
    ['  https://lt.example.org//  ', 'https://lt.example.org/translate'],
  ])('%s -> %s', (url, endpoint) => {
    expect(libreTranslateConfig({ LIBRETRANSLATE_URL: url })).toEqual({ endpoint, apiKey: null });
  });

  it.each([undefined, '', '   ', 'not a url', 'ftp://lt.example.org'])('is off without a usable URL: %j', (url) => {
    expect(libreTranslateConfig({ LIBRETRANSLATE_URL: url })).toBeNull();
  });

  it('reads the optional API key', () => {
    expect(libreTranslateConfig({ LIBRETRANSLATE_URL: 'https://lt.test', LIBRETRANSLATE_API_KEY: ' k1 ' })?.apiKey).toBe('k1');
    expect(libreTranslateConfig({ LIBRETRANSLATE_URL: 'https://lt.test', LIBRETRANSLATE_API_KEY: ' ' })?.apiKey).toBeNull();
  });
});

describe('translatePost requests', () => {
  it('POSTs a text-format batch to the configured endpoint, with the key when there is one', async () => {
    const provider = stubProvider(() => 'see you tomorrow');
    await translatePost('до завтра', 'en', { endpoint: 'https://lt.test/translate', apiKey: 'k1' });
    expect(provider.urls).toEqual(['https://lt.test/translate']);
    expect(provider.sent).toEqual([{ q: ['до завтра'], source: 'ru', target: 'en', format: 'text', api_key: 'k1' }]);
  });

  it('sends no api_key field when none is configured', async () => {
    const provider = stubProvider(() => 'good morning');
    await translatePost('доброе утро', 'en', CONFIG);
    expect(provider.sent[0]).not.toHaveProperty('api_key');
  });
});

describe('translatePost source language', () => {
  it('names Azerbaijani as the source instead of letting the provider guess Indonesian', async () => {
    const provider = stubProvider((_q, source) => (source === 'az' ? 'hello friend' : 'salutation dostum'));
    await expect(translatePost('salam dostum', 'en', CONFIG)).resolves.toBe('hello friend');
    expect(provider.asked()).toEqual(['az|en salam dostum']);
  });

  it('sends ASCII-typed Azerbaijani with its proper spelling', async () => {
    const provider = stubProvider(() => 'как дела, брат');
    await expect(translatePost('necesen qardas', 'ru', CONFIG)).resolves.toBe('как дела, брат');
    expect(provider.asked()).toEqual(['az|ru necəsən qardaş']);
  });

  it('asks auto for a second opinion when the detected source is mostly echoed back', async () => {
    const provider = stubProvider(
      (_q, source) => (source === 'az' ? 'derse gelirsen tomorrow?' : 'are you coming to class tomorrow?'),
      'tr',
    );
    await expect(translatePost('sabah derse gelirsen?', 'en', CONFIG)).resolves.toBe('are you coming to class tomorrow?');
    expect(provider.asked().map((line) => line.split(' ')[0])).toEqual(['az|en', 'auto|en']);
  });

  it('keeps the first answer when the second opinion is no better', async () => {
    const provider = stubProvider((_q, source) => (source === 'az' ? 'salam dostum brother' : undefined), 'az');
    await expect(translatePost('salam dostum qardaş', 'en', CONFIG)).resolves.toBe('salam dostum brother');
    expect(provider.sent).toHaveLength(2);
  });

  it('falls back to auto when the instance has no model for the detected source', async () => {
    const fetch = stubReplies(
      failure(400, 'az is not supported'),
      Response.json({ translatedText: ['thank you'], detectedLanguage: [{ language: 'tr', confidence: 70 }] }),
    );
    await expect(translatePost('təşəkkürlər', 'en', CONFIG)).resolves.toBe('thank you');
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body).source)).toEqual(['az', 'auto']);
  });

  it('never skips the provider when the detected source equals the target', async () => {
    const provider = stubProvider(() => undefined, 'az');
    expect(await codeOf(translatePost('salam dostum', 'az', CONFIG))).toBe('sameLanguage');
    expect(provider.asked()).toEqual(['auto|az salam dostum']);
  });

  it('folds ISO codes like zh-Hans before comparing with the target', async () => {
    stubProvider(() => undefined, 'zh-Hans');
    expect(await codeOf(translatePost('你好朋友', 'zh', CONFIG))).toBe('sameLanguage');
  });

  it('reads "not available as a target language from <the target>" as the same language', async () => {
    stubReplies(failure(400, 'English (en) is not available as a target language from English (en)'));
    expect(await codeOf(translatePost('lorem ipsum dolor', 'en', CONFIG))).toBe('sameLanguage');
  });
});

describe('translatePost pieces', () => {
  it('translates a long post in one batch and keeps its paragraphs', async () => {
    const paragraph = 'Bu gün dərs var. '.repeat(40).trim();
    const text = `${paragraph}\n\n${paragraph}`;
    const provider = stubProvider((q) => q.replace(/Bu gün dərs var/g, 'There is class today'));

    const translated = await translatePost(text, 'en', CONFIG);

    expect(translated).toBe(text.replace(/Bu gün dərs var/g, 'There is class today'));
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].q.length).toBeGreaterThan(1);
  });

  it('answers a repeated request from memory', async () => {
    const provider = stubProvider(() => 'see you in class');
    await translatePost('увидимся на паре', 'en', CONFIG);
    await translatePost('увидимся на паре', 'en', CONFIG);
    expect(provider.sent).toHaveLength(1);
  });

  it('refuses blank text without a request', async () => {
    const provider = stubProvider(() => 'x');
    expect(await codeOf(translatePost('  \n ', 'en', CONFIG))).toBe('empty');
    expect(provider.sent).toHaveLength(0);
  });
});

describe('translatePost errors', () => {
  it.each([
    ['the instance is rate limiting', failure(429, 'Slowdown: 30 per 1 minute'), 'quota'],
    ['the key is wrong', failure(403, 'Invalid API key'), 'unavailable'],
    ['the key is missing', failure(400, 'Visit https://portal.libretranslate.com to get an API key'), 'unavailable'],
    ['the text is over the instance cap', failure(400, 'Invalid request: request (1200) exceeds text limit (500)'), 'failed'],
    ['the engine failed', failure(500, 'Cannot translate text'), 'failed'],
    ['the instance is down', new Response('<html>Bad gateway</html>', { status: 502 }), 'unavailable'],
    ['the reply is not the expected shape', Response.json({ translatedText: 'not an array' }), 'failed'],
    ['a piece came back empty', Response.json({ translatedText: ['  '] }), 'failed'],
  ])('%s', async (_case, reply, code) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubReplies(reply);
    expect(await codeOf(translatePost('привет всем', 'en', CONFIG))).toBe(code);
  });

  it('reports a network failure or timeout as unavailable', async () => {
    stubReplies(new TypeError('fetch failed'));
    expect(await codeOf(translatePost('пока всем', 'en', CONFIG))).toBe('unavailable');
  });

  it('logs a refused key for the operator', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubReplies(failure(403, 'Invalid API key'));
    await translatePost('всем спасибо', 'en', CONFIG).catch(() => undefined);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Invalid API key'));
  });
});

describe('echoRatio', () => {
  it('counts source words that came back untouched', () => {
    expect(echoRatio('salam dostum', 'salutation dostum')).toBe(0.5);
    expect(echoRatio('salam dostum', 'hello friend')).toBe(0);
  });
});

const rejoin = (text: string, max?: number) =>
  splitForTranslation(text, max)
    .map((p) => p.lead + p.text + p.trail)
    .join('');

describe('splitForTranslation', () => {
  it('keeps a short post in one piece', () => {
    expect(splitForTranslation('Salam dostlar!')).toEqual([{ lead: '', text: 'Salam dostlar!', trail: '' }]);
  });

  it.each([
    'One. Two! Three?\n\nFour...ok',
    '...leading punctuation and trailing space   ',
    `${'word '.repeat(200)}end.`,
    `${'x'.repeat(1200)}`,
  ])('reproduces the input exactly and respects the cap: %#', (text) => {
    expect(rejoin(text, 100)).toBe(text);
    for (const piece of splitForTranslation(text, 100)) expect(piece.text.length).toBeLessThanOrEqual(100);
  });
});
