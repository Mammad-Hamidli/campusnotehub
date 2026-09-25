/**
 * Domain enums.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE NOT IMPORTED FROM @prisma/client ANY MORE
 * ---------------------------------------------------------------------------
 * These names are used as VALUES, not just as types: `UserRole.ADMIN`,
 * `VerificationStatus.VERIFIED`, `NotificationType.POST_LIKE`. A value import
 * is a real runtime dependency, so while they came from the generated Prisma
 * client every route in the app loaded the Prisma client just to name a string
 * constant - even routes that never touch Postgres.
 *
 * They are the product's vocabulary, not the database's. Firestore stores them
 * as plain strings, exactly as Postgres stored them as enum labels, so the set
 * of legal values has to live somewhere that outlives the ORM.
 *
 * The shape deliberately mirrors what Prisma generated - a frozen object plus a
 * type of the same name - so `import { UserRole } from '@/lib/enums'` is a
 * drop-in swap at every call site and no comparison changes meaning.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS NOW THE SOURCE OF TRUTH, NOT A GENERATED ARTEFACT
 * ---------------------------------------------------------------------------
 * It used to be generated from prisma/schema.prisma by scripts/gen-enums.mjs,
 * with the schema as the authority. Both are gone: Postgres is no longer a
 * fallback, and Firestore has no schema to generate from - it stores these as
 * plain strings, exactly as Postgres stored them as enum labels.
 *
 * So the set of legal values is maintained here by hand. Nothing validates it
 * against the database any more, because there is no database declaration left
 * to validate against; what enforces these values now is the Zod schemas at
 * the edges and the security rules, both of which name them explicitly.
 */

export const Locale = {
  az: 'az',
  en: 'en',
  ru: 'ru',
} as const;
export type Locale = (typeof Locale)[keyof typeof Locale];
export const LocaleValues = Object.values(Locale) as Locale[];

export const UserRole = {
  STUDENT: 'STUDENT',
  ALUMNI: 'ALUMNI',
  MENTOR: 'MENTOR',
  TEACHER: 'TEACHER',
  MODERATOR: 'MODERATOR',
  ADMIN: 'ADMIN',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];
export const UserRoleValues = Object.values(UserRole) as UserRole[];

export const VerificationStatus = {
  UNVERIFIED: 'UNVERIFIED',
  PROCESSING: 'PROCESSING',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
  BANNED: 'BANNED',
} as const;
export type VerificationStatus = (typeof VerificationStatus)[keyof typeof VerificationStatus];
export const VerificationStatusValues = Object.values(VerificationStatus) as VerificationStatus[];

export const AccountStatus = {
  ACTIVE: 'ACTIVE',
  RESTRICTED: 'RESTRICTED',
  SUSPENDED: 'SUSPENDED',
  BANNED: 'BANNED',
  DELETED: 'DELETED',
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];
export const AccountStatusValues = Object.values(AccountStatus) as AccountStatus[];

export const DocumentKind = {
  ID_FRONT: 'ID_FRONT',
  ID_BACK: 'ID_BACK',
  STUDENT_CARD_FRONT: 'STUDENT_CARD_FRONT',
  STUDENT_CARD_BACK: 'STUDENT_CARD_BACK',
} as const;
export type DocumentKind = (typeof DocumentKind)[keyof typeof DocumentKind];
export const DocumentKindValues = Object.values(DocumentKind) as DocumentKind[];

export const FraudVerdict = {
  CLEAN: 'CLEAN',
  AMBIGUOUS: 'AMBIGUOUS',
  TAMPERED: 'TAMPERED',
} as const;
export type FraudVerdict = (typeof FraudVerdict)[keyof typeof FraudVerdict];
export const FraudVerdictValues = Object.values(FraudVerdict) as FraudVerdict[];

export const BlocklistType = {
  USER_ID: 'USER_ID',
  EMAIL_HASH: 'EMAIL_HASH',
  PHONE_HASH: 'PHONE_HASH',
  DEVICE_FINGERPRINT: 'DEVICE_FINGERPRINT',
} as const;
export type BlocklistType = (typeof BlocklistType)[keyof typeof BlocklistType];
export const BlocklistTypeValues = Object.values(BlocklistType) as BlocklistType[];

export const FieldVisibility = {
  PUBLIC: 'PUBLIC',
  VERIFIED_ONLY: 'VERIFIED_ONLY',
  PRIVATE: 'PRIVATE',
} as const;
export type FieldVisibility = (typeof FieldVisibility)[keyof typeof FieldVisibility];
export const FieldVisibilityValues = Object.values(FieldVisibility) as FieldVisibility[];

