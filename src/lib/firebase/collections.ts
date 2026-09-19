/**
 * The Firestore data model.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A TABLE-PER-COLLECTION COPY OF THE SQL SCHEMA
 * ---------------------------------------------------------------------------
 * A direct translation would produce 35 top-level collections and require a
 * join for every screen, which Firestore cannot do. The shape below is chosen
 * from how the application actually QUERIES, and the four decisions worth
 * defending are:
 *
 * 1. JOIN TABLES BECOME SUBCOLLECTIONS OR ARRAYS.
 *    `post_tags` was a join table because SQL needs one. Firestore does not:
 *    a post carries `tagSlugs: string[]`, and `array-contains` serves the
 *    "posts with tag X" query that the join table existed for. Same for
 *    `post_media`, which becomes an ordered array on the post - it is always
 *    read with the post and never on its own.
 *
 * 2. LIKES AND FOLLOWS BECOME SUBCOLLECTIONS, NOT ARRAYS.
 *    The opposite call, for a concrete reason: a document is capped at 1 MiB
 *    and a popular post can exceed any array of liker ids, while a
 *    subcollection is unbounded. `posts/{id}/likes/{userId}` also gives the
 *    composite-key idempotency the SQL primary key gave - liking twice writes
 *    the same document id.
 *
 * 3. THE LEDGER STAYS FLAT AND APPEND-ONLY.
 *    `ledger_transactions` and `ledger_entries` are separate top-level
 *    collections because they are audited as a unit and must never be nested
 *    under something deletable. Deleting a wallet must not cascade away the
 *    money record.
 *
 * 4. FILE BYTES LEAVE THE DATABASE.
 *    note_attachments.bytes and media_assets.bytes are BYTEA columns today.
 *    Firestore's 1 MiB document limit makes that impossible and it would be
 *    wrong anyway - they go to Cloud Storage, and the document keeps only the
 *    path plus metadata.
 *
 * ---------------------------------------------------------------------------
 * IDS ARE PRESERVED
 * ---------------------------------------------------------------------------
 * Every migrated document keeps its Postgres cuid as its Firestore document
 * id. That is what makes the migration idempotent (a re-run overwrites rather
 * than duplicating) and what lets every foreign key keep pointing at the right
 * record without a translation table.
 */

/** Top-level collections. */
export const COLLECTIONS = {
  users: 'users',
  universities: 'universities',
  faculties: 'faculties',

  posts: 'posts',
  comments: 'comments',
  tags: 'tags',

  notes: 'notes',
  orders: 'orders',
  noteReviews: 'noteReviews',

  wallets: 'wallets',
  ledgerAccounts: 'ledgerAccounts',
  ledgerTransactions: 'ledgerTransactions',
  ledgerEntries: 'ledgerEntries',

  mentorProfiles: 'mentorProfiles',
  bookings: 'bookings',
  mentorReviews: 'mentorReviews',

  verificationCases: 'verificationCases',
  moderationActions: 'moderationActions',
  auditLogs: 'auditLogs',
  blocklist: 'blocklist',
  contentReports: 'contentReports',

  notifications: 'notifications',
  pushSubscriptions: 'pushSubscriptions',

  sessions: 'sessions',
  userDevices: 'userDevices',
  scheduledTasks: 'scheduledTasks',
  mediaAssets: 'mediaAssets',
  /** SHA-256 dedupe keys for transactional email - see src/lib/email/send.ts. */
  emailDispatches: 'emailDispatches',
  /** Emails whose delivery failed, waiting for a retry. */
  emailOutbox: 'emailOutbox',
  /** PocketMentor applications, keyed by applicant user id. */
  mentorApplications: 'mentorApplications',
  /** User-filed account deletion requests, keyed by user id; reviewed by an admin. */
  accountDeletionRequests: 'accountDeletionRequests',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/**
 * Subcollections, keyed by their parent.
 *
 * `posts/{postId}/likes/{userId}` - the document id IS the liker, which
 * reproduces the (postId, userId) primary key and makes a double-tap a
 * no-op write rather than a duplicate row.
 */
export const SUBCOLLECTIONS = {
  postLikes: (postId: string) => `${COLLECTIONS.posts}/${postId}/likes`,
  userFollowers: (userId: string) => `${COLLECTIONS.users}/${userId}/followers`,
  userFollowing: (userId: string) => `${COLLECTIONS.users}/${userId}/following`,
  /** Per-user notification preferences, one document per type+channel. */
  notifPrefs: (userId: string) => `${COLLECTIONS.users}/${userId}/notificationPreferences`,
  /** "Save for later" bookmarks; doc id = noteId, so saving twice is a no-op. */
  savedNotes: (userId: string) => `${COLLECTIONS.users}/${userId}/savedNotes`,
  /** Availability rules belong to exactly one mentor and are read with them. */
  availability: (mentorId: string) => `${COLLECTIONS.mentorProfiles}/${mentorId}/availability`,
  /**
   * One-off calendar overrides - a blocked day, or extra hours on a Saturday.
   * A subcollection rather than an array on the profile: a mentor with a dense
   * calendar accumulates these indefinitely, and an unbounded array is how a
   * document walks into the 1 MiB limit.
   */
  availabilityExceptions: (mentorId: string) =>
    `${COLLECTIONS.mentorProfiles}/${mentorId}/availabilityExceptions`,
} as const;

/**
 * Storage paths.
 *
 * Identity documents are deliberately ABSENT. Under the zero-retention policy
 * they never reach durable storage at all - they live in an encrypted Redis
 * buffer for the review window and are wiped. Adding a bucket path for them
 * here would be the first step toward breaking that promise, which is why
 * src/lib/storage/s3.ts carries the same warning about a KYC bucket.
 */
export const STORAGE_PATHS = {
  /** Study-note files. Private; served through an authorization check. */
  noteFile: (noteId: string, fileName: string) => `notes/${noteId}/${fileName}`,
  /** Post images. Re-encoded WebP, readable by anyone who can see the post. */
  postMedia: (assetId: string) => `media/${assetId}.webp`,
  /** Avatars. Public by nature. */
  avatar: (userId: string) => `avatars/${userId}`,
} as const;

/**
 * Fields that must NEVER reach a client document.
 *
 * Firestore has no column-level grants, so "the client may read this document"
 * means "the client may read every field in it". Anything on this list is
 * therefore stripped before write, and the security rules deny direct reads of
 * the collections that would otherwise expose it.
 *
 * This is the single most important constant in the migration: in Postgres
 * these were protected by never appearing in a SELECT, and that protection
 * does not survive the move on its own.
 */
export const NEVER_IN_FIRESTORE = [
  'passwordHash',
  'emailHash',
  'phoneHash',
  'refreshTokenHash',
  'reviewBufferKey',
  // The raw bytes columns; these become Storage objects instead.
  'bytes',
] as const;
