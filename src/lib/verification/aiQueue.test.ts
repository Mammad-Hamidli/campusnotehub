import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore } from '@/test/fakeFirestore';

/**
 * The nightly AI verification batch against an in-memory Firestore: FIFO
 * order, what an approval and a flag write, and - the requirement this exists
 * for - that running out of Workers AI quota mid-batch stops without touching
 * the case in hand, and the next run starts from exactly that case.
 *
 * Real code from the batch down to the repositories; fake storage, a fake
 * review buffer, a scripted vision model and a recorded mailer.
 */

const fake = createFakeFirestore();
vi.mock('@/lib/firebase/admin.core', () => ({ adminDb: () => fake.db }));

const sendEmail = vi.fn<(...args: unknown[]) => Promise<{ ok: true; id: null }>>(async () => ({ ok: true, id: null }));
vi.mock('@/lib/email/send', () => ({ sendEmail: (...args: unknown[]) => sendEmail(...args), sendEmailAsync: () => {} }));

const destroy = vi.fn<(key: string) => Promise<void>>(async () => {});
vi.mock('./reviewBuffer', () => ({
  stash: async (documents: { kind: string }[]) => ({
    key: 'buf-new',
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
    documents: documents.map((d) => ({ kind: d.kind, publicId: `buf-new/${d.kind}` })),
  }),
  // Each "image" is just the text "<bufferKey>|<kind>", so the scripted model
  // below knows which case and document it is looking at.
  retrieve: async (buffer: { key: string; documents: { kind: string }[] }) =>
    buffer.documents.map((d) => ({ kind: d.kind, mime: 'image/jpeg', bytes: Buffer.from(`${buffer.key}|${d.kind}`) })),
  destroy: (key: string) => destroy(key),
}));

/** caseId -> what the model "reads" (or a thrown stop), per document kind. */
const script = new Map<string, (kind: string) => unknown>();
const modelCalls: string[] = [];
vi.mock('./workersAi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workersAi')>();
  return {
    ...actual,
    runVisionModel: async ({ jpeg }: { jpeg: Buffer }) => {
      const [key, kind] = jpeg.toString().split('|');
      const caseId = key.replace('buf-', '');
      modelCalls.push(`${caseId}:${kind}`);
      const answer = script.get(caseId)?.(kind);
      if (answer instanceof Error) throw answer;
      return JSON.stringify(answer);
    },
  };
});

const { runAiVerificationBatch, enqueueSubmission, aiBatchStatus } = await import('./aiQueue');
const { WorkersAiStopError } = await import('./workersAi');

const DAY = 86_400_000;
const get = (path: string) => fake.store.get(path) as Record<string, unknown> | undefined;

const matching = (name: [string, string]) => () => ({
  documentType: 'NATIONAL_ID',
  givenName: name[0],
  surname: name[1],
  patronymic: null,
  dateOfBirth: null,
  expiryDate: '2032-01-01',
  institution: null,
  legible: true,
  fullyVisible: true,
  screenPhoto: false,
  signsOfEditing: false,
});

function seedCase(id: string, user: { name: [string, string] }, submittedDaysAgo: number) {
  fake.store.set(`users/u-${id}`, {
    fullName: user.name.join(' '),
    firstName: null,
    lastName: null,
    dateOfBirth: null,
    role: 'MENTOR', // identity-only: the ID front is the one document read
    accountStatus: 'ACTIVE',
    verificationStatus: 'NEEDS_REVIEW',
    universityId: null,
    email: `${id}@example.com`,
    nickname: id,
  });
  fake.store.set(`verificationCases/${id}`, {
    userId: `u-${id}`,
    status: 'NEEDS_REVIEW',
    attempt: 1,
    submittedAt: new Date(Date.now() - submittedDaysAgo * DAY),
    decidedAt: null,
    failureCodes: [],
    reviewBufferKey: `buf-${id}`,
    reviewExpiresAt: new Date(Date.now() + 7 * DAY),
    reviewDocuments: [
      { kind: 'ID_FRONT', publicId: `buf-${id}/ID_FRONT` },
      { kind: 'ID_BACK', publicId: `buf-${id}/ID_BACK` },
    ],
    reviewPriority: 0,
    dismissedAt: null,
    aiCheckState: 'QUEUED',
    aiCheckedAt: null,
  });
  script.set(id, matching(user.name));
}

beforeEach(() => {
  fake.store.clear();
  script.clear();
  modelCalls.length = 0;
  sendEmail.mockClear();
  destroy.mockClear();
});