export const PostVisibility = {
  PUBLIC: 'PUBLIC',
  UNIVERSITY_ONLY: 'UNIVERSITY_ONLY',
  VERIFIED_ONLY: 'VERIFIED_ONLY',
  FOLLOWERS: 'FOLLOWERS',
} as const;
export type PostVisibility = (typeof PostVisibility)[keyof typeof PostVisibility];
export const PostVisibilityValues = Object.values(PostVisibility) as PostVisibility[];

export const NoteStatus = {
  DRAFT: 'DRAFT',
  PROCESSING: 'PROCESSING',
  PENDING_REVIEW: 'PENDING_REVIEW',
  PUBLISHED: 'PUBLISHED',
  REJECTED: 'REJECTED',
  DELISTED: 'DELISTED',
} as const;
export type NoteStatus = (typeof NoteStatus)[keyof typeof NoteStatus];
export const NoteStatusValues = Object.values(NoteStatus) as NoteStatus[];

export const MentorIndustry = {
  IT: 'IT',
  MARKETING: 'MARKETING',
  LAW: 'LAW',
  ENGINEERING: 'ENGINEERING',
  FINANCE: 'FINANCE',
  MEDICINE: 'MEDICINE',
  EDUCATION: 'EDUCATION',
  DESIGN: 'DESIGN',
  OTHER: 'OTHER',
} as const;
export type MentorIndustry = (typeof MentorIndustry)[keyof typeof MentorIndustry];
export const MentorIndustryValues = Object.values(MentorIndustry) as MentorIndustry[];

export const BookingStatus = {
  REQUESTED: 'REQUESTED',
  CONFIRMED: 'CONFIRMED',
  RESCHEDULED: 'RESCHEDULED',
  COMPLETED: 'COMPLETED',
  CANCELLED_BY_MENTEE: 'CANCELLED_BY_MENTEE',
  CANCELLED_BY_MENTOR: 'CANCELLED_BY_MENTOR',
  NO_SHOW: 'NO_SHOW',
  EXPIRED: 'EXPIRED',
} as const;
export type BookingStatus = (typeof BookingStatus)[keyof typeof BookingStatus];
export const BookingStatusValues = Object.values(BookingStatus) as BookingStatus[];

export const NotificationChannel = {
  IN_APP: 'IN_APP',
  WEB_PUSH: 'WEB_PUSH',
  EMAIL: 'EMAIL',
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];
export const NotificationChannelValues = Object.values(NotificationChannel) as NotificationChannel[];

export const NotificationType = {
  VERIFICATION_APPROVED: 'VERIFICATION_APPROVED',
  VERIFICATION_REJECTED: 'VERIFICATION_REJECTED',
  VERIFICATION_NEEDS_REVIEW: 'VERIFICATION_NEEDS_REVIEW',
  VERIFICATION_RESUBMIT_REQUIRED: 'VERIFICATION_RESUBMIT_REQUIRED',
  GRADUATION_TRANSITION_PROMPT: 'GRADUATION_TRANSITION_PROMPT',
  NOTE_REVIEWED: 'NOTE_REVIEWED',
  NOTE_MODERATION: 'NOTE_MODERATION',
  BOOKING_REQUESTED: 'BOOKING_REQUESTED',
  BOOKING_CONFIRMED: 'BOOKING_CONFIRMED',
  BOOKING_REMINDER_24H: 'BOOKING_REMINDER_24H',
  BOOKING_REMINDER_1H: 'BOOKING_REMINDER_1H',
  BOOKING_CANCELLED: 'BOOKING_CANCELLED',
  POST_REPLY: 'POST_REPLY',
  POST_LIKE: 'POST_LIKE',
  NEW_FOLLOWER: 'NEW_FOLLOWER',
  FOLLOW_REQUEST: 'FOLLOW_REQUEST',
  FOLLOW_ACCEPTED: 'FOLLOW_ACCEPTED',
  SYSTEM: 'SYSTEM',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];
export const NotificationTypeValues = Object.values(NotificationType) as NotificationType[];

export const ReportReason = {
  SPAM: 'SPAM',
  HARASSMENT: 'HARASSMENT',
  COPYRIGHT: 'COPYRIGHT',
  ACADEMIC_DISHONESTY: 'ACADEMIC_DISHONESTY',
  FAKE_PROFILE: 'FAKE_PROFILE',
  SEXUAL_CONTENT: 'SEXUAL_CONTENT',
  OTHER: 'OTHER',
} as const;
export type ReportReason = (typeof ReportReason)[keyof typeof ReportReason];
export const ReportReasonValues = Object.values(ReportReason) as ReportReason[];
