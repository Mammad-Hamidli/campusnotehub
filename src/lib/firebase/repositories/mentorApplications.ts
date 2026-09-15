import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';
import { docToObject, docsToObjects, forFirestore } from '../convert';
import { findMentorByUserId, mentorCollections, replaceRulesInBatch } from './mentors';
import type { WeeklyRule } from '@/lib/mentors/schedule';

/**
 * PocketMentor applications.
 *
 * One document per applicant, keyed by user id, so "does this user already
 * have an application" is a keyed read and a resubmission after a rejection
 * replaces the old one rather than piling up duplicates.
 *
 * An application is NOT a mentor profile. Nothing here is listed in the
 * directory until a moderator approves it, at which point
 * approveMentorApplication() writes the public mentorProfiles document in the
 * same batch that marks the application approved.
 */

export type MentorExperience = { company: string; role: string; years: number };

export type MentorEducation = {
  institution: string;
  degree: string;
  field: string | null;
  graduationYear: number | null;
};

export type MentorApplicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export type MentorApplicationInput = {
  headline: string;
  bio: string;
  industry: string;
  expertise: string[];
  experiences: MentorExperience[];
  education: MentorEducation[];
  languages: string[];
  hourlyRateMinor: number;
  sessionMinutes: number;
  linkedinUrl: string | null;
  /** Weekly grid from the application. Optional: older applications lack it. */
  availability?: WeeklyRule[];
  timezone?: string;
};

export type MentorApplicationRecord = MentorApplicationInput & {
  id: string;
  userId: string;
  status: MentorApplicationStatus;
  submittedAt: Date;
  decidedAt: Date | null;
  decidedById: string | null;
  rejectionReason: string | null;
};

const applications = () => adminDb().collection(COLLECTIONS.mentorApplications);

/** Total years across every listed role - what the directory filters on. */
export function totalYears(experiences: MentorExperience[]): number {
  return Math.round(experiences.reduce((sum, e) => sum + (Number(e.years) || 0), 0) * 10) / 10;
}

export async function findMentorApplication(userId: string): Promise<MentorApplicationRecord | null> {
  return docToObject<MentorApplicationRecord>(
    await applications().doc(userId).get(),
  ) as MentorApplicationRecord | null;
}

export async function submitMentorApplication(
  userId: string,
  input: MentorApplicationInput,
): Promise<MentorApplicationRecord> {
  const record = {
    ...input,
    userId,
    status: 'PENDING' as const,
    submittedAt: new Date(),
    decidedAt: null,
    decidedById: null,
    rejectionReason: null,
  };
  await applications().doc(userId).set(forFirestore(record));
  return { id: userId, ...record };
}

export async function listMentorApplications(
  status: MentorApplicationStatus,
  take = 100,
): Promise<MentorApplicationRecord[]> {
  // Equality only: no composite index needed. Ordered in memory, newest first.
  const snap = await applications().where('status', '==', status).limit(take).get();
  return (docsToObjects<MentorApplicationRecord>(snap.docs) as MentorApplicationRecord[]).sort(
    (a, b) => b.submittedAt.getTime() - a.submittedAt.getTime(),
  );
}

export async function rejectMentorApplication(
  userId: string,
  actorId: string,
  reason: string,
): Promise<void> {
  await applications()
    .doc(userId)
    .update(
      forFirestore({
        status: 'REJECTED',
        decidedAt: new Date(),
        decidedById: actorId,
        rejectionReason: reason,
      }),
    );
}

/**
 * Approves an application and publishes the mentor profile, atomically.
 *
 * An existing profile (a previously approved mentor re-applying with updated
 * details) keeps its rating, sessions and booking settings; only the
 * application-sourced fields are refreshed.
 */
export async function approveMentorApplication(
  application: MentorApplicationRecord,
  actorId: string,
): Promise<string> {
  const db = adminDb();
  const existing = await findMentorByUserId(application.userId);
  const profileRef = existing
    ? db.collection(COLLECTIONS.mentorProfiles).doc(existing.id)
    : db.collection(COLLECTIONS.mentorProfiles).doc();

  const now = new Date();
  const [current] = application.experiences;
  // Read before the batch (batches cannot read). Only touched when the
  // application carries a schedule, so legacy approvals keep existing rules.
  const existingRuleIds =
    existing && application.availability
      ? (await mentorCollections.rules(existing.id).get()).docs.map((d) => d.id)
      : [];

  const fromApplication = {
    userId: application.userId,
    industry: application.industry,
    specialties: application.expertise,
    headline: application.headline,
    about: application.bio,
    company: current?.company ?? null,
    jobTitle: current?.role ?? null,
    yearsExperience: totalYears(application.experiences),
    experiences: application.experiences,
    education: application.education,
    linkedinUrl: application.linkedinUrl,
    languages: application.languages,
    hourlyRateMinor: application.hourlyRateMinor,
    sessionMinutes: application.sessionMinutes,
    ...(application.timezone ? { timezone: application.timezone } : {}),
    isApproved: true,
    approvedAt: now,
    updatedAt: now,
  };

  const batch = db.batch();
  if (existing) {
    batch.set(profileRef, forFirestore(fromApplication), { merge: true });
  } else {
    batch.set(
      profileRef,
      forFirestore({
        ...fromApplication,
        bufferMinutes: 15,
        minNoticeHours: 12,
        timezone: application.timezone ?? 'Asia/Baku',
        isAcceptingBookings: true,
        ratingAvg: 0,
        ratingCount: 0,
        sessionsCompleted: 0,
        createdAt: now,
      }),
    );
  }
  if (application.availability) {
    replaceRulesInBatch(batch, profileRef.id, existingRuleIds, application.availability);
  }
  batch.update(
    applications().doc(application.userId),
    forFirestore({ status: 'APPROVED', decidedAt: now, decidedById: actorId, rejectionReason: null }),
  );
  await batch.commit();
  return profileRef.id;
}
