/**
 * The faculty / field-of-study catalogue.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A CODE CONSTANT AND NOT THE `faculties` TABLE
 * ---------------------------------------------------------------------------
 * The schema already has a Faculty model, and it is deliberately NOT used
 * here. That model is scoped to one university (`@@unique([universityId,
 * nameEn])`), has never been seeded, and nothing has ever written
 * `User.facultyId`. It is the right shape for a university publishing its own
 * internal faculty structure later.
 *
 * Registration needs the opposite thing: one cross-institution list, because
 * "Computer Science" means the same thing at BDU and at ADA, and a student
 * picking their field should not first have to discover which of 18
 * universities happens to have seeded a row with that name. A per-university
 * table would also make the dropdown empty for every university nobody had got
 * round to populating - which is precisely the state it is in today.
 *
 * So the choice is stored on `users` as a stable SLUG. Slugs are the contract:
 * they are what lands in the database and what any later migration into a real
 * table would join on, so a slug must never be renamed once shipped. Labels
 * are display text and may be corrected freely.
 *
 * Translations are intentionally absent. The rest of the product translates
 * through the message catalogues in messages/*.json, and adding 60 x 3 strings
 * there for a field that is a proper noun in academic use across all three
 * languages would be a lot of surface for very little benefit. If that changes,
 * the slug is the key to translate against.
 */

export type FacultyOption = {
  /** Stable identifier persisted to `users.facultySlug`. Never rename. */
  slug: string;
  label: string;
  /** Groups the picker. Purely presentational. */
  group: FacultyGroup;
};

export type FacultyGroup =
  | 'Computing & IT'
  | 'Engineering'
  | 'Natural Sciences'
  | 'Health & Medicine'
  | 'Business & Economics'
  | 'Social Sciences & Law'
  | 'Arts & Humanities'
  | 'Education & Other';

/**
 * The sentinel for a field not on the list.
 *
 * Exported rather than written as a bare 'other' at each call site: the
 * registration form, the zod schema, the API route and the CHECK constraint in
 * the migration all have to agree on this exact string, and a typo in any one
 * of them silently drops the user's typed faculty.
 */
export const FACULTY_OTHER = 'other';

