'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Ban, KeyRound, ShieldCheck, Snowflake, Sun, Trash2, UserCog } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { PageHeader } from './AdminShell';
import {
  ASSIGNABLE_ROLE_VALUES,
  FreezeDurationSelect,
  PrivilegedRoleWarning,
  freezeUntilIso,
  isPrivilegedRole,
  type FreezeDurationKey,
} from './RoleControls';
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  StatusBadge,
  formatDate,
  formatDateTime,
  useAdminFetch,
  useToast,
} from './primitives';

type Detail = {
  user: {
    id: string;
    fullName: string;
    nickname: string;
    email: string;
    phone: string | null;
    headline: string | null;
    bio: string | null;
    locale: string;
    timezone: string;
    role: string;
    accountStatus: string;
  /** Serialised by freezeState() so this view and the table agree. */
  freeze: { frozen: boolean; until: string | null; reason: string | null; expired: boolean };
    verificationStatus: string;
    isVerified: boolean;
    verifiedAt: string | null;
    studentStatusConfirmed: boolean;
    identityConfirmed: boolean;
    graduationYear: number | null;
    graduationMonth: number | null;
    alumniTransitionedAt: string | null;
    emailVerifiedAt: string | null;
    lastLoginAt: string | null;
    failedLoginCount: number;
    lockedUntil: string | null;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
    university: { id: string; code: string; nameEn: string; city: string } | null;
    faculty: { id: string; nameEn: string } | null;
    verificationCases: {
      id: string;
      status: string;
      attempt: number;
      submittedAt: string;
      decidedAt: string | null;
      verdict: string | null;
      confidence: string | number | null;
      failureCodes: string[];
      checkScores: Record<string, number> | null;
      reviewPriority: number;
      reviewExpiresAt: string | null;
      moderatorNote: string | null;
      decidedByModerator: { id: string; nickname: string; fullName: string } | null;
    }[];
    devices: { id: string; fingerprint: string | null; label: string; trusted: boolean; firstSeenAt: string; lastSeenAt: string }[];
    sessions: { id: string; userAgent: string; createdAt: string; lastSeenAt: string; expiresAt: string; revokedAt: string | null }[];
  };
  blocks: { type: string; reason: string; expiresAt: string | null; createdAt: string; hitCount: number }[];
  auditEvents: {
    id: string;
    action: string;
    entityType: string;
    entityId: string | null;
    createdAt: string;
    actor: { id: string; nickname: string } | null;
  }[];
  moderationNotes: {
    id: string;
    action: string;
    reason: string;
    createdAt: string;
    moderator: { id: string; nickname: string } | null;
  }[];
  capabilities: { canManage: boolean };
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs uppercase tracking-wide text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-fg">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-4">
      <h2 className="mb-3 text-sm font-semibold text-fg">{title}</h2>
      {children}
    </section>
  );
}

type PendingAction =
  | { kind: 'status'; value: string }
  | { kind: 'role'; value: string }
  /**
   * Freeze is a SEPARATE action from status:SUSPENDED even though both end at
   * the same enum member. A freeze also carries an expiry and a reason shown
   * to the account holder, and the expiry is what makes it self-lifting - so
   * an operator who forgets to unfreeze cannot strand someone.
   */
  | { kind: 'freeze' }
  | { kind: 'unfreeze' }
  | { kind: 'sessions' }
  | { kind: 'delete' }
  | null;

/**
 * One account, everything known about it, and the actions available on it.
 *
 * The action buttons are rendered from `capabilities.canManage`, which the
 * SERVER computed from the live role - not from a role string the client could
 * edit. Hiding a button is a usability decision, never the control: every
 * endpoint behind these buttons re-authorizes independently, so a MODERATOR who
 * forges the flag in devtools gets a 403 from the API rather than a mutation.
 */
