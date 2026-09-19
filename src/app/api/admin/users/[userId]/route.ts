import { NextResponse, type NextRequest } from 'next/server';
import { AccountStatus, BlocklistType, UserRole, VerificationStatus } from '@/lib/enums';
import { adminDb } from '@/lib/firebase/admin';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { countUsers, findUserById, findUsersByIds, updateUser } from '@/lib/firebase/repositories/users';
import { findUniversityById, findFacultyById } from '@/lib/firebase/repositories/reference';
import {
  listUserDevices,
  listUserSessions,
  revokeUserSessions,
} from '@/lib/firebase/repositories/sessions';
import { listCases } from '@/lib/firebase/repositories/verification';
import { listAuditLogs } from '@/lib/firebase/repositories/audit';
import { moderationHistory } from '@/lib/firebase/repositories/moderation';
import { enqueueNotification } from '@/lib/notifications/dispatch';
import { withAdmin, adminAudit } from '@/lib/auth/admin';
import {
  adminDeleteUserSchema,
  adminFreezeSchema,
  adminRoleChangeSchema,
  adminStatusChangeSchema,
  adminVerificationSetSchema,
  PRIVILEGED_ROLES,
} from '@/server/validators/admin';
import { freezeAccount, freezeState, unfreezeAccount } from '@/lib/auth/freeze';
import { writeModerationAction } from '@/lib/firebase/repositories/moderation';
import { sendEmailAsync } from '@/lib/email/send';
import { hashEmail, hashPhone } from '@/lib/crypto/hash';
import { shortFingerprint } from '@/lib/admin/redact';
import { AccountDeletionError, softDeleteAccount } from '@/lib/accounts/softDelete';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/users/:userId - one account, in full.
 *
 * The unmasked phone number is returned here and nowhere else, and fetching
 * this page writes an ADMIN_USER_VIEWED audit row. That is the same rule the
 * KYC document endpoint already follows: staff may read sensitive fields, but
 * never silently. "Who looked at this account, and when" stays answerable from
 * the audit log alone.
 *
 * The `select` is an allow-list. passwordHash, emailHash and phoneHash are on
 * this model and must never appear in a response; naming what we want rather
 * than what we exclude is what guarantees that as the model grows.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  return withAdmin(request, 'MODERATOR', async (actor) => {
    const { userId } = await params;

    const user = await findUserById(userId);

    if (!user) {
      return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    }

    /**
     * The five `include` branches Prisma resolved in one query, as five reads.
     *
     * Concurrent, because none depends on another. This endpoint is the admin
     * detail modal for ONE named account - it is opened deliberately, it is
     * audited, and it is not on any hot path - so paying several round trips
     * for the fan-out is the right trade against denormalising this much
     * relational detail onto the user document.
     */
    const [university, faculty, devices, sessions, cases, frozenBy] = await Promise.all([
      user.universityId ? findUniversityById(user.universityId) : Promise.resolve(null),
      user.facultyId ? findFacultyById(user.facultyId) : Promise.resolve(null),
      listUserDevices(userId),
      listUserSessions(userId, 20),
      listCases({ userId, includeDismissed: true }, 1, 50, 'submittedAt', 'desc'),
      user.frozenById ? findUserById(user.frozenById) : Promise.resolve(null),
    ]);

    /**
     * Blocklist status, as booleans.
     *
     * The blocklist stores HMACs, so the only way to answer "is this account
     * blocked" is to hash the account's own identifiers and look for a match.
     * That is done here rather than returning rows, because a row would expose
     * the hash - and a hash of a known-plaintext email is a lookup key for
     * every other blocklist entry.
     *
     * The SQL was one query with an `OR` over the candidates. Firestore has no
     * cross-value OR, but it does not need one: `type` + `value` was a UNIQUE
     * pair and is now the document id, so this is a batched read by key -
     * strictly cheaper than the OR it replaces.
     */
    const blockCandidates = [
      { type: BlocklistType.USER_ID, value: user.id },
      { type: BlocklistType.EMAIL_HASH, value: hashEmail(user.email) },
      ...(user.phone ? [{ type: BlocklistType.PHONE_HASH, value: hashPhone(user.phone) }] : []),
      ...devices.map((d) => ({ type: BlocklistType.DEVICE_FINGERPRINT, value: d.fingerprint })),
    ];

    const blockSnaps = await adminDb().getAll(
      ...blockCandidates.map((candidate) =>
        adminDb()
          .collection(COLLECTIONS.blocklist)
          .doc(
            `${candidate.type}__${Buffer.from(candidate.value).toString('base64url')}`.replace(
              /\//g,
              '_',
            ),
          ),
      ),
    );

    const now = new Date();
    const blocks = blockSnaps
      .filter((snap) => snap.exists)
      .map((snap) => snap.data() as Record<string, unknown>)
      .filter((row) => {
        // A null expiry means permanent. Evaluated here rather than in a
        // query, because Firestore cannot express "null OR greater than now".
        const expiresAt = row.expiresAt as { toDate(): Date } | Date | null | undefined;
        if (!expiresAt) return true;
        return (expiresAt instanceof Date ? expiresAt : expiresAt.toDate()) > now;
      })
      .map((row) => ({
        type: row.type,
        reason: row.reason,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        hitCount: row.hitCount,
      }));

    /**
     * The audit trail was `WHERE (entityType='user' AND entityId=:id) OR
     * actorId=:id` - a cross-field OR, which Firestore cannot serve. It runs
     * as two queries whose results are merged and re-sorted, which is exactly
     * what the database would have done internally.
     */
    const [aboutUser, byUser, moderationNotes] = await Promise.all([
      listAuditLogs({ entityType: 'user', entityId: user.id }, 50),
      listAuditLogs({ actorId: user.id }, 50),
      moderationHistory('user', user.id, 50),
    ]);

    const auditEvents = [...aboutUser.rows, ...byUser.rows]
      // The two queries overlap whenever an operator acted on their own row.
      .filter((row, index, all) => all.findIndex((other) => other.id === row.id) === index)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 50);

    const actorIds = [
      ...new Set([
        ...auditEvents.map((e) => e.actorId),
        ...moderationNotes.map((m) => m.moderatorId),
      ]),
    ].filter((id): id is string => Boolean(id));
    const actors = await findUsersByIds(actorIds);

    // Written before the response: an audit row that only appears on success
    // is not an audit row.
    await adminAudit({
      actorId: actor.id,
      action: 'ADMIN_USER_VIEWED',
      entityType: 'user',
      entityId: user.id,
      request,
    });

    return NextResponse.json(
      {
        user: {
          ...user,
          // Credentials are not in the user document at all - the argon2id
          // hash and the PII HMACs live in a separate `credentials`
          // collection that findUserById() never reads. See the header of the
          // users repository for why that split exists.
          university: university
            ? {
                id: university.id,
                code: university.code,
                nameEn: university.nameEn,
                city: university.city,
              }
            : null,
          faculty: faculty ? { id: faculty.id, nameEn: faculty.nameEn } : null,
          frozenBy: frozenBy ? { id: frozenBy.id, nickname: frozenBy.nickname } : null,
          verificationCases: cases.cases.map((c) => ({
            id: c.id,
            status: c.status,
            attempt: c.attempt,
            submittedAt: c.submittedAt,
            decidedAt: c.decidedAt,
            verdict: c.verdict,
            confidence: c.confidence,
            failureCodes: c.failureCodes,
            checkScores: c.checkScores,
            reviewPriority: c.reviewPriority,
            reviewExpiresAt: c.reviewExpiresAt,
            moderatorNote: c.moderatorNote,
            // The buffer KEY is deliberately absent: it is half of the pair
            // that decrypts pending ID documents, and this endpoint has no
            // business handing it out. Reviewing goes through the existing
            // /api/admin/verification/:caseId route.
            decidedByModeratorId: c.decidedByModeratorId,
          })),
          devices: devices.map((d) => ({
            id: d.id,
            label: d.label,
            trusted: d.trusted,
            firstSeenAt: d.firstSeenAt,
            lastSeenAt: d.lastSeenAt,
            fingerprint: shortFingerprint(d.fingerprint),
          })),
          sessions: sessions.map((session) => ({
            id: session.id,
            userAgent: session.userAgent,
            createdAt: session.createdAt,
            lastSeenAt: session.lastSeenAt,
            expiresAt: session.expiresAt,
            revokedAt: session.revokedAt,
            // refreshTokenHash is NOT included. It is the credential itself.
          })),
          /**
           * One shared serialiser for the freeze, so this modal, the users
           * table and the account's own /api/me cannot disagree about whether
           * it is frozen - which is the usual way a stale "Frozen" badge ends
           * up on an account that is already active again.
           */
          freeze: freezeState(user),
        },
        blocks,
        auditEvents: auditEvents.map((e) => ({
          id: e.id,
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId,
          createdAt: e.createdAt,
          userAgent: e.userAgent,
          actor: e.actorId
            ? (() => {
                const found = actors.get(e.actorId);
                return found ? { id: found.id, nickname: found.nickname } : null;
              })()
            : null,
        })),
        moderationNotes: moderationNotes.map((m) => {
          const moderator = actors.get(m.moderatorId);
          return {
            id: m.id,
            action: m.action,
            reason: m.reason,
            createdAt: m.createdAt,
            moderator: moderator ? { id: moderator.id, nickname: moderator.nickname } : null,
          };
        }),
        capabilities: { canManage: actor.isAdmin },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}

/**
 * PATCH /api/admin/users/:userId - account status, role, or an admin note.
 *
 * ADMIN only. A MODERATOR can read this panel and work the verification queue
 * (which is where their authority lies) but cannot change what an account is
 * or who else holds power.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  return withAdmin(request, 'ADMIN', async (actor) => {
    const { userId } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
    }

    const target = await findUserById(userId);
    if (!target || target.deletedAt) {
      return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    }

    const op = (body as { op?: string }).op;

    /**
     * ---------------------------------------------------------------------
     * op = 'freeze' - temporarily suspend an account
     * ---------------------------------------------------------------------
     * Distinct from op='status' with accountStatus=SUSPENDED, even though both
     * end at the same enum member, because a freeze also carries an EXPIRY and
     * a stated reason that the account holder is shown. The expiry is what
     * makes it self-lifting (see requireSession) so that forgetting to
     * unfreeze cannot strand someone indefinitely.
     */
    if (op === 'freeze') {
      const parsed = adminFreezeSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
          { status: 400 },
        );
      }
      if (target.accountStatus === AccountStatus.BANNED) {
        return NextResponse.json({ error: 'admin.users.errors.bannedImmutable' }, { status: 409 });
      }
      // Freezing yourself locks you out of the panel that is the only way to
      // undo it - the same single-actor lockout the role handler refuses.
      if (target.id === actor.id) {
        return NextResponse.json({ error: 'admin.users.errors.cannotActOnSelf' }, { status: 409 });
      }

      const until = parsed.data.until ?? null;

      /**
       * Sequential, not transactional - Firestore cannot span a transaction
       * across these repositories (see the note in src/lib/auth/freeze.ts).
       *
       * The freeze itself is applied FIRST, so an interruption leaves the
       * account restricted with its paper trail incomplete, rather than a
       * complete paper trail describing a freeze that never took effect. Of
       * the two failure modes, only the second one lets someone keep posting.
       */
      await freezeAccount({
        userId,
        actorId: actor.id,
        reason: parsed.data.reason,
        until,
      });
      await writeModerationAction({
        moderatorId: actor.id,
        targetType: 'user',
        targetId: userId,
        action: 'freeze',
        reason: parsed.data.reason,
      });
      await adminAudit({
        actorId: actor.id,
        action: 'ADMIN_USER_FROZEN',
        entityType: 'user',
        entityId: userId,
        before: { accountStatus: target.accountStatus },
        after: {
          accountStatus: AccountStatus.SUSPENDED,
          frozenUntil: until ? until.toISOString() : null,
          reason: parsed.data.reason,
        },
        request,
      });

      // After the commit, never inside it: mail must not be sent for a change
      // that then rolls back, and a provider outage must not fail the freeze.
      sendEmailAsync(target.email, 'accountFrozen', {
        nickname: target.nickname,
        until: until ? until.toISOString().slice(0, 10) : null,
        reason: parsed.data.reason,
      });

      return NextResponse.json({
        ok: true,
        accountStatus: AccountStatus.SUSPENDED,
        freeze: freezeState({
          accountStatus: AccountStatus.SUSPENDED,
          frozenUntil: until,
          frozenReason: parsed.data.reason,
          frozenAt: new Date(),
        }),
      });
    }

    /** op = 'unfreeze' - lift a freeze early. */
    if (op === 'unfreeze') {
      /**
       * unfreezeAccount() returns false when there is nothing to lift, and
       * that check happens BEFORE anything is written - so the early return
       * below cannot leave a half-written trail. The two records that follow
       * only run once the state change is known to have applied.
       */
      const lifted = await unfreezeAccount({ userId });

      if (lifted) {
        await writeModerationAction({
          moderatorId: actor.id,
          targetType: 'user',
          targetId: userId,
          action: 'unfreeze',
          reason: 'Freeze lifted by administrator',
        });
        await adminAudit({
          actorId: actor.id,
          action: 'ADMIN_USER_UNFROZEN',
          entityType: 'user',
          entityId: userId,
          before: {
            accountStatus: target.accountStatus,
            frozenUntil: target.frozenUntil ? target.frozenUntil.toISOString() : null,
          },
          after: { accountStatus: AccountStatus.ACTIVE },
          request,
        });
      }

      if (!lifted) {
        // Nothing to lift: the account is banned, deleted, or already active.
        // 409 rather than a cheerful 200, which would report a success that
        // changed nothing.
        return NextResponse.json({ error: 'admin.users.errors.notFrozen' }, { status: 409 });
      }

      sendEmailAsync(target.email, 'accountUnfrozen', { nickname: target.nickname });

      return NextResponse.json({
        ok: true,
        accountStatus: AccountStatus.ACTIVE,
        freeze: freezeState({ accountStatus: AccountStatus.ACTIVE }),
      });
    }

    if (op === 'status') {
      const parsed = adminStatusChangeSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
          { status: 400 },
        );
      }
      /**
       * A BANNED account is not un-bannable from here.
       *
       * Bans are issued with blocklist rows attached (applyBan). Flipping the
       * column back to ACTIVE would leave those rows in place, producing an
       * account that appears live but whose owner is refused at every signup
       * and login check - a state no code path expects to find.
       */
      if (target.accountStatus === AccountStatus.BANNED) {
        return NextResponse.json({ error: 'admin.users.errors.bannedImmutable' }, { status: 409 });
      }
      if (target.id === actor.id) {
        return NextResponse.json({ error: 'admin.users.errors.cannotActOnSelf' }, { status: 409 });
      }

      const { accountStatus, reason } = parsed.data;

      /**
       * THE ACT FIRST, THEN THE RECORD - and no longer one transaction.
       *
       * These four writes shared a Postgres transaction. They cannot share a
       * Firestore one: revokeUserSessions() touches an unbounded number of
       * session documents and chunks its own batches to stay under the
       * 500-write ceiling.
       *
       * So the order carries the safety instead. The status change and the
       * revocation are the act; the moderation entry and the audit row are the
       * record of it. A failure part-way leaves an enacted change that is
       * under-documented, which is recoverable and visible in the account
       * state. The reverse order would leave a record of a suspension that
       * never took effect - a lie in the audit log.
       */
      await updateUser(userId, { accountStatus });

      // A suspension that leaves live sessions running is decorative: the
      // access token is valid for up to 15 more minutes and requireSession
      // only rejects BANNED/DELETED, so a SUSPENDED user would keep browsing.
      if (accountStatus !== AccountStatus.ACTIVE) {
        await revokeUserSessions(userId);
      }

      await writeModerationAction({
        moderatorId: actor.id,
        targetType: 'user',
        targetId: userId,
        action: `status:${accountStatus.toLowerCase()}`,
        reason,
      });

      await adminAudit({
        actorId: actor.id,
        action: 'ADMIN_USER_STATUS_CHANGED',
        entityType: 'user',
        entityId: userId,
        before: { accountStatus: target.accountStatus },
        after: { accountStatus, reason },
        request,
      });

      if (accountStatus === AccountStatus.ACTIVE) {
        sendEmailAsync(target.email, 'accountReactivated', { nickname: target.nickname });
      } else {
        // RESTRICTED or SUSPENDED - the only other values this schema allows.
        // Bans go through the verification decision and email from there.
        sendEmailAsync(target.email, 'accountSuspended', {
          nickname: target.nickname,
          level: accountStatus === AccountStatus.RESTRICTED ? 'restricted' : 'suspended',
          reason,
        });
      }

      return NextResponse.json({ ok: true, accountStatus });
    }

    /**
     * ---------------------------------------------------------------------
     * op = 'verification' - set the account's verification outcome
     * ---------------------------------------------------------------------
     * For accounts with no live case to work. The moderation console remains
     * the only path that can see documents or ban for fraud; this only moves
     * the flag, always with a reason and an audit row.
     */
    if (op === 'verification') {
      const parsed = adminVerificationSetSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
          { status: 400 },
        );
      }
      if (target.id === actor.id) {
        return NextResponse.json({ error: 'admin.users.errors.cannotActOnSelf' }, { status: 409 });
      }
      if (target.accountStatus === AccountStatus.BANNED) {
        return NextResponse.json({ error: 'admin.users.errors.bannedImmutable' }, { status: 409 });
      }

      const { verificationStatus, reason, role } = parsed.data;
      const approving = verificationStatus === VerificationStatus.VERIFIED;

      // The privileged-grant acknowledgement is re-checked here rather than
      // trusted from the dialog: a caller that skips the UI must not skip the
      // safeguard the UI exists to present.
      if (role && PRIVILEGED_ROLES.has(role) && parsed.data.confirmPrivileged !== true) {
        return NextResponse.json(
          { error: 'admin.users.errors.confirmPrivilegedRequired' },
          { status: 400 },
        );
      }

      const now = new Date();

      // The act, then the record - see the note in the status branch above.
      await updateUser(userId, {
        verificationStatus,
        isVerified: approving,
        verifiedAt: approving ? now : null,
        // These two are claims about DOCUMENTS the pipeline confirmed.
        // Withdrawing verification must withdraw them too, or a rejected
        // account keeps asserting its ID was checked.
        studentStatusConfirmed: approving,
        identityConfirmed: approving,
        ...(role ? { role } : {}),
      });

      if (role && PRIVILEGED_ROLES.has(role) !== PRIVILEGED_ROLES.has(target.role)) {
        await revokeUserSessions(userId);
      }

      await writeModerationAction({
        moderatorId: actor.id,
        targetType: 'user',
        targetId: userId,
        action: `verification:${verificationStatus.toLowerCase()}`,
        reason,
      });

      await enqueueNotification({ skipEmail: true,
        userId,
        type: approving ? 'VERIFICATION_APPROVED' : 'VERIFICATION_REJECTED',
        titleKey: approving
          ? 'notifications.types.VERIFICATION_APPROVED'
          : 'notifications.types.VERIFICATION_REJECTED',
        bodyKey: approving ? 'verification.badge.verified' : 'verification.banner.rejected',
        linkUrl: approving ? '/dashboard' : '/verify',
      });

      await adminAudit({
        actorId: actor.id,
        action: approving ? 'ADMIN_USER_VERIFIED' : 'ADMIN_USER_VERIFICATION_REJECTED',
        entityType: 'user',
        entityId: userId,
        before: { verificationStatus: target.verificationStatus, role: target.role },
        after: { verificationStatus, role: role ?? target.role, reason },
        request,
      });

      // `reason` is the operator's internal note and is deliberately NOT
      // forwarded to the user - see the note in templates.ts.
      sendEmailAsync(
        target.email,
        approving ? 'verificationApproved' : 'verificationRejected',
        approving
          ? { nickname: target.nickname }
          : { nickname: target.nickname, reason: null, canResubmit: true },
      );

      if (role && role !== target.role) {
        sendEmailAsync(target.email, 'roleAssigned', { nickname: target.nickname, role });
      }

      return NextResponse.json({ ok: true, verificationStatus, role: role ?? target.role });
    }

    if (op === 'role') {
      const parsed = adminRoleChangeSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
          { status: 400 },
        );
      }
      /**
       * An admin cannot change their own role.
       *
       * Not paternalism: it closes the only single-actor path to locking the
       * platform out of its own admin panel. Demoting the last ADMIN is
       * unrecoverable without database access, and self-demotion by mis-click
       * is exactly how that happens.
       */
      if (target.id === actor.id) {
        return NextResponse.json({ error: 'admin.users.errors.cannotActOnSelf' }, { status: 409 });
      }

      const { role, reason } = parsed.data;

      // Removing the last ADMIN has the same effect as self-demotion, just
      // with an extra step, so it is refused for the same reason.
      if (target.role === UserRole.ADMIN && role !== UserRole.ADMIN) {
        /**
         * `id != userId` was part of the SQL predicate; Firestore permits only
         * one inequality per query and `deletedAt == null` already uses the
         * equality slot, so the target is excluded by subtracting it here.
         * Same answer, one fewer index.
         */
        const admins = await countUsers({ role: UserRole.ADMIN, deletedAt: null });
        const remaining = admins - (target.role === UserRole.ADMIN ? 1 : 0);
        if (remaining <= 0) {
          return NextResponse.json({ error: 'admin.users.errors.lastAdmin' }, { status: 409 });
        }
      }

      /**
       * A privilege change takes effect on the NEXT REQUEST, not on the next
       * login, so live sessions are revoked whenever the grant crosses the
       * staff boundary in either direction.
       *
       * Demotion is the obvious case: a moderator who has just lost the panel
       * must not keep working from an open tab. Promotion matters too, because
       * the access token's lifetime is chosen from the role at issue time (see
       * accessTtlFor) - a newly promoted admin holding a student-length token
       * would be signed out mid-review, which is the very complaint the longer
       * staff session exists to fix. Re-authenticating mints the right one.
       */
      const crossesStaffBoundary =
        PRIVILEGED_ROLES.has(role) !== PRIVILEGED_ROLES.has(target.role);

      // The act, then the record - see the note in the status branch above.
      await updateUser(userId, { role });

      if (crossesStaffBoundary) {
        await revokeUserSessions(userId);
      }

      await writeModerationAction({
        moderatorId: actor.id,
        targetType: 'user',
        targetId: userId,
        action: `role:${role.toLowerCase()}`,
        reason,
      });

      /**
       * Tell the account holder. An unexpected role change is a strong signal
       * that someone else is in their account, and it is exactly the kind of
       * event a person should never learn about only by noticing new buttons.
       */
      await enqueueNotification({ skipEmail: true,
        userId,
        type: 'SYSTEM',
        titleKey: 'notifications.roleChanged.title',
        bodyKey: 'notifications.roleChanged.body',
        params: { role },
        linkUrl: '/settings',
      });

      await adminAudit({
        actorId: actor.id,
        action: 'ADMIN_USER_ROLE_CHANGED',
        entityType: 'user',
        entityId: userId,
        before: { role: target.role },
        after: { role, reason, privileged: PRIVILEGED_ROLES.has(role) },
        request,
      });

      sendEmailAsync(target.email, 'roleAssigned', { nickname: target.nickname, role });

      return NextResponse.json({ ok: true, role, sessionsRevoked: crossesStaffBoundary });
    }

    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  });
}

