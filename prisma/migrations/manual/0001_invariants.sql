-- CampusHub: invariants Prisma cannot express in schema.prisma.
-- Applied after `prisma migrate deploy` via `npm run db:invariants`.

-- ---------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- for the booking overlap constraint
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- note/mentor fuzzy search
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------
-- 2. Value constraints
-- ---------------------------------------------------------------
ALTER TABLE note_reviews
  ADD CONSTRAINT note_reviews_rating_range CHECK (rating BETWEEN 1 AND 5);

ALTER TABLE mentor_reviews
  ADD CONSTRAINT mentor_reviews_rating_range CHECK (rating BETWEEN 1 AND 5);

ALTER TABLE notes
  ADD CONSTRAINT notes_price_nonnegative CHECK ("priceMinor" >= 0),
  -- 50 AZN ceiling stops laundering through absurdly priced PDFs
  ADD CONSTRAINT notes_price_ceiling CHECK ("priceMinor" <= 5000);

ALTER TABLE orders
  ADD CONSTRAINT orders_fee_split CHECK (
    "priceMinor" = "platformFeeMinor" + "sellerNetMinor"
    AND "platformFeeMinor" >= 0
    AND "sellerNetMinor" >= 0
  );

ALTER TABLE wallets
  ADD CONSTRAINT wallets_no_negative_balance CHECK (
    "availableMinor" >= 0 AND "pendingMinor" >= 0
  );

ALTER TABLE availability_rules
  ADD CONSTRAINT availability_window_valid CHECK (
    "startMinute" >= 0 AND "endMinute" <= 1440 AND "startMinute" < "endMinute"
  ),
  ADD CONSTRAINT availability_weekday_valid CHECK (weekday BETWEEN 0 AND 6);

ALTER TABLE bookings
  ADD CONSTRAINT bookings_time_order CHECK ("endsAt" > "startsAt");

ALTER TABLE users
  ADD CONSTRAINT users_graduation_month_valid CHECK (
    "graduationMonth" IS NULL OR "graduationMonth" BETWEEN 1 AND 12
  );

-- ---------------------------------------------------------------
-- 3. Booking overlap: a mentor can never hold two overlapping live slots.
--    The unique(mentorId,startsAt) index is not enough - a 45-min session
--    starting 15 min into another one would slip through.
-- ---------------------------------------------------------------
ALTER TABLE bookings
  ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    "mentorId" WITH =,
    tstzrange("startsAt", "endsAt", '[)') WITH &&
  )
  WHERE (status IN ('REQUESTED', 'CONFIRMED', 'RESCHEDULED'));

-- ---------------------------------------------------------------
-- 4. Double-entry invariant: every ledger transaction must net to zero.
--    Deferred so a multi-statement transaction can insert legs one by one.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_ledger_balanced() RETURNS TRIGGER AS $$
DECLARE
  imbalance BIGINT;
BEGIN
  SELECT COALESCE(SUM("amountMinor"), 0) INTO imbalance
  FROM ledger_entries
  WHERE "transactionId" = COALESCE(NEW."transactionId", OLD."transactionId");

  IF imbalance <> 0 THEN
    RAISE EXCEPTION 'Ledger transaction % is unbalanced by % minor units',
      COALESCE(NEW."transactionId", OLD."transactionId"), imbalance
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_balanced();

-- Ledger rows are immutable history: no UPDATE, no DELETE.
CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- ---------------------------------------------------------------
-- 5. Audit log is append-only for the application role.
-- ---------------------------------------------------------------
REVOKE UPDATE, DELETE ON audit_logs FROM campushub_app;
REVOKE UPDATE, DELETE ON moderation_actions FROM campushub_app;

-- NOTE: there is no verification_documents table any more. Under the
-- zero-retention policy documents never reach the database, so there is
-- nothing here to grant or revoke. See 0002_zero_retention.sql for the
-- constraints that keep it that way.

-- ---------------------------------------------------------------
-- 6. Full-text search for UniNotes (AZ/EN/RU mixed corpus).
--    'simple' config avoids stemming a language we did not configure;
--    trigram index carries fuzzy matching for Azerbaijani.
-- ---------------------------------------------------------------
ALTER TABLE notes ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("courseCode", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(subject, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'C') ||
    setweight(to_tsvector('simple', left(coalesce("searchText", ''), 100000)), 'D')
  ) STORED;

CREATE INDEX IF NOT EXISTS notes_search_tsv_idx ON notes USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS notes_title_trgm_idx ON notes USING gin (title gin_trgm_ops);

-- Feed keyset pagination support.
CREATE INDEX IF NOT EXISTS posts_feed_keyset_idx
  ON posts ("createdAt" DESC, id DESC)
  WHERE "isDeleted" = false;

-- Only one live verification case per user at a time.
CREATE UNIQUE INDEX IF NOT EXISTS verification_cases_one_open_per_user
  ON verification_cases ("userId")
  WHERE status IN ('PROCESSING', 'NEEDS_REVIEW');
