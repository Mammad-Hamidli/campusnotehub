import { NextResponse, type NextRequest } from 'next/server';
import { AccountStatus, BlocklistType, UserRole, VerificationStatus } from '@prisma/client';
import { db } from '@/lib/db';
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
import { sendEmailAsync } from '@/lib/email/send';
import { hashEmail, hashPhone } from '@/lib/crypto/hash';
import { shortFingerprint } from '@/lib/admin/redact';

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

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        nickname: true,
        email: true,
        phone: true,
        avatarUrl: true,
        headline: true,
        bio: true,
        locale: true,
        timezone: true,
        role: true,
        accountStatus: true,
        frozenUntil: true,
        frozenReason: true,
        frozenAt: true,
        frozenBy: { select: { id: true, nickname: true } },
        facultySlug: true,
        facultyOther: true,
        verificationStatus: true,
        isVerified: true,
        verifiedAt: true,
        studentStatusConfirmed: true,
        identityConfirmed: true,
        graduationYear: true,
        graduationMonth: true,
        alumniTransitionedAt: true,
        emailVerifiedAt: true,
        lastLoginAt: true,
        failedLoginCount: true,
        lockedUntil: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        university: { select: { id: true, code: true, nameEn: true, city: true } },
        faculty: { select: { id: true, nameEn: true } },
        verificationCases: {
          orderBy: { submittedAt: 'desc' },
          select: {
            id: true,
            status: true,
            attempt: true,
            submittedAt: true,
            decidedAt: true,
            verdict: true,
            confidence: true,
            failureCodes: true,
            checkScores: true,
            reviewPriority: true,
            reviewExpiresAt: true,
            moderatorNote: true,
            // The buffer KEY is deliberately absent: it is half of the pair
            // that decrypts pending ID documents, and this endpoint has no
            // business handing it out. Reviewing goes through the existing
            // /api/admin/verification/:caseId route.
            decidedByModerator: { select: { id: true, nickname: true, fullName: true } },
          },
        },
        devices: {
          orderBy: { lastSeenAt: 'desc' },
          select: { id: true, fingerprint: true, label: true, trusted: true, firstSeenAt: true, lastSeenAt: true },
        },
        sessions: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          // refreshTokenHash is NOT selected. It is the credential itself.
          select: { id: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true, revokedAt: true },
        },
      },
    });

    if (!user) {
      return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    }

    /**
     * Blocklist status, as booleans.
     *
     * The blocklist stores HMACs, so the only way to answer "is this account
     * blocked" is to hash the account's own identifiers and look for a match.
     * That is done here rather than returning rows, because a row would expose
     * the hash - and a hash of a known-plaintext email is a lookup key for
     * every other blocklist entry.
     */
    const blockCandidates = [
      { type: BlocklistType.USER_ID, value: user.id },
      { type: BlocklistType.EMAIL_HASH, value: hashEmail(user.email) },
      ...(user.phone ? [{ type: BlocklistType.PHONE_HASH, value: hashPhone(user.phone) }] : []),
      ...user.devices.map((d) => ({ type: BlocklistType.DEVICE_FINGERPRINT, value: d.fingerprint })),
    ];
    const blocks = await db.blocklist.findMany({
      where: {
        OR: blockCandidates,
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
      },
      select: { type: true, reason: true, expiresAt: true, createdAt: true, hitCount: true },
    });

    const [auditEvents, moderationNotes] = await Promise.all([
      db.auditLog.findMany({
        where: { OR: [{ entityType: 'user', entityId: user.id }, { actorId: user.id }] },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          createdAt: true,
          userAgent: true,
          actor: { select: { id: true, nickname: true } },
        },
      }),
      db.moderationAction.findMany({
        where: { targetType: 'user', targetId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          action: true,
          reason: true,
          createdAt: true,
          moderator: { select: { id: true, nickname: true } },
        },
      }),
    ]);

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
          devices: user.devices.map((d) => ({
            ...d,
            fingerprint: shortFingerprint(d.fingerprint),
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
        auditEvents,
        moderationNotes,
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

    const target = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        nickname: true,
        email: true,
        role: true,
        accountStatus: true,
        verificationStatus: true,
        frozenUntil: true,
        deletedAt: true,
      },
    });
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

      await db.$transaction(async (tx) => {
        await freezeAccount({
          tx,
          userId,
          actorId: actor.id,
          reason: parsed.data.reason,
          until,
        });
        await tx.moderationAction.create({
          data: {
            moderatorId: actor.id,
            targetType: 'user',
            targetId: userId,
            action: 'freeze',
            reason: parsed.data.reason,
          },
        });
        await adminAudit({
          tx,
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
      const lifted = await db.$transaction(async (tx) => {
        const ok = await unfreezeAccount({ tx, userId });
        if (!ok) return false;

        await tx.moderationAction.create({
          data: {
            moderatorId: actor.id,
            targetType: 'user',
            targetId: userId,
            action: 'unfreeze',
            reason: 'Freeze lifted by administrator',
          },
        });
        await adminAudit({
          tx,
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
        return true;
      });

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

      await db.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { accountStatus } });

        // A suspension that leaves live sessions running is decorative: the
        // access token is valid for up to 15 more minutes and requireSession
        // only rejects BANNED/DELETED, so a SUSPENDED user would keep browsing.
        if (accountStatus !== AccountStatus.ACTIVE) {
          await tx.session.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }

        await tx.moderationAction.create({
          data: {
            moderatorId: actor.id,
            targetType: 'user',
            targetId: userId,
            action: `status:${accountStatus.toLowerCase()}`,
            reason,
          },
        });

        await adminAudit({
          tx,
          actorId: actor.id,
          action: 'ADMIN_USER_STATUS_CHANGED',
          entityType: 'user',
          entityId: userId,
          before: { accountStatus: target.accountStatus },
          after: { accountStatus, reason },
          request,
        });
      });

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

      await db.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: {
            verificationStatus,
            isVerified: approving,
            verifiedAt: approving ? now : null,
            // These two are claims about DOCUMENTS the pipeline confirmed.
            // Withdrawing verification must withdraw them too, or a rejected
            // account keeps asserting its ID was checked.
            studentStatusConfirmed: approving,
            identityConfirmed: approving,
            ...(role ? { role } : {}),
          },
        });

        if (role && PRIVILEGED_ROLES.has(role) !== PRIVILEGED_ROLES.has(target.role)) {
          await tx.session.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: now },
          });
        }

        await tx.moderationAction.create({
          data: {
            moderatorId: actor.id,
            targetType: 'user',
            targetId: userId,
            action: `verification:${verificationStatus.toLowerCase()}`,
            reason,
          },
        });

        await tx.notification.create({
          data: {
            userId,
            type: approving ? 'VERIFICATION_APPROVED' : 'VERIFICATION_REJECTED',
            titleKey: approving
              ? 'notifications.types.VERIFICATION_APPROVED'
              : 'notifications.types.VERIFICATION_REJECTED',
            bodyKey: approving ? 'verification.badge.verified' : 'verification.banner.rejected',
            linkUrl: approving ? '/dashboard' : '/verify',
          },
        });

        await adminAudit({
          tx,
          actorId: actor.id,
          action: approving ? 'ADMIN_USER_VERIFIED' : 'ADMIN_USER_VERIFICATION_REJECTED',
          entityType: 'user',
          entityId: userId,
          before: { verificationStatus: target.verificationStatus, role: target.role },
          after: { verificationStatus, role: role ?? target.role, reason },
          request,
        });
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
        const remaining = await db.user.count({
          where: { role: UserRole.ADMIN, deletedAt: null, id: { not: userId } },
        });
        if (remaining === 0) {
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

      await db.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { role } });

        if (crossesStaffBoundary) {
          await tx.session.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }

        await tx.moderationAction.create({
          data: {
            moderatorId: actor.id,
            targetType: 'user',
            targetId: userId,
            action: `role:${role.toLowerCase()}`,
            reason,
          },
        });

        /**
         * Tell the account holder. An unexpected role change is a strong
         * signal that someone else is in their account, and it is exactly the
         * kind of event a person should never learn about only by noticing new
         * buttons.
         */
        await tx.notification.create({
          data: {
            userId,
            type: 'SYSTEM',
            titleKey: 'notifications.roleChanged.title',
            bodyKey: 'notifications.roleChanged.body',
            params: { role },
            linkUrl: '/settings',
          },
        });

        await adminAudit({
          tx,
          actorId: actor.id,
          action: 'ADMIN_USER_ROLE_CHANGED',
          entityType: 'user',
          entityId: userId,
          before: { role: target.role },
          after: { role, reason, privileged: PRIVILEGED_ROLES.has(role) },
          request,
        });
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
 * WHY THIS DOES NOT ISSUE A `db.user.delete`
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

    const target = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, nickname: true, role: true, accountStatus: true, deletedAt: true },
    });
    if (!target || target.deletedAt) {
      return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    }
    if (target.id === actor.id) {
      return NextResponse.json({ error: 'admin.users.errors.cannotActOnSelf' }, { status: 409 });
    }
    // Server-side re-check of the confirmation the dialog asked for. A client
    // that skips the dialog must not skip the safeguard.
    if (parsed.data.confirmNickname !== target.nickname) {
      return NextResponse.json({ error: 'admin.users.errors.confirmMismatch' }, { status: 400 });
    }
    if (target.role === UserRole.ADMIN) {
      const remaining = await db.user.count({
        where: { role: UserRole.ADMIN, deletedAt: null, id: { not: userId } },
      });
      if (remaining === 0) {
        return NextResponse.json({ error: 'admin.users.errors.lastAdmin' }, { status: 409 });
      }
    }

    const now = new Date();

    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { deletedAt: now, accountStatus: AccountStatus.DELETED },
      });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.moderationAction.create({
        data: {
          moderatorId: actor.id,
          targetType: 'user',
          targetId: userId,
          action: 'delete',
          reason: parsed.data.reason,
        },
      });
      await adminAudit({
        tx,
        actorId: actor.id,
        action: 'ADMIN_USER_DELETED',
        entityType: 'user',
        entityId: userId,
        before: { accountStatus: target.accountStatus, deletedAt: null },
        after: { accountStatus: AccountStatus.DELETED, reason: parsed.data.reason },
        request,
      });
    });

    return NextResponse.json({ ok: true, deletedAt: now.toISOString() });
  });
}
