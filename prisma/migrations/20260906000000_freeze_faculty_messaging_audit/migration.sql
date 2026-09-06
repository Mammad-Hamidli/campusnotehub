-- CampusHub: account freeze, faculty catalogue, messaging, audit accountability.
--
-- Every statement here is additive. No column is dropped, no column is
-- narrowed, and no row is rewritten, so applying this to a populated database
-- cannot lose data. New columns are all NULLable precisely so the backfill is
-- "nothing to do" rather than a table rewrite under an ACCESS EXCLUSIVE lock.

-- ---------------------------------------------------------------
-- 1. Temporary account freeze.
--
-- The freeze is AccountStatus.SUSPENDED plus an expiry, reusing the enum
-- member that already means "temporary" rather than adding a FROZEN member
-- that every existing status comparison would have to be audited for.
-- ---------------------------------------------------------------
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "frozenUntil"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "frozenReason" VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS "frozenById"   TEXT,
  ADD COLUMN IF NOT EXISTS "frozenAt"     TIMESTAMP(3);

DO $$
BEGIN
  ALTER TABLE "users"
    ADD CONSTRAINT "users_frozenById_fkey"
    FOREIGN KEY ("frozenById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Partial index: the "lift expired freezes" sweep touches only frozen rows,
-- which is a handful out of the whole table.
CREATE INDEX IF NOT EXISTS "users_frozen_until_idx"
  ON "users" ("frozenUntil") WHERE "frozenUntil" IS NOT NULL;

-- ---------------------------------------------------------------
-- 2. Faculty as chosen at registration.
--
-- A catalogue slug, not a per-university FK. The existing facultyId relation
-- is untouched - see the note in schema.prisma for why it stays.
-- ---------------------------------------------------------------
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "facultySlug"  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "facultyOther" VARCHAR(120);

-- The two columns are only coherent together: free text is meaningful ONLY
-- when the catalogue choice was "other". Without this the pair can drift into
-- a state ("Computer Science" + "Basket Weaving") that no reader expects and
-- every reader would have to defend against.
DO $$
BEGIN
  ALTER TABLE "users"
    ADD CONSTRAINT "users_faculty_other_requires_slug"
    CHECK (
      ("facultyOther" IS NULL)
      OR ("facultySlug" = 'other' AND length(btrim("facultyOther")) > 0)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------
-- 3. Audit log: admin accountability fields.
--
-- Read the comment on AuditLog.ip in schema.prisma before touching this.
-- The "no IP banning" rule is NOT relaxed here: BlocklistType still has no IP
-- member and the CHECK in 0002 still refuses one. This records the address of
-- a STAFF member exercising privilege, which is the opposite situation from
-- sanctioning a shared student address.
-- ---------------------------------------------------------------
ALTER TABLE "audit_logs"
  ADD COLUMN IF NOT EXISTS "ip"     VARCHAR(45),
  ADD COLUMN IF NOT EXISTS "result" VARCHAR(24);

CREATE INDEX IF NOT EXISTS "audit_logs_createdAt_idx"
  ON "audit_logs" ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "audit_logs_action_createdAt_idx"
  ON "audit_logs" ("action", "createdAt" DESC);

-- ---------------------------------------------------------------
-- 4. Verification queue housekeeping.
--
-- "Clear this row off my screen" - explicitly NOT a delete and NOT a status
-- change. The case row, its verdict and its audit trail all survive; only the
-- queue view filters on this column, and clearing it restores the row.
-- ---------------------------------------------------------------
ALTER TABLE "verification_cases"
  ADD COLUMN IF NOT EXISTS "dismissedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "dismissedById" TEXT;

DO $$
BEGIN
  ALTER TABLE "verification_cases"
    ADD CONSTRAINT "verification_cases_dismissedById_fkey"
    FOREIGN KEY ("dismissedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "verification_cases_dismissedAt_idx"
  ON "verification_cases" ("dismissedAt");

-- ---------------------------------------------------------------
-- 5. Review-buffer retention: 72 hours -> 7 days.
--
-- The constraint is REPLACED rather than dropped, so the invariant "a buffer
-- always carries an expiry" is never absent - only its ceiling moves. A buffer
-- with no expiry is still refused, which is the half that actually enforces
-- zero retention.
--
-- The moderator queue was expiring flagged submissions faster than a human
-- rota could reach them, which turned an ambiguous case into a forced resubmit
-- and pushed the student back to the start of the funnel. Seven days is the
-- product decision; the mechanism is unchanged, and Redis still enforces the
-- real deletion via its own TTL.
-- ---------------------------------------------------------------
ALTER TABLE "verification_cases"
  DROP CONSTRAINT IF EXISTS "verification_review_buffer_requires_expiry";

ALTER TABLE "verification_cases"
  ADD CONSTRAINT "verification_review_buffer_requires_expiry"
  CHECK (
    ("reviewBufferKey" IS NULL AND "reviewExpiresAt" IS NULL)
    OR (
      "reviewBufferKey" IS NOT NULL
      AND "reviewExpiresAt" IS NOT NULL
      AND "reviewExpiresAt" <= "submittedAt" + interval '7 days'
    )
  );

-- ---------------------------------------------------------------
-- 6. Direct messages.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "conversations" (
  "id"            TEXT NOT NULL,
  -- min(idA,idB) : max(idA,idB). Sorted, so it is the same key whichever side
  -- opens the thread; UNIQUE, so the DATABASE resolves the race when both
  -- sides press Message at once, instead of a read-then-write in application
  -- code that loses under exactly that concurrency.
  "pairKey"       VARCHAR(64) NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "conversations_pairKey_key"
  ON "conversations" ("pairKey");
CREATE INDEX IF NOT EXISTS "conversations_lastMessageAt_idx"
  ON "conversations" ("lastMessageAt" DESC);

CREATE TABLE IF NOT EXISTS "conversation_members" (
  "conversationId" TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  -- Read cursor, not a per-message flag: the unread count is one indexed
  -- COUNT and marking a thread read is one UPDATE, rather than a write per
  -- message per participant.
  "lastReadAt"     TIMESTAMP(3),
  "archivedAt"     TIMESTAMP(3),
  "joinedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_members_pkey" PRIMARY KEY ("conversationId","userId")
);

CREATE INDEX IF NOT EXISTS "conversation_members_userId_conversationId_idx"
  ON "conversation_members" ("userId","conversationId");

CREATE TABLE IF NOT EXISTS "messages" (
  "id"             TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "senderId"       TEXT NOT NULL,
  "body"           VARCHAR(4000) NOT NULL,
  "isDeleted"      BOOLEAN NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "editedAt"       TIMESTAMP(3),
  CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "messages_conversationId_createdAt_idx"
  ON "messages" ("conversationId","createdAt");

DO $$
BEGIN
  ALTER TABLE "conversation_members"
    ADD CONSTRAINT "conversation_members_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "conversation_members"
    ADD CONSTRAINT "conversation_members_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "messages"
    ADD CONSTRAINT "messages_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "messages"
    ADD CONSTRAINT "messages_senderId_fkey"
    FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
