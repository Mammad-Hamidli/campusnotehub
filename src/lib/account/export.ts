import { adminDb } from '@/lib/firebase/admin.core';
import { COLLECTIONS, SUBCOLLECTIONS } from '@/lib/firebase/collections';
import { docsToObjects, sortBy } from '@/lib/firebase/convert';
import { findUserById, findUsersByIds } from '@/lib/firebase/repositories/users';
import { findFacultyById, findUniversitiesByIds } from '@/lib/firebase/repositories/reference';
import { getMfa, isEnrolled } from '@/lib/firebase/repositories/mfa';
import { listIdentities } from '@/lib/firebase/repositories/identities';
import type { DeviceRecord, SessionRecord } from '@/lib/firebase/repositories/sessions';
import type { CommentRecord, PostRecord } from '@/lib/firebase/repositories/posts';
import { findNotesByIds, noteUniversityIds, type NoteRecord } from '@/lib/firebase/repositories/notes';
import type { FollowRequestRecord } from '@/lib/firebase/repositories/followRequests';
import type { NotificationRecord } from '@/lib/firebase/repositories/notifications';
import { notificationPreferences } from '@/lib/firebase/repositories/notifications';
import {
  findMentorByUserId,
  type BookingRecord,
  type MentorProfileRecord,
  type MentorReviewRecord,
} from '@/lib/firebase/repositories/mentors';
import { findMentorApplication } from '@/lib/firebase/repositories/mentorApplications';
import { findDeletionRequest } from '@/lib/firebase/repositories/deletionRequests';
import type { VerificationCaseRecord } from '@/lib/firebase/repositories/verification';
import { DICTIONARIES, DEFAULT_LOCALE, isLocale, translate } from '@/lib/i18n/dictionaries';
import { mediaUrlFromKey } from '@/lib/media/constants';
import { appUrl } from '@/lib/email/urls';

/**
 * "Download my data": everything the platform holds about one account, as one
 * JSON document the owner can read.
 *
 * ---------------------------------------------------------------------------
 * ALLOW-LISTED, FIELD BY FIELD
 * ---------------------------------------------------------------------------
 * Every section below names the fields it copies. Nothing is spread from a
 * document, because several documents that belong to this account also hold
 * things that must never leave the server even to their owner: credential and
 * PII hashes, the sealed TOTP secret and recovery-code hashes, refresh-token
 * hashes, device fingerprints, encrypted meeting links, and the fraud scores
 * and moderator notes on a verification case. A spread would ship whatever a
 * future migration adds to those documents; a list ships only what someone
 * decided to ship.
 *
 * Other people appear by public handle only - the same thing the app itself
 * shows - never by id, email or name.
 *
 * ---------------------------------------------------------------------------
 * BOUNDED READS
 * ---------------------------------------------------------------------------
 * Each list is one equality query (single-field index, no composite needed)
 * capped at MAX_ROWS. A section that reached the cap is named in `truncated`
 * rather than silently cut, so the file never claims to be complete when it
 * is not. Likes GIVEN are the one gap: they live in per-post subcollections
 * keyed by liker, reachable only through a collection-group index this
 * project does not deploy.
 */

export const EXPORT_FORMAT = 'campusnotehub-account-export';
export const EXPORT_VERSION = 1;

const MAX_ROWS = 5000;

type Bounded<T> = { rows: T[]; truncated: boolean };