export const FACULTIES: readonly FacultyOption[] = [
  // --- Computing & IT -------------------------------------------------------
  { slug: 'computer-science', label: 'Computer Science', group: 'Computing & IT' },
  { slug: 'software-engineering', label: 'Software Engineering', group: 'Computing & IT' },
  { slug: 'information-technology', label: 'Information Technology', group: 'Computing & IT' },
  { slug: 'cyber-security', label: 'Cyber Security', group: 'Computing & IT' },
  { slug: 'information-systems', label: 'Information Systems', group: 'Computing & IT' },
  { slug: 'computer-engineering', label: 'Computer Engineering', group: 'Computing & IT' },
  { slug: 'data-science', label: 'Data Science', group: 'Computing & IT' },
  { slug: 'artificial-intelligence', label: 'Artificial Intelligence', group: 'Computing & IT' },
  { slug: 'robotics', label: 'Robotics', group: 'Computing & IT' },

  // --- Engineering ----------------------------------------------------------
  { slug: 'electrical-engineering', label: 'Electrical Engineering', group: 'Engineering' },
  { slug: 'mechanical-engineering', label: 'Mechanical Engineering', group: 'Engineering' },
  { slug: 'civil-engineering', label: 'Civil Engineering', group: 'Engineering' },
  { slug: 'chemical-engineering', label: 'Chemical Engineering', group: 'Engineering' },
  { slug: 'industrial-engineering', label: 'Industrial Engineering', group: 'Engineering' },
  { slug: 'telecommunications-engineering', label: 'Telecommunications Engineering', group: 'Engineering' },
  { slug: 'aerospace-engineering', label: 'Aerospace Engineering', group: 'Engineering' },
  { slug: 'automotive-engineering', label: 'Automotive Engineering', group: 'Engineering' },
  // Azerbaijan's largest single industry, and ADNSU's flagship faculty. Its
  // absence from a list used in Baku would be conspicuous.
  { slug: 'petroleum-engineering', label: 'Petroleum Engineering', group: 'Engineering' },
  { slug: 'agricultural-engineering', label: 'Agricultural Engineering', group: 'Engineering' },
  { slug: 'architecture', label: 'Architecture', group: 'Engineering' },
  { slug: 'architecture-urban-planning', label: 'Architecture & Urban Planning', group: 'Engineering' },

  // --- Natural Sciences -----------------------------------------------------
  { slug: 'biology', label: 'Biology', group: 'Natural Sciences' },
  { slug: 'chemistry', label: 'Chemistry', group: 'Natural Sciences' },
  { slug: 'physics', label: 'Physics', group: 'Natural Sciences' },
  { slug: 'mathematics', label: 'Mathematics', group: 'Natural Sciences' },
  { slug: 'statistics', label: 'Statistics', group: 'Natural Sciences' },
  { slug: 'environmental-science', label: 'Environmental Science', group: 'Natural Sciences' },
  { slug: 'biotechnology', label: 'Biotechnology', group: 'Natural Sciences' },
  { slug: 'geology', label: 'Geology', group: 'Natural Sciences' },

  // --- Health & Medicine ----------------------------------------------------
  { slug: 'medicine', label: 'Medicine', group: 'Health & Medicine' },
  { slug: 'dentistry', label: 'Dentistry', group: 'Health & Medicine' },
  { slug: 'pharmacy', label: 'Pharmacy', group: 'Health & Medicine' },
  { slug: 'nursing', label: 'Nursing', group: 'Health & Medicine' },
  { slug: 'public-health', label: 'Public Health', group: 'Health & Medicine' },
  { slug: 'veterinary-medicine', label: 'Veterinary Medicine', group: 'Health & Medicine' },

  // --- Business & Economics -------------------------------------------------
  { slug: 'business-administration', label: 'Business Administration', group: 'Business & Economics' },
  { slug: 'economics', label: 'Economics', group: 'Business & Economics' },
  { slug: 'finance', label: 'Finance', group: 'Business & Economics' },
  { slug: 'accounting', label: 'Accounting', group: 'Business & Economics' },
  { slug: 'marketing', label: 'Marketing', group: 'Business & Economics' },
  { slug: 'management', label: 'Management', group: 'Business & Economics' },
  { slug: 'international-business', label: 'International Business', group: 'Business & Economics' },
  { slug: 'supply-chain-management', label: 'Supply Chain Management', group: 'Business & Economics' },
  { slug: 'logistics', label: 'Logistics', group: 'Business & Economics' },
  { slug: 'tourism-hospitality', label: 'Tourism & Hospitality', group: 'Business & Economics' },

  // --- Social Sciences & Law ------------------------------------------------
  { slug: 'international-relations', label: 'International Relations', group: 'Social Sciences & Law' },
  { slug: 'political-science', label: 'Political Science', group: 'Social Sciences & Law' },
  { slug: 'law', label: 'Law', group: 'Social Sciences & Law' },
  { slug: 'psychology', label: 'Psychology', group: 'Social Sciences & Law' },
  { slug: 'sociology', label: 'Sociology', group: 'Social Sciences & Law' },
  { slug: 'public-administration', label: 'Public Administration', group: 'Social Sciences & Law' },
  { slug: 'social-work', label: 'Social Work', group: 'Social Sciences & Law' },
  { slug: 'international-development', label: 'International Development', group: 'Social Sciences & Law' },

  // --- Arts & Humanities ----------------------------------------------------
  { slug: 'english', label: 'English', group: 'Arts & Humanities' },
  { slug: 'linguistics', label: 'Linguistics', group: 'Arts & Humanities' },
  { slug: 'literature', label: 'Literature', group: 'Arts & Humanities' },
  { slug: 'history', label: 'History', group: 'Arts & Humanities' },
  { slug: 'philosophy', label: 'Philosophy', group: 'Arts & Humanities' },
  { slug: 'journalism', label: 'Journalism', group: 'Arts & Humanities' },
  { slug: 'media-communications', label: 'Media & Communications', group: 'Arts & Humanities' },
  { slug: 'graphic-design', label: 'Graphic Design', group: 'Arts & Humanities' },
  { slug: 'fine-arts', label: 'Fine Arts', group: 'Arts & Humanities' },
  { slug: 'music', label: 'Music', group: 'Arts & Humanities' },

  // --- Education & Other ----------------------------------------------------
  { slug: 'education', label: 'Education', group: 'Education & Other' },
  { slug: 'sports-science', label: 'Sports Science', group: 'Education & Other' },
  { slug: FACULTY_OTHER, label: 'Other', group: 'Education & Other' },
] as const;

/**
 * Display order for the grouped picker.
 *
 * Declared explicitly rather than derived from first-appearance in FACULTIES,
 * so reordering the array above (or inserting a faculty into the middle of a
 * group) cannot silently reshuffle the dropdown.
 */
export const FACULTY_GROUPS: readonly FacultyGroup[] = [
  'Computing & IT',
  'Engineering',
  'Natural Sciences',
  'Health & Medicine',
  'Business & Economics',
  'Social Sciences & Law',
  'Arts & Humanities',
  'Education & Other',
];

const BY_SLUG = new Map(FACULTIES.map((f) => [f.slug, f]));

/** The set the zod schema validates against. Unknown slugs are refused. */
export const FACULTY_SLUGS: ReadonlySet<string> = new Set(BY_SLUG.keys());

export function isFacultySlug(value: string): boolean {
  return BY_SLUG.has(value);
}

/**
 * What to show for a stored (slug, other) pair.
 *
 * Centralised because the pair has three readings - catalogue value, custom
 * value, nothing set - and every surface that renders a faculty (profile,
 * settings, admin user detail, the Excel export) has to agree on all three.
 * Returns null rather than a placeholder string so the caller decides how
 * "not set" looks in its own context.
 */
export function facultyLabel(
  slug: string | null | undefined,
  other: string | null | undefined,
): string | null {
  if (!slug) return null;
  if (slug === FACULTY_OTHER) return other?.trim() || null;
  return BY_SLUG.get(slug)?.label ?? null;
}

/** Groups for rendering, preserving FACULTY_GROUPS order. */
export function groupedFaculties(): { group: FacultyGroup; options: FacultyOption[] }[] {
  return FACULTY_GROUPS.map((group) => ({
    group,
    options: FACULTIES.filter((f) => f.group === group),
  })).filter((section) => section.options.length > 0);
}