/**
 * DELETE /api/admin/users/:userId - soft delete.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOES NOT ACTUALLY DELETE THE DOCUMENT
 * ---------------------------------------------------------------------------
 * The schema already answers this. `User.deletedAt` exists, AccountStatus has a
 * DELETED member, and requireSession refuses both - so soft deletion is the
 * established pattern and this follows it rather than inventing a second one.
 *
 * A hard delete would also be actively destructive in three ways:
 *
 *  - audit_logs.actorId is onDelete: SetNull, so every action the user ever
 *    took would become anonymous. That defeats the retention requirement the
 *    append-only grant on audit_logs exists to enforce.
 *  - sessions, devices, posts, comments and wallet rows cascade. Deleting an
 *    account would silently delete its ledger history, and the double-entry
 *    invariants in 0001_invariants.sql are not written to survive that.
 *  - emailHash and phoneHash are unique and documented as surviving deletion
 *    precisely so a banned identity cannot be recycled. Removing the row
 *    hands the address back.
 *
 * So the row stays, the identifiers stay, sessions die, and the account is
 * excluded from every listing and from login.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  return withAdmin(request, 'ADMIN', async (actor) => {
    const { userId } = await params;
    const parsed = adminDeleteUserSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const target = await findUserById(userId);
    if (!target || target.deletedAt) {
      return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    }
    // Server-side re-check of the confirmation the dialog asked for. A client
    // that skips the dialog must not skip the safeguard.
    if (parsed.data.confirmNickname !== target.nickname) {
      return NextResponse.json({ error: 'admin.users.errors.confirmMismatch' }, { status: 400 });
    }

    // Self-action, last-admin guard, the soft delete itself, sessions, email,
    // moderation record and audit: one shared implementation, also used when
    // an admin approves a user's own deletion request.
    try {
      const deletedAt = await softDeleteAccount({
        userId,
        actorId: actor.id,
        reason: parsed.data.reason,
        source: 'ADMIN',
        request,
      });
      return NextResponse.json({ ok: true, deletedAt: deletedAt.toISOString() });
    } catch (error) {
      if (error instanceof AccountDeletionError) {
        return NextResponse.json({ error: error.messageKey }, { status: error.status });
      }
      throw error;
    }
  });
}