async function rowsWhere<T>(collection: string, field: string, value: string): Promise<Bounded<T>> {
  const snap = await adminDb().collection(collection).where(field, '==', value).limit(MAX_ROWS + 1).get();
  const rows = docsToObjects<T>(snap.docs) as T[];
  return { rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
}

async function rowsIn<T>(path: string): Promise<Bounded<T>> {
  const snap = await adminDb().collection(path).limit(MAX_ROWS + 1).get();
  const rows = docsToObjects<T>(snap.docs) as T[];
  return { rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
}

type Edge = { id: string; createdAt: Date | null };
type NoteReviewRow = { id: string; noteId: string; rating: number; body: string | null; createdAt: Date; updatedAt?: Date };

/** Null when the account does not exist (deleted between the session check and now). */
export async function buildAccountExport(userId: string) {
  const user = await findUserById(userId);
  if (!user) return null;

  const locale = isLocale(user.locale) ? user.locale : DEFAULT_LOCALE;
  const dict = DICTIONARIES[locale];
  const text = (key: string | null, params?: Record<string, string | number> | null) =>
    key ? translate(dict, key, params ?? undefined) : null;

  const mentorProfile = await findMentorByUserId(userId);

  const [
    faculty,
    mfa,
    identities,
    sessions,
    devices,
    posts,
    comments,
    following,
    followers,
    requestsSent,
    requestsReceived,
    notes,
    noteReviews,
    saved,
    application,
    bookingsAsMentee,
    bookingsAsMentor,
    mentorReviews,
    notifications,
    preferences,
    verificationCases,
    deletionRequest,
  ] = await Promise.all([
    user.facultyId ? findFacultyById(user.facultyId) : Promise.resolve(null),
    getMfa(userId),
    listIdentities(userId),
    rowsWhere<SessionRecord>(COLLECTIONS.sessions, 'userId', userId),
    rowsWhere<DeviceRecord>(COLLECTIONS.userDevices, 'userId', userId),
    rowsWhere<PostRecord>(COLLECTIONS.posts, 'authorId', userId),
    rowsWhere<CommentRecord>(COLLECTIONS.comments, 'authorId', userId),
    rowsIn<Edge>(SUBCOLLECTIONS.userFollowing(userId)),
    rowsIn<Edge>(SUBCOLLECTIONS.userFollowers(userId)),
    rowsWhere<FollowRequestRecord>(COLLECTIONS.followRequests, 'requesterId', userId),
    rowsWhere<FollowRequestRecord>(COLLECTIONS.followRequests, 'targetId', userId),
    rowsWhere<NoteRecord>(COLLECTIONS.notes, 'sellerId', userId),
    rowsWhere<NoteReviewRow>(COLLECTIONS.noteReviews, 'userId', userId),
    rowsIn<Edge>(SUBCOLLECTIONS.savedNotes(userId)),
    findMentorApplication(userId),
    rowsWhere<BookingRecord>(COLLECTIONS.bookings, 'menteeId', userId),
    mentorProfile
      ? rowsWhere<BookingRecord>(COLLECTIONS.bookings, 'mentorId', mentorProfile.id)
      : Promise.resolve<Bounded<BookingRecord>>({ rows: [], truncated: false }),
    rowsWhere<MentorReviewRecord>(COLLECTIONS.mentorReviews, 'menteeId', userId),
    rowsWhere<NotificationRecord>(COLLECTIONS.notifications, 'userId', userId),
    notificationPreferences(userId),
    rowsWhere<VerificationCaseRecord>(COLLECTIONS.verificationCases, 'userId', userId),
    findDeletionRequest(userId),
  ]);

  /**
   * Second round: names for the ids the first round returned. Mentor
   * bookings point at a mentor PROFILE, so its owner is one more hop.
   */
  const mentorIds = [
    ...new Set([...bookingsAsMentee.rows.map((b) => b.mentorId), ...mentorReviews.rows.map((r) => r.mentorId)]),
  ];
  const mentorProfiles = await mentorProfilesByIds(mentorIds);

  const [people, universities, relatedNotes] = await Promise.all([
    findUsersByIds([
      ...following.rows.map((edge) => edge.id),
      ...followers.rows.map((edge) => edge.id),
      ...requestsSent.rows.map((r) => r.targetId),
      ...requestsReceived.rows.map((r) => r.requesterId),
      ...bookingsAsMentor.rows.map((b) => b.menteeId),
      ...[...mentorProfiles.values()].map((m) => m.userId),
    ]),
    findUniversitiesByIds([
      ...(user.universityId ? [user.universityId] : []),
      ...notes.rows.flatMap((note) => noteUniversityIds(note)),
    ]),
    findNotesByIds([...new Set([...noteReviews.rows.map((r) => r.noteId), ...saved.rows.map((s) => s.id)])]),
  ]);

  const handle = (id: string | null | undefined) => (id ? people.get(id)?.nickname ?? null : null);
  const mentorHandle = (mentorId: string) => handle(mentorProfiles.get(mentorId)?.userId);
  const universityCode = (id: string | null) => (id ? universities.get(id)?.code ?? null : null);
  const noteTitles = new Map(relatedNotes.map((note) => [note.id, note.title]));
  const newestFirst = <T>(rows: T[], field: keyof T) => sortBy(rows, field, 'desc');

  const truncated = Object.entries({
    sessions,
    devices,
    posts,
    comments,
    following,
    followers,
    followRequestsSent: requestsSent,
    followRequestsReceived: requestsReceived,
    notes,
    noteRatings: noteReviews,
    savedNotes: saved,
    bookingsAsMentee,
    bookingsAsMentor,
    mentorReviews,
    notifications,
    verification: verificationCases,
  })
    .filter(([, list]) => list.truncated)
    .map(([name]) => name);

  const university = user.universityId ? universities.get(user.universityId) ?? null : null;

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    generatedAt: new Date(),
    truncated,

    account: {
      id: user.id,
      nickname: user.nickname,
      email: user.email,
      emailVerifiedAt: user.emailVerifiedAt,
      phone: user.phone,
      fullName: user.fullName,
      firstName: user.firstName,
      lastName: user.lastName,
      dateOfBirth: user.dateOfBirth,
      avatarUrl: user.avatarUrl,
      headline: user.headline,
      bio: user.bio,
      role: user.role,
      accountStatus: user.accountStatus,
      restrictedUntil: user.frozenUntil,
      restrictionReason: user.frozenReason,
      university: university
        ? { code: university.code, nameAz: university.nameAz, nameEn: university.nameEn, nameRu: university.nameRu }
        : null,
      faculty: faculty
        ? { nameAz: faculty.nameAz, nameEn: faculty.nameEn, nameRu: faculty.nameRu }
        : user.facultyOther
          ? { other: user.facultyOther }
          : null,
      department: user.department,
      academicTitle: user.academicTitle,
      graduationYear: user.graduationYear,
      graduationMonth: user.graduationMonth,
      alumniSince: user.alumniTransitionedAt,
      verificationStatus: user.verificationStatus,
      verifiedAt: user.verifiedAt,
      locale: user.locale,
      timezone: user.timezone,
      hashtagTemplates: user.hashtagTemplates ?? [],
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
    },

    privacy: {
      showRealName: user.showRealName,
      showEmail: user.showEmail,
      showPhone: user.showPhone,
      showUniversity: user.showUniversity,
      showFaculty: user.showFaculty,
      showGraduationYear: user.showGraduationYear,
      showAvatar: user.showAvatar ?? 'PUBLIC',
    },

    security: {
      twoFactor: { enabled: isEnrolled(mfa), enrolledAt: isEnrolled(mfa) ? mfa.enrolledAt : null },
      linkedAccounts: identities.map((identity) => ({
        provider: identity.provider,
        email: identity.emailHint,
        linkedAt: identity.linkedAt,
        lastUsedAt: identity.lastUsedAt,
      })),
      sessions: newestFirst(sessions.rows, 'lastSeenAt').map((session) => ({
        device: session.userAgent,
        signedInAt: session.authAt ?? session.createdAt,
        lastActiveAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        signedOutAt: session.revokedAt,
        methods: session.amr ?? [],
      })),
      devices: newestFirst(devices.rows, 'lastSeenAt').map((device) => ({
        label: device.label,
        trusted: device.trusted,
        firstSeenAt: device.firstSeenAt,
        lastSeenAt: device.lastSeenAt,
      })),
    },

    posts: newestFirst(posts.rows, 'createdAt').map((post) => ({
      id: post.id,
      body: post.body,
      visibility: post.visibility,
      tags: (post.tags ?? []).map((tag) => tag.label || tag.slug),
      // A deleted post's images were removed for real; there is nothing to link.
      images: post.isDeleted ? [] : (post.media ?? []).map((m) => appUrl(mediaUrlFromKey(m.storageKey))),
      likeCount: post.likeCount ?? 0,
      commentCount: post.commentCount ?? 0,
      deleted: Boolean(post.isDeleted),
      createdAt: post.createdAt,
      editedAt: post.editedAt ?? null,
    })),

    comments: newestFirst(comments.rows, 'createdAt').map((comment) => ({
      id: comment.id,
      postId: comment.postId,
      replyTo: comment.parentId,
      body: comment.body,
      deleted: Boolean(comment.isDeleted),
      createdAt: comment.createdAt,
    })),

    social: {
      following: newestFirst(following.rows, 'createdAt').map((edge) => ({ nickname: handle(edge.id), since: edge.createdAt })),
      followers: newestFirst(followers.rows, 'createdAt').map((edge) => ({ nickname: handle(edge.id), since: edge.createdAt })),
      followRequestsSent: newestFirst(requestsSent.rows, 'createdAt').map((r) => ({
        to: handle(r.targetId),
        sentAt: r.createdAt,
      })),
      followRequestsReceived: newestFirst(requestsReceived.rows, 'createdAt').map((r) => ({
        from: handle(r.requesterId),
        receivedAt: r.createdAt,
      })),
    },

    notes: {
      uploaded: newestFirst(notes.rows, 'createdAt').map((note) => ({
        id: note.id,
        title: note.title,
        description: note.description,
        subject: note.subject,
        courseCode: note.courseCode,
        language: note.language,
        academicYear: note.academicYear,
        universities: noteUniversityIds(note).map(universityCode).filter(Boolean),
        status: note.status,
        rejectionReason: note.rejectionReason,
        sizeBytes: note.sizeBytes,
        pageCount: note.pageCount,
        downloadCount: note.downloadCount ?? 0,
        ratingAvg: note.ratingAvg,
        ratingCount: note.ratingCount,
        publishedAt: note.publishedAt,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      })),
      ratingsGiven: newestFirst(noteReviews.rows, 'createdAt').map((review) => ({
        noteId: review.noteId,
        noteTitle: noteTitles.get(review.noteId) ?? null,
        rating: review.rating,
        body: review.body,
        createdAt: review.createdAt,
        updatedAt: review.updatedAt ?? null,
      })),
      saved: newestFirst(saved.rows, 'createdAt').map((edge) => ({
        noteId: edge.id,
        noteTitle: noteTitles.get(edge.id) ?? null,
        savedAt: edge.createdAt,
      })),
    },

    mentoring: {
      profile: mentorProfile ? presentMentorProfile(mentorProfile) : null,
      application: application
        ? {
            status: application.status,
            headline: application.headline,
            bio: application.bio,
            industry: application.industry,
            expertise: application.expertise,
            experiences: application.experiences,
            education: application.education,
            languages: application.languages,
            hourlyRateMinor: application.hourlyRateMinor,
            sessionMinutes: application.sessionMinutes,
            linkedinUrl: application.linkedinUrl,
            availability: application.availability ?? [],
            timezone: application.timezone ?? null,
            submittedAt: application.submittedAt,
            decidedAt: application.decidedAt,
            rejectionReason: application.rejectionReason,
          }
        : null,
      bookings: [
        ...bookingsAsMentee.rows.map((b) => presentBooking(b, 'mentee', mentorHandle(b.mentorId))),
        ...bookingsAsMentor.rows.map((b) => presentBooking(b, 'mentor', handle(b.menteeId))),
      ].sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime()),
      reviewsGiven: newestFirst(mentorReviews.rows, 'createdAt').map((review) => ({
        mentor: mentorHandle(review.mentorId),
        rating: review.rating,
        body: review.body,
        createdAt: review.createdAt,
        updatedAt: review.updatedAt ?? null,
      })),
    },

    notifications: {
      preferences: preferences.map((p) => ({ type: p.type, channel: p.channel, enabled: p.enabled })),
      // Rendered in the account's language: the stored row is a message KEY.
      items: newestFirst(notifications.rows, 'createdAt').map((n) => ({
        type: n.type,
        title: text(n.titleKey, n.params),
        body: text(n.bodyKey, n.params),
        link: n.linkUrl ? appUrl(n.linkUrl) : null,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
    },

    /**
     * Outcomes only. The documents themselves are deleted after review (see
     * src/lib/verification/reviewBuffer.ts), and the scores and moderator
     * notes are anti-fraud internals, not data the account provided.
     */
    verification: newestFirst(verificationCases.rows, 'submittedAt').map((c) => ({
      attempt: c.attempt,
      status: c.status,
      message: text(c.publicMessageKey),
      submittedAt: c.submittedAt,
      decidedAt: c.decidedAt,
    })),

    deletionRequest: deletionRequest
      ? {
          status: deletionRequest.status,
          reason: deletionRequest.reason,
          requestedAt: deletionRequest.requestedAt,
          decidedAt: deletionRequest.decidedAt,
          decisionNote: deletionRequest.decisionNote,
        }
      : null,
  };
}

export type AccountExport = NonNullable<Awaited<ReturnType<typeof buildAccountExport>>>;

async function mentorProfilesByIds(ids: string[]): Promise<Map<string, MentorProfileRecord>> {
  if (ids.length === 0) return new Map();
  const db = adminDb();
  const snaps = await db.getAll(...ids.map((id) => db.collection(COLLECTIONS.mentorProfiles).doc(id)));
  const rows = docsToObjects<MentorProfileRecord>(snaps.filter((snap) => snap.exists)) as MentorProfileRecord[];
  return new Map(rows.map((row) => [row.id, row]));
}

function presentMentorProfile(profile: MentorProfileRecord) {
  return {
    headline: profile.headline,
    about: profile.about,
    industry: profile.industry,
    specialties: profile.specialties,
    company: profile.company,
    jobTitle: profile.jobTitle,
    yearsExperience: profile.yearsExperience,
    linkedinUrl: profile.linkedinUrl,
    languages: profile.languages,
    hourlyRateMinor: profile.hourlyRateMinor,
    sessionMinutes: profile.sessionMinutes,
    timezone: profile.timezone,
    approved: profile.isApproved,
    approvedAt: profile.approvedAt,
    acceptingBookings: profile.isAcceptingBookings,
    ratingAvg: profile.ratingAvg,
    ratingCount: profile.ratingCount,
    sessionsCompleted: profile.sessionsCompleted,
    createdAt: profile.createdAt,
  };
}

/** The meeting link is stored encrypted and is left out; the app shows it. */
function presentBooking(booking: BookingRecord, as: 'mentee' | 'mentor', counterpart: string | null) {
  return {
    id: booking.id,
    as,
    with: counterpart,
    topic: booking.topic,
    menteeNote: booking.menteeNote,
    status: booking.status,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    timezone: booking.timezone,
    confirmedAt: booking.confirmedAt,
    completedAt: booking.completedAt,
    cancelledAt: booking.cancelledAt,
    cancelReason: booking.cancelReason,
    createdAt: booking.createdAt,
  };
}
