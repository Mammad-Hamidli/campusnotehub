import { findUserById } from '@/lib/firebase/repositories/users';
import { findFacultyById, findUniversityById } from '@/lib/firebase/repositories/reference';

/**
 * "Download my data": the account's profile details as one JSON document the
 * owner can read.
 *
 * Profile only. Posts, comments, follows, notes, bookings, notifications and
 * sign-in history are not part of it - each of those is already visible in
 * the app, and gathering them meant two dozen collection queries per export.
 * This is three document reads: the user, their university and faculty.
 *
 * Every field is named, never spread from the user document, which also holds
 * credential and PII hashes that must not leave the server even to their
 * owner. A spread would ship whatever a future migration adds; a list ships
 * only what someone decided to ship.
 */

export const EXPORT_FORMAT = 'campusnotehub-account-export';
export const EXPORT_VERSION = 2;

/** Null when the account does not exist (deleted between the session check and now). */
export async function buildAccountExport(userId: string) {
  const user = await findUserById(userId);
  if (!user) return null;

  const [university, faculty] = await Promise.all([
    user.universityId ? findUniversityById(user.universityId) : Promise.resolve(null),
    user.facultyId ? findFacultyById(user.facultyId) : Promise.resolve(null),
  ]);

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    generatedAt: new Date(),

    profile: {
      nickname: user.nickname,
      fullName: user.fullName,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      dateOfBirth: user.dateOfBirth,
      avatarUrl: user.avatarUrl,
      headline: user.headline,
      bio: user.bio,
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
      verificationStatus: user.verificationStatus,
      locale: user.locale,
      timezone: user.timezone,
      createdAt: user.createdAt,
    },
  };
}
