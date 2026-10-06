/**
 * Cloudflare Workers AI, over its REST API - the vision model that reads
 * identity documents for the nightly verification batch
 * (src/lib/verification/aiQueue.ts).
 *
 * Server-only. CLOUDFLARE_AI_API_TOKEN must never reach the browser, and the
 * images it is sent with are identity documents.
 *
 * ---------------------------------------------------------------------------
 * ERRORS: WHAT STOPS THE BATCH AND WHAT DOES NOT
 * ---------------------------------------------------------------------------
 * Every failure here is about US (quota, outage, configuration), never about
 * the document, so every one of them throws WorkersAiStopError and the batch
 * stops with the case still queued. Treating one as a verdict would flag an
 * honest student for our outage, and skipping past it would break FIFO.
 *
 *   QUOTA        429 / code 3036 "used up your daily free allocation of 10,000
 *                neurons" - or any other 429 that is not 3040. Resets at
 *                00:00 UTC; the next nightly run resumes.
 *   UNAVAILABLE  3040 "capacity temporarily exceeded" after retries, 5xx,
 *                timeouts, network errors, an unreadable envelope.
 *   CONFIG       missing env, 401/403 - including 5016, "User has not agreed
 *                to Llama3.2 model terms". Accepting Meta's licence is the
 *                account owner's decision, so this module never sends the
 *                "agree" prompt itself; see .env.example.
 *
 * Reference: https://developers.cloudflare.com/workers-ai/platform/errors/
 */

export const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

const REQUEST_TIMEOUT_MS = 60_000;
/** 3040 is transient by definition; two short waits, then give up for the night. */
const CAPACITY_RETRIES = 2;

export type WorkersAiStopReason = 'QUOTA' | 'UNAVAILABLE' | 'CONFIG';

export class WorkersAiStopError extends Error {
  constructor(
    readonly reason: WorkersAiStopReason,
    message: string,
  ) {
    super(message);
    this.name = 'WorkersAiStopError';
  }
}

export function workersAiConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.CLOUDFLARE_ACCOUNT_ID?.trim() && env.CLOUDFLARE_AI_API_TOKEN?.trim());
}

type Envelope = {
  success?: boolean;
  result?: { response?: unknown } | null;
  errors?: { code?: number; message?: string }[];
};

/**
 * Runs the vision model on one JPEG and returns the raw text it produced.
 *
 * The response is the model's reading of an identity document: the caller
 * keeps it in memory, parses it, and lets it go. It is never logged here, and
 * error messages carry status and error codes only.
 */
export async function runVisionModel(input: {
  system: string;
  prompt: string;
  jpeg: Buffer;
  maxTokens?: number;
}): Promise<string> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_AI_API_TOKEN?.trim();
  if (!accountId || !token) {
    throw new WorkersAiStopError('CONFIG', 'CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_AI_API_TOKEN are not set');
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${VISION_MODEL}`;
  const body = JSON.stringify({
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.prompt },
    ],
    image: `data:image/jpeg;base64,${input.jpeg.toString('base64')}`,
    max_tokens: input.maxTokens ?? 512,
    // Transcription, not writing: the least creative setting there is.
    temperature: 0,
  });

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown';
      throw new WorkersAiStopError('UNAVAILABLE', `Workers AI unreachable (${reason})`);
    }

    const envelope = (await response.json().catch(() => null)) as Envelope | null;
    const codes = (envelope?.errors ?? []).map((e) => e.code).filter((c): c is number => typeof c === 'number');

    if (response.ok && envelope?.success !== false) {
      const text = envelope?.result?.response;
      if (typeof text === 'string') return text;
      // Some models hand back already-parsed JSON when the output is JSON.
      if (text && typeof text === 'object') return JSON.stringify(text);
      throw new WorkersAiStopError('UNAVAILABLE', 'Workers AI returned no response text');
    }

    const label = `Workers AI ${response.status}${codes.length ? ` (code ${codes.join(',')})` : ''}`;

    if (codes.includes(3040)) {
      if (attempt < CAPACITY_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 5_000));
        continue;
      }
      throw new WorkersAiStopError('UNAVAILABLE', `${label}: capacity exceeded`);
    }
    if (response.status === 429 || codes.includes(3036)) {
      throw new WorkersAiStopError('QUOTA', `${label}: daily neuron allocation used up`);
    }
    if (codes.includes(5016)) {
      throw new WorkersAiStopError(
        'CONFIG',
        `${label}: the Cloudflare account has not accepted the Llama 3.2 licence (send {"prompt":"agree"} once)`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new WorkersAiStopError('CONFIG', `${label}: token rejected or lacks Workers AI permission`);
    }
    throw new WorkersAiStopError('UNAVAILABLE', label);
  }
}
