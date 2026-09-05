-- CampusHub: zero-retention enforcement.
--
-- The zero-retention policy is a legal commitment, and a legal commitment that
-- depends on every future developer remembering a rule is not a commitment.
-- This migration makes the database refuse to hold identity-document data,
-- so a well-meaning "let's just cache the OCR result" PR fails at runtime in
-- CI rather than in a regulator's report.
--
-- Applied after 0001_invariants.sql via `npm run db:invariants`.

-- ---------------------------------------------------------------
-- 1. checkScores may contain numbers only.
--
-- This column exists so moderators and model monitoring can see per-check
-- confidence. It is the single most tempting place to smuggle extracted text
-- ("just the name, so the reviewer has context"). A JSONB type check closes
-- that door: any string, array, or nested object value is rejected on write.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_scores_are_numeric(payload jsonb)
RETURNS boolean AS $$
BEGIN
  IF payload IS NULL THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(payload) <> 'object' THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1
    FROM jsonb_each(payload) AS entry(key, value)
    WHERE jsonb_typeof(entry.value) <> 'number'
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE verification_cases
  ADD CONSTRAINT verification_check_scores_numeric_only
  CHECK (check_scores_are_numeric("checkScores"));

-- ---------------------------------------------------------------
-- 2. failureCodes may contain enum-shaped codes only.
--
-- Same reasoning: a code is a category ('NAME_MISMATCH'), never a value
-- ('mismatch: ELVIN SEFEROV vs E. SEFEROV'). Upper snake case, 64 chars max.
-- ---------------------------------------------------------------
ALTER TABLE verification_cases
  ADD CONSTRAINT verification_failure_codes_are_codes
  CHECK (
    "failureCodes" IS NULL
    OR (
      SELECT bool_and(code ~ '^[A-Z][A-Z0-9_]{2,63}$')
      FROM unnest("failureCodes") AS code
    )
  );

-- ---------------------------------------------------------------
-- 3. A review buffer must always carry an expiry, and that expiry must be
--    short. Without this, a NULL reviewExpiresAt would mean "keep forever" -
--    exactly the failure mode this whole design exists to prevent.
-- ---------------------------------------------------------------
ALTER TABLE verification_cases
  ADD CONSTRAINT verification_review_buffer_requires_expiry
  CHECK (
    ("reviewBufferKey" IS NULL AND "reviewExpiresAt" IS NULL)
    OR (
      "reviewBufferKey" IS NOT NULL
      AND "reviewExpiresAt" IS NOT NULL
      AND "reviewExpiresAt" <= "submittedAt" + interval '72 hours'
    )
  );

-- ---------------------------------------------------------------
-- 4. Structural guard: no table may grow a column that looks like durable
--    document storage.
--
-- An event trigger is heavy-handed on purpose. The alternative is a code
-- review checklist, and checklists lose to deadlines. If a legitimate need
-- ever arises, dropping this trigger is a deliberate, reviewable, logged act -
-- which is precisely the conversation we want to force.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_document_storage_columns()
RETURNS event_trigger AS $$
DECLARE
  obj record;
  offending record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
             WHERE object_type IN ('table', 'table column')
  LOOP
    FOR offending IN
      SELECT c.relname AS table_name, a.attname AS column_name
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = obj.objid
        AND n.nspname = 'public'
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND c.relname IN ('verification_cases', 'users')
        AND (
          a.attname ILIKE '%document%image%'
          OR a.attname ILIKE '%id_card%'
          OR a.attname ILIKE '%passport%'
          OR a.attname ILIKE '%ocr%'
          OR a.attname ILIKE '%national_id%'
          OR a.attname ILIKE '%nationalId%'
          OR a.attname ILIKE '%storagekey%'
          OR a.attname ILIKE '%storage_key%'
        )
    LOOP
      RAISE EXCEPTION
        'Zero-retention policy: column %.% is not permitted. Identity documents must never be persisted. See docs/SECURITY.md section 3.',
        offending.table_name, offending.column_name
        USING ERRCODE = 'insufficient_privilege';
    END LOOP;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE EVENT TRIGGER enforce_zero_retention
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'ALTER TABLE')
  EXECUTE FUNCTION reject_document_storage_columns();

-- ---------------------------------------------------------------
-- 5. Blocklist may never contain a network-level entry.
--
-- BlocklistType has no IP member, so this is belt and braces against someone
-- adding one to the enum without reading why it is absent.
-- ---------------------------------------------------------------
ALTER TABLE blocklist
  ADD CONSTRAINT blocklist_no_network_identifiers
  CHECK (type::text NOT IN ('IP', 'IP_CIDR', 'SUBNET', 'ASN'));

-- Device blocks must expire; account-identifier blocks may be permanent.
-- A fingerprint outlives its owner: second-hand phones and shared university
-- lab machines would otherwise carry a stranger's ban indefinitely.
ALTER TABLE blocklist
  ADD CONSTRAINT blocklist_device_blocks_expire
  CHECK (
    type::text <> 'DEVICE_FINGERPRINT'
    OR "expiresAt" IS NOT NULL
  );

-- ---------------------------------------------------------------
-- 6. Graduation sweep support (1 May cron).
--
-- Partial index: the annual job scans only users who have a graduation date
-- and have not already transitioned. On a 100k-user table this is a few
-- thousand rows, not a sequential scan.
-- ---------------------------------------------------------------
CREATE INDEX IF NOT EXISTS users_graduation_sweep_idx
  ON users ("graduationYear", "graduationMonth")
  WHERE "alumniTransitionedAt" IS NULL
    AND "graduationYear" IS NOT NULL
    AND "deletedAt" IS NULL;

-- ---------------------------------------------------------------
-- 7. Expired review buffers must be reapable cheaply.
-- ---------------------------------------------------------------
CREATE INDEX IF NOT EXISTS verification_expired_buffers_idx
  ON verification_cases ("reviewExpiresAt")
  WHERE "reviewBufferKey" IS NOT NULL;

-- ---------------------------------------------------------------
-- 8. Nickname hygiene.
--
-- Case-insensitive uniqueness: "Aysel" and "aysel" must not be two accounts,
-- because impersonation via casing is the oldest trick on any social product.
-- Prisma's @unique is case-sensitive, so the real constraint lives here.
-- ---------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS users_nickname_lower_idx ON users (lower(nickname));

ALTER TABLE users
  ADD CONSTRAINT users_nickname_format
  CHECK (nickname ~ '^[a-zA-Z0-9_]{3,24}$');
