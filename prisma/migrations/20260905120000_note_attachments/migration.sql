-- Study-note file attachments.
--
-- Hand-written rather than generated. `prisma migrate diff` also wanted to drop
-- notes.search_tsv and its two GIN indexes, because those are created by
-- prisma/manual/0001_invariants.sql and are invisible to the Prisma schema.
-- Applying that diff would have silently destroyed full-text search on notes,
-- so this migration contains only the additive change.

CREATE TABLE "note_attachments" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "fileName" VARCHAR(255) NOT NULL,
    "mime" VARCHAR(120) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_attachments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "note_attachments_noteId_key" ON "note_attachments"("noteId");
CREATE INDEX "note_attachments_sha256_idx" ON "note_attachments"("sha256");

ALTER TABLE "note_attachments"
  ADD CONSTRAINT "note_attachments_noteId_fkey"
  FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