export function UserDetail({ userId }: { userId: string }) {
  const t = useT();
  const router = useRouter();
  const toast = useToast();
  const { data, error, loading, reload } = useAdminFetch<Detail>(`/api/admin/users/${userId}`);
  const [pending, setPending] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);
  const [duration, setDuration] = useState<FreezeDurationKey>('d7');
  const [roleConfirmed, setRoleConfirmed] = useState(false);

  async function run(action: Exclude<PendingAction, null>, reason: string) {
    setBusy(true);
    try {
      let response: Response;
      if (action.kind === 'delete') {
        response = await fetch(`/api/admin/users/${userId}`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason, confirmNickname: data?.user.nickname ?? '' }),
        });
      } else if (action.kind === 'sessions') {
        response = await fetch(`/api/admin/users/${userId}/sessions`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason }),
        });
      } else if (action.kind === 'freeze') {
        response = await fetch(`/api/admin/users/${userId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          // The expiry is computed HERE, at confirm time, not when the dialog
          // opened - otherwise a dialog left open for ten minutes freezes for
          // ten minutes less than the operator chose.
          body: JSON.stringify({ op: 'freeze', reason, until: freezeUntilIso(duration) }),
        });
      } else if (action.kind === 'unfreeze') {
        response = await fetch(`/api/admin/users/${userId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'unfreeze' }),
        });
      } else {
        response = await fetch(`/api/admin/users/${userId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            action.kind === 'status'
              ? { op: 'status', accountStatus: action.value, reason }
              : {
                  op: 'role',
                  role: action.value,
                  reason,
                  // Echoed for MODERATOR/ADMIN. The server requires it too, so
                  // bypassing the dialog does not bypass the safeguard.
                  ...(isPrivilegedRole(action.value) ? { confirmPrivileged: roleConfirmed } : {}),
                },
          ),
        });
      }

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast(t(body.error ?? 'errors.generic'), 'error');
        return;
      }

      toast(t('admin.users.actions.done'));
      setPending(null);
      setRoleConfirmed(false);
      if (action.kind === 'delete') router.push('/admin/users');
      else reload();
    } catch {
      toast(t('errors.generic'), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="h-8 w-56 animate-pulse rounded bg-surface-muted" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="card h-40 animate-pulse bg-surface-muted/40" />
        ))}
      </div>
    );
  }

  if (error || !data) {
    return (
      <>
        <PageHeader title={t('admin.users.detail.title')} />
        <ErrorState message={t(error ?? 'errors.notFound')} onRetry={reload} />
      </>
    );
  }

  const { user, blocks, auditEvents, moderationNotes, capabilities } = data;
  const latestCase = user.verificationCases[0];
  const canManage = capabilities.canManage && !user.deletedAt;

  const confirmCopy: Record<string, { title: string; body: string; label: string }> = {
    status: {
      title: t('admin.users.actions.confirmStatusTitle'),
      body: t('admin.users.actions.confirmStatusBody'),
      label: t('admin.users.actions.apply'),
    },
    role: {
      title: t('admin.users.actions.confirmRoleTitle'),
      body: t('admin.users.actions.confirmRoleBody'),
      label: t('admin.users.actions.apply'),
    },
    freeze: {
      title: t('admin.users.freezeTitle'),
      body: t('admin.users.freezeBody'),
      label: t('admin.users.freezeConfirm'),
    },
    unfreeze: {
      title: t('admin.users.unfreezeTitle'),
      body: t('admin.users.unfreezeBody'),
      label: t('admin.users.unfreezeConfirm'),
    },
    sessions: {
      title: t('admin.users.actions.confirmRevokeTitle'),
      body: t('admin.users.actions.confirmRevokeBody'),
      label: t('admin.users.actions.revokeSessions'),
    },
    delete: {
      title: t('admin.users.actions.confirmDeleteTitle'),
      body: t('admin.users.actions.confirmDeleteBody'),
      label: t('admin.users.actions.delete'),
    },
  };

  return (
    <>
      <Link href="/admin/users" className="btn-ghost mb-2 -ml-2 px-2">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        {t('admin.users.detail.back')}
      </Link>

      <PageHeader
        title={user.fullName}
        description={`@${user.nickname}`}
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge kind="account" value={user.accountStatus} />
            <StatusBadge kind="verification" value={user.verificationStatus} />
            <StatusBadge kind="role" value={user.role} />
          </div>
        }
      />

      {user.deletedAt && (
        <div role="status" className="card mb-3 border-danger/40 bg-danger/5 p-3 text-sm text-danger-fg">
          {t('admin.users.detail.deletedBanner').replace('{date}', formatDateTime(user.deletedAt))}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <Section title={t('admin.users.detail.profile')}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
              <Field label={t('admin.users.columns.userId')}>
                <span className="font-mono text-2xs">{user.id}</span>
              </Field>
              <Field label={t('admin.users.columns.email')}>{user.email}</Field>
              {/* Unmasked here only. Fetching this page wrote an audit row. */}
              <Field label={t('admin.users.columns.phone')}>
                <span className="font-mono">{user.phone ?? '—'}</span>
              </Field>
              <Field label={t('admin.users.columns.university')}>
                {user.university ? `${user.university.code} — ${user.university.city}` : '—'}
              </Field>
              <Field label={t('admin.users.columns.faculty')}>{user.faculty?.nameEn ?? '—'}</Field>
              <Field label={t('admin.users.columns.graduation')}>
                {user.graduationYear
                  ? `${user.graduationYear}-${String(user.graduationMonth ?? 1).padStart(2, '0')}`
                  : '—'}
              </Field>
              <Field label={t('admin.users.columns.created')}>{formatDateTime(user.createdAt)}</Field>
              <Field label={t('admin.users.columns.updated')}>{formatDateTime(user.updatedAt)}</Field>
              <Field label={t('admin.users.columns.lastLogin')}>{formatDateTime(user.lastLoginAt)}</Field>
              <Field label={t('admin.users.detail.emailVerified')}>{formatDateTime(user.emailVerifiedAt)}</Field>
              <Field label={t('admin.users.detail.locale')}>{user.locale} · {user.timezone}</Field>
              <Field label={t('admin.users.detail.failedLogins')}>
                {user.failedLoginCount}
                {user.lockedUntil && (
                  <span className="ml-1.5 text-2xs text-warn-fg">
                    {t('admin.users.detail.lockedUntil').replace('{date}', formatDateTime(user.lockedUntil))}
                  </span>
                )}
              </Field>
            </dl>
          </Section>

          <Section title={t('admin.users.detail.verification')}>
            {!latestCase ? (
              <EmptyState title={t('admin.users.detail.noCases')} />
            ) : (
              <div className="space-y-3">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                  <Field label={t('admin.verifications.columns.status')}>
                    <StatusBadge kind="verification" value={latestCase.status} />
                  </Field>
                  <Field label={t('admin.verifications.columns.verdict')}>{latestCase.verdict ?? '—'}</Field>
                  <Field label={t('admin.verifications.columns.confidence')}>
                    {latestCase.confidence != null ? Number(latestCase.confidence).toFixed(3) : '—'}
                  </Field>
                  <Field label={t('admin.verifications.columns.priority')}>{latestCase.reviewPriority}</Field>
                  <Field label={t('admin.verifications.columns.submitted')}>{formatDateTime(latestCase.submittedAt)}</Field>
                  <Field label={t('admin.verifications.columns.decided')}>{formatDateTime(latestCase.decidedAt)}</Field>
                  <Field label={t('admin.verifications.columns.reviewer')}>
                    {latestCase.decidedByModerator ? `@${latestCase.decidedByModerator.nickname}` : '—'}
                  </Field>
                  <Field label={t('admin.users.detail.attempt')}>{latestCase.attempt}</Field>
                  <Field label={t('admin.users.detail.confirmedFlags')}>
                    {[
                      user.identityConfirmed ? 'identity' : null,
                      user.studentStatusConfirmed ? 'student' : null,
                    ].filter(Boolean).join(', ') || '—'}
                  </Field>
                </dl>

                {latestCase.failureCodes.length > 0 && (
                  <div>
                    <p className="text-2xs uppercase tracking-wide text-fg-subtle">
                      {t('admin.verifications.columns.codes')}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {/* De-duplicated for display: the pipeline appends one set
                          of codes per document, so the raw array repeats each
                          code up to four times. */}
                      {[...new Set(latestCase.failureCodes)].map((code) => (
                        <Badge key={code} tone="warning">{code}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {latestCase.checkScores && (
                  <div>
                    <p className="text-2xs uppercase tracking-wide text-fg-subtle">
                      {t('admin.users.detail.checkScores')}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {Object.entries(latestCase.checkScores).map(([key, value]) => (
                        <span key={key} className="rounded-md border border-edge bg-surface-muted px-1.5 py-0.5 text-2xs tabular-nums text-fg-muted">
                          {key} <strong className="text-fg">{Number(value).toFixed(2)}</strong>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {latestCase.moderatorNote && (
                  <p className="rounded-lg border border-edge bg-surface-muted p-2.5 text-sm text-fg-muted">
                    {latestCase.moderatorNote}
                  </p>
                )}

                <Link href="/admin/verifications" className="btn-secondary">
                  {t('admin.users.detail.openQueue')}
                </Link>
              </div>
            )}
          </Section>

          <Section title={t('admin.users.detail.activity')}>
            {auditEvents.length === 0 ? (
              <EmptyState title={t('admin.auditLogs.empty')} />
            ) : (
              <ul className="divide-y divide-edge">
                {auditEvents.map((event) => (
                  <li key={event.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5 text-sm">
                    <span className="font-mono text-2xs text-fg">{event.action}</span>
                    <span className="text-2xs text-fg-muted">
                      {event.entityType}
                      {event.entityId ? `:${event.entityId.slice(0, 8)}…` : ''}
                    </span>
                    {event.actor && (
                      <span className="text-2xs text-fg-subtle">@{event.actor.nickname}</span>
                    )}
                    <span className="ml-auto tabular-nums text-2xs text-fg-subtle">
                      {formatDateTime(event.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <div className="space-y-3">
          {canManage && (
            <Section title={t('admin.users.actions.title')}>
              <div className="space-y-3">
                <label className="block">
                  <span className="text-2xs font-medium text-fg-muted">{t('admin.users.actions.accountStatus')}</span>
                  <select
                    className="input mt-1 py-1.5 text-sm"
                    value=""
                    onChange={(event) =>
                      event.target.value && setPending({ kind: 'status', value: event.target.value })
                    }
                  >
                    <option value="">{t('admin.users.actions.choose')}</option>
                    <option value="ACTIVE">ACTIVE</option>
                    <option value="RESTRICTED">RESTRICTED</option>
                    <option value="SUSPENDED">SUSPENDED</option>
                  </select>
                  <span className="mt-1 block text-2xs text-fg-subtle">
                    {t('admin.users.actions.banNote')}
                  </span>
                </label>

                <label className="block">
                  <span className="text-2xs font-medium text-fg-muted">{t('admin.users.actions.role')}</span>
                  <select
                    className="input mt-1 py-1.5 text-sm"
                    value=""
                    onChange={(event) =>
                      event.target.value && setPending({ kind: 'role', value: event.target.value })
                    }
                  >
                    <option value="">{t('admin.users.actions.choose')}</option>
                    {/* All six roles are grantable. The applicant-facing ones
                        (ALUMNI, MENTOR, TEACHER) are normally owned by the
                        graduation cron and the mentor application flow, but an
                        admin has to be the system of last resort - otherwise
                        the only way to fix a missed cohort is editing the
                        database by hand, which leaves no audit row, no reason
                        and no session revocation. */}
                    {ASSIGNABLE_ROLE_VALUES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </label>

                {/*
                  Temporary freeze.
                  Offered as its own control rather than as SUSPENDED in the
                  status dropdown above, because the two are not the same
                  action: a freeze carries an expiry and a reason the account
                  holder is shown, and it lifts itself when the expiry passes.
                */}
                {user.freeze?.frozen ? (
                  <div className="rounded-lg border border-accent/30 bg-accent-soft p-3">
                    <p className="text-2xs font-medium text-accent">
                      {user.freeze.until
                        ? t('admin.users.frozenUntil', { date: formatDate(user.freeze.until) })
                        : t('admin.users.frozenIndefinitely')}
                    </p>
                    {user.freeze.reason && (
                      <p className="mt-1 text-2xs leading-relaxed text-fg-muted">
                        {user.freeze.reason}
                      </p>
                    )}
                    <button
                      type="button"
                      className="btn-secondary mt-2.5 w-full"
                      onClick={() => setPending({ kind: 'unfreeze' })}
                    >
                      <Sun className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('admin.users.unfreeze')}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary w-full"
                    onClick={() => setPending({ kind: 'freeze' })}
                  >
                    <Snowflake className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('admin.users.freeze')}
                  </button>
                )}

                <button type="button" className="btn-secondary w-full" onClick={() => setPending({ kind: 'sessions' })}>
                  <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('admin.users.actions.revokeSessions')}
                </button>

                <button type="button" className="btn-danger w-full" onClick={() => setPending({ kind: 'delete' })}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('admin.users.actions.delete')}
                </button>
              </div>
            </Section>
          )}

          {!capabilities.canManage && (
            <Section title={t('admin.users.actions.title')}>
              <p className="flex items-start gap-1.5 text-sm text-fg-muted">
                <UserCog className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {t('admin.users.actions.moderatorReadOnly')}
              </p>
            </Section>
          )}

          <Section title={t('admin.users.detail.blocklist')}>
            {blocks.length === 0 ? (
              <p className="flex items-center gap-1.5 text-sm text-verified-fg">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                {t('admin.users.detail.noBlocks')}
              </p>
            ) : (
              <ul className="space-y-2">
                {blocks.map((block, index) => (
                  <li key={index} className="rounded-lg border border-danger/30 bg-danger/5 p-2">
                    <p className="flex items-center gap-1.5 text-2xs font-medium text-danger-fg">
                      <Ban className="h-3 w-3" aria-hidden="true" />
                      {block.type}
                    </p>
                    <p className="mt-1 text-2xs text-fg-muted">{block.reason}</p>
                    <p className="mt-1 text-2xs text-fg-subtle">
                      {block.expiresAt
                        ? t('admin.users.detail.blockExpires').replace('{date}', formatDateTime(block.expiresAt))
                        : t('admin.users.detail.blockPermanent')}
                      {' · '}
                      {t('admin.users.detail.blockHits').replace('{n}', String(block.hitCount))}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={t('admin.users.detail.devices')}>
            {user.devices.length === 0 ? (
              <EmptyState title={t('admin.users.detail.noDevices')} />
            ) : (
              <ul className="space-y-2">
                {user.devices.map((device) => (
                  <li key={device.id} className="text-sm">
                    <p className="font-medium text-fg">{device.label}</p>
                    <p className="font-mono text-2xs text-fg-subtle">{device.fingerprint}</p>
                    <p className="text-2xs text-fg-muted">{formatDateTime(device.lastSeenAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={t('admin.users.detail.sessions')}>
            {user.sessions.length === 0 ? (
              <EmptyState title={t('admin.users.detail.noSessions')} />
            ) : (
              <ul className="space-y-2">
                {user.sessions.slice(0, 8).map((session) => (
                  <li key={session.id} className="text-sm">
                    <p className="flex items-center gap-1.5">
                      <span className="truncate text-2xs text-fg-muted">{session.userAgent || '—'}</span>
                      {session.revokedAt ? (
                        <Badge tone="neutral">{t('admin.users.detail.revoked')}</Badge>
                      ) : (
                        <Badge tone="positive">{t('admin.users.detail.live')}</Badge>
                      )}
                    </p>
                    <p className="text-2xs text-fg-subtle">{formatDateTime(session.createdAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={t('admin.users.detail.notes')}>
            {moderationNotes.length === 0 ? (
              <EmptyState title={t('admin.users.detail.noNotes')} />
            ) : (
              <ul className="space-y-2">
                {moderationNotes.map((note) => (
                  <li key={note.id} className="rounded-lg border border-edge bg-surface-muted p-2">
                    <p className="font-mono text-2xs text-fg">{note.action}</p>
                    <p className="mt-0.5 text-2xs text-fg-muted">{note.reason}</p>
                    <p className="mt-1 text-2xs text-fg-subtle">
                      {note.moderator ? `@${note.moderator.nickname} · ` : ''}
                      {formatDateTime(note.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>

      {pending && (
        <ConfirmDialog
          open
          title={confirmCopy[pending.kind].title}
          body={
            pending.kind === 'status' || pending.kind === 'role'
              ? `${confirmCopy[pending.kind].body} → ${pending.value}`
              : confirmCopy[pending.kind].body
          }
          confirmLabel={confirmCopy[pending.kind].label}
          tone={pending.kind === 'delete' ? 'danger' : 'primary'}
          /* Unfreezing needs no written justification: it RESTORES access, and
             demanding a reason to undo a mistake only makes the mistake more
             likely to be left in place. */
          requireReason={pending.kind !== 'unfreeze'}
          typeToConfirm={pending.kind === 'delete' ? user.nickname : undefined}
          busy={busy}
          extraValid={
            pending.kind !== 'role' || !isPrivilegedRole(pending.value) || roleConfirmed
          }
          extra={
            pending.kind === 'freeze' ? (
              <FreezeDurationSelect value={duration} onChange={setDuration} />
            ) : pending.kind === 'role' && isPrivilegedRole(pending.value) ? (
              // Reuses the same warning block the users table shows, so the
              // last thing an operator reads before granting power over other
              // accounts is identical wherever the grant is made.
              <PrivilegedRoleWarning
                confirmed={roleConfirmed}
                onConfirmedChange={setRoleConfirmed}
              />
            ) : undefined
          }
          onCancel={() => {
            if (busy) return;
            setPending(null);
            setRoleConfirmed(false);
          }}
          onConfirm={(reason) => void run(pending, reason)}
        />
      )}
    </>
  );
}