describe('runAiVerificationBatch', () => {
  it('walks the queue oldest first and reads only the ID front', async () => {
    seedCase('newest', { name: ['Leyla', 'Əliyeva'] }, 1);
    seedCase('oldest', { name: ['Aysel', 'Məmmədova'] }, 3);
    seedCase('middle', { name: ['Rəşad', 'Quliyev'] }, 2);

    const result = await runAiVerificationBatch();

    expect(modelCalls).toEqual(['oldest:ID_FRONT', 'middle:ID_FRONT', 'newest:ID_FRONT']);
    expect(result).toMatchObject({ processed: 3, approved: 3, remaining: 0, stoppedReason: 'QUEUE_EMPTY' });
  });

  it('auto-approves a complete match: verified account, documents destroyed, user emailed', async () => {
    seedCase('c1', { name: ['Aysel', 'Məmmədova'] }, 1);

    await runAiVerificationBatch();

    expect(get('verificationCases/c1')).toMatchObject({
      status: 'VERIFIED',
      verdict: 'CLEAN',
      aiCheckState: 'APPROVED',
      reviewBufferKey: null,
      reviewDocuments: null,
    });
    expect(get('users/u-c1')).toMatchObject({ verificationStatus: 'VERIFIED', isVerified: true });
    expect(destroy).toHaveBeenCalledWith('buf-c1');
    expect(sendEmail).toHaveBeenCalledWith('c1@example.com', 'verificationApproved', { nickname: 'c1' }, expect.anything());
    // Nothing to tell staff about.
    expect(sendEmail.mock.calls.some((call) => call[1] === 'verificationAiDigest')).toBe(false);
  });

  it('keeps an ambiguous case under review, flags it, keeps its documents and alerts staff', async () => {
    seedCase('c1', { name: ['Aysel', 'Məmmədova'] }, 1);
    script.set('c1', () => ({ ...matching(['Leyla', 'Məmmədova'])(), screenPhoto: true }));

    const result = await runAiVerificationBatch();

    expect(result).toMatchObject({ flagged: 1, approved: 0 });
    const kase = get('verificationCases/c1')!;
    expect(kase).toMatchObject({ status: 'NEEDS_REVIEW', aiCheckState: 'FLAGGED', verdict: 'TAMPERED', reviewBufferKey: 'buf-c1' });
    expect(kase.failureCodes).toEqual(expect.arrayContaining(['NAME_MISMATCH', 'SCREEN_RECAPTURE']));
    expect(kase.reviewPriority).toBeGreaterThan(40);
    expect(get('users/u-c1')).toMatchObject({ verificationStatus: 'NEEDS_REVIEW' });
    expect(destroy).not.toHaveBeenCalled();

    const digest = sendEmail.mock.calls.find((call) => call[1] === 'verificationAiDigest')!;
    expect(digest[2]).toMatchObject({ flagged: [{ caseId: 'c1' }], approved: 0, remaining: 0, stopped: null });
    // No name read off the document goes to staff mail either.
    expect(JSON.stringify(digest)).not.toMatch(/Leyla|Aysel/);
  });

  it('stops on the daily AI limit without touching the case in hand, and the next run resumes from it', async () => {
    seedCase('first', { name: ['Aysel', 'Məmmədova'] }, 3);
    seedCase('second', { name: ['Leyla', 'Əliyeva'] }, 2);
    seedCase('third', { name: ['Rəşad', 'Quliyev'] }, 1);
    script.set('second', () => new WorkersAiStopError('QUOTA', 'Workers AI 429 (code 3036)'));

    const night1 = await runAiVerificationBatch();

    expect(night1).toMatchObject({ processed: 1, approved: 1, remaining: 2, stoppedReason: 'AI_QUOTA' });
    expect(modelCalls).toEqual(['first:ID_FRONT', 'second:ID_FRONT']);
    for (const id of ['second', 'third']) {
      expect(get(`verificationCases/${id}`)).toMatchObject({ status: 'NEEDS_REVIEW', aiCheckState: 'QUEUED', reviewBufferKey: `buf-${id}` });
    }
    const digest = sendEmail.mock.calls.find((call) => call[1] === 'verificationAiDigest')!;
    expect(digest[2]).toMatchObject({ flagged: [], remaining: 2, stopped: expect.stringMatching(/allocation/) });

    // The allocation resets; the next night picks up exactly where this one stopped.
    script.set('second', matching(['Leyla', 'Əliyeva']));
    modelCalls.length = 0;
    const night2 = await runAiVerificationBatch();

    expect(modelCalls).toEqual(['second:ID_FRONT', 'third:ID_FRONT']);
    expect(night2).toMatchObject({ processed: 2, approved: 2, remaining: 0, stoppedReason: 'QUEUE_EMPTY' });
  });

  it('stops for configuration problems and says so to staff', async () => {
    seedCase('c1', { name: ['Aysel', 'Məmmədova'] }, 1);
    script.set('c1', () => new WorkersAiStopError('CONFIG', 'licence not accepted'));

    const result = await runAiVerificationBatch();

    expect(result).toMatchObject({ stoppedReason: 'AI_CONFIG', processed: 0, remaining: 1 });
    expect(get('verificationCases/c1')).toMatchObject({ aiCheckState: 'QUEUED' });
    expect(sendEmail.mock.calls.find((call) => call[1] === 'verificationAiDigest')?.[2]).toMatchObject({
      stopped: expect.stringMatching(/licence/),
    });
  });

  it('never overwrites a moderator who decided the case first', async () => {
    seedCase('c1', { name: ['Aysel', 'Məmmədova'] }, 1);
    fake.store.set('verificationCases/c1', { ...get('verificationCases/c1'), status: 'REJECTED', decidedByModeratorId: 'mod' });

    const result = await runAiVerificationBatch();

    expect(modelCalls).toEqual([]);
    expect(get('verificationCases/c1')).toMatchObject({ status: 'REJECTED', decidedByModeratorId: 'mod' });
    expect(result).toMatchObject({ processed: 1, approved: 0, skipped: 1 });
  });

  it('flags a case whose documents are gone instead of approving it', async () => {
    seedCase('c1', { name: ['Aysel', 'Məmmədova'] }, 1);
    fake.store.set('verificationCases/c1', { ...get('verificationCases/c1'), reviewDocuments: null });

    await runAiVerificationBatch();

    expect(get('verificationCases/c1')).toMatchObject({ aiCheckState: 'FLAGGED', failureCodes: ['DOCUMENTS_UNAVAILABLE'] });
  });

  it('runs one batch at a time', async () => {
    seedCase('c1', { name: ['Aysel', 'Məmmədova'] }, 1);
    fake.store.set('siteConfig/verificationAiBatch', { holder: 'other', leaseUntil: new Date(Date.now() + 60_000) });

    const result = await runAiVerificationBatch();

    expect(result.stoppedReason).toBe('LEASE_HELD');
    expect(modelCalls).toEqual([]);
  });

  it('stops for time before starting a case it may not finish, and releases the lease', async () => {
    seedCase('c1', { name: ['Aysel', 'Məmmədova'] }, 1);

    const result = await runAiVerificationBatch({ deadline: Date.now() + 1_000 });

    expect(result).toMatchObject({ stoppedReason: 'TIME_BUDGET', processed: 0, remaining: 1 });
    expect(get('verificationCases/c1')).toMatchObject({ aiCheckState: 'QUEUED' });
    expect(get('siteConfig/verificationAiBatch')).toMatchObject({ holder: null });
    // A time stop hands over to the next invocation; it is not news for staff.
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('aiBatchStatus', () => {
  it('reports a held lease as running, and the last run once it is released', async () => {
    fake.store.set('siteConfig/verificationAiBatch', { holder: 'other', leaseUntil: new Date(Date.now() + 60_000), startedAt: new Date() });
    expect(await aiBatchStatus()).toMatchObject({ running: true, lastRun: null });

    fake.store.delete('siteConfig/verificationAiBatch');
    expect(await aiBatchStatus()).toEqual({ running: false, startedAt: null, lastRun: null });

    seedCase('c1', { name: ['Aysel', 'Məmmədova'] }, 1);
    await runAiVerificationBatch({ deadline: Date.now() + 1_000 });
    expect(await aiBatchStatus()).toMatchObject({ running: false, lastRun: { stoppedReason: 'TIME_BUDGET', remaining: 1 } });
  });

  it('treats an expired lease as not running', async () => {
    fake.store.set('siteConfig/verificationAiBatch', { holder: 'crashed', leaseUntil: new Date(Date.now() - 1_000) });
    expect((await aiBatchStatus()).running).toBe(false);
  });
});

describe('enqueueSubmission', () => {
  it('parks the documents and queues the case under review', async () => {
    fake.store.set('users/u1', { verificationStatus: 'UNVERIFIED' });

    const kase = await enqueueSubmission({
      userId: 'u1',
      caseId: 'c9',
      attempt: 1,
      documents: [{ kind: 'ID_FRONT', mime: 'image/jpeg', bytes: Buffer.from('x') }],
    });

    expect(kase.id).toBe('c9');
    expect(get('verificationCases/c9')).toMatchObject({
      status: 'NEEDS_REVIEW',
      aiCheckState: 'QUEUED',
      reviewBufferKey: 'buf-new',
      decidedAt: null,
    });
    expect(get('users/u1')).toMatchObject({ verificationStatus: 'NEEDS_REVIEW' });
  });
});
