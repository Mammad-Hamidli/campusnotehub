-- Post images.
--
-- Additive: one new table, one nullable column added to post_media. Nothing is
-- dropped or narrowed, so this cannot lose data on a populated database.

-- ---------------------------------------------------------------
-- 1. The blob store.
--
-- Postgres rather than S3, following the pattern note_attachments already
-- establishes. The S3 helpers exist and the bucket names are configured, but
-- no environment here carries credentials, so a direct-to-S3 flow would be a
-- feature that cannot run. `storageKey` on post_media stays the logical
-- locator: today it reads `db://media/<id>`, and if this moves to object
-- storage it becomes an object key with nothing above it changing.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "media_assets" (
  "id"        TEXT NOT NULL,
  "ownerId"   TEXT NOT NULL,
  -- Sniffed from the bytes AFTER re-encoding, never the client's claim.
  "mime"      VARCHAR(64) NOT NULL,
  "width"     INTEGER NOT NULL,
  "height"    INTEGER NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "sha256"    CHAR(64) NOT NULL,
  "altText"   VARCHAR(300),
  "bytes"     BYTEA NOT NULL,
  -- NULL until the asset is attached to a post. A row still NULL after the
  -- sweep window is an abandoned upload: someone picked an image and closed
  -- the tab, and it must not become a permanent orphan blob.
  "attachedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "media_assets_ownerId_createdAt_idx"
  ON "media_assets" ("ownerId", "createdAt");
-- Covers the orphan sweep, which reads only unattached rows.
CREATE INDEX IF NOT EXISTS "media_assets_attachedAt_idx"
  ON "media_assets" ("attachedAt");
CREATE INDEX IF NOT EXISTS "media_assets_sha256_idx"
  ON "media_assets" ("sha256");

DO $$
BEGIN
  ALTER TABLE "media_assets"
    ADD CONSTRAINT "media_assets_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------
-- 2. Dimensions must be sane.
--
-- The width/height are read from the RE-ENCODED image by sharp, so they are
-- measurements rather than client claims. The constraint guards against a
-- future code path that writes them from a request body: a zero or negative
-- dimension breaks every aspect-ratio calculation downstream, and the failure
-- surfaces as a collapsed layout rather than as an error.
-- ---------------------------------------------------------------
DO $$
BEGIN
  ALTER TABLE "media_assets"
    ADD CONSTRAINT "media_assets_dimensions_positive"
    CHECK ("width" > 0 AND "height" > 0 AND "sizeBytes" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
