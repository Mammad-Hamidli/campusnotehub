/**
 * Authorised universities and their official email domains.
 *
 * Single source of truth for the registration dropdown, the domain
 * auto-detection, and the seed script. Previously the list was inlined in
 * StepAccount.tsx and duplicated in prisma/seed.ts, which is how a dropdown
 * and a database drift apart.
 *
 * BACKEND INTEGRATION: replace with `GET /api/universities` once the endpoint
 * exists. It returns the same shape from the `universities` table and is
 * cacheable for an hour.
 */
export type University = {
  /** Stable code used as the form value and the DB `code` column. */
  id: string;
  az: string;
  en: string;
  ru: string;
  /**
   * Official email domains. Several institutions have more than one because
   * they rebranded or run a legacy alias, and students hold addresses on both.
   */
  domains: string[];
};

export const UNIVERSITIES: University[] = [
  {
    id: 'BDU',
    az: 'Bakı Dövlət Universiteti',
    en: 'Baku State University',
    ru: 'Бакинский государственный университет',
    // Both spellings are live: `bsu` is the English transliteration used on
    // official mail, `bdu` the Azerbaijani one. Students have either.
    domains: ['bsu.edu.az', 'bdu.edu.az'],
  },
  {
    id: 'ADA',
    az: 'ADA Universiteti',
    en: 'ADA University',
    ru: 'Университет АДА',
    domains: ['ada.edu.az'],
  },
  {
    id: 'UNEC',
    az: 'Azərbaycan Dövlət İqtisad Universiteti',
    en: 'Azerbaijan State University of Economics',
    ru: 'Азербайджанский государственный экономический университет',
    domains: ['unec.edu.az'],
  },
  {
    id: 'ADNSU',
    az: 'Azərbaycan Dövlət Neft və Sənaye Universiteti',
    en: 'Azerbaijan State Oil and Industry University',
    ru: 'Азербайджанский государственный университет нефти и промышленности',
    // Still `asoiu` from the pre-2015 name; the rebrand never reached mail.
    domains: ['asoiu.edu.az', 'adnsu.edu.az'],
  },
  {
    id: 'AzTU',
    az: 'Azərbaycan Texniki Universiteti',
    en: 'Azerbaijan Technical University',
    ru: 'Азербайджанский технический университет',
    domains: ['aztu.edu.az'],
  },
  {
    id: 'BMU',
    az: 'Bakı Mühəndislik Universiteti',
    en: 'Baku Engineering University',
    ru: 'Бакинский инженерный университет',
    domains: ['beu.edu.az'],
  },
  {
    id: 'ATU',
    az: 'Azərbaycan Tibb Universiteti',
    en: 'Azerbaijan Medical University',
    ru: 'Азербайджанский медицинский университет',
    domains: ['amu.edu.az'],
  },
  {
    id: 'ADPU',
    az: 'Azərbaycan Dövlət Pedaqoji Universiteti',
    en: 'Azerbaijan State Pedagogical University',
    ru: 'Азербайджанский государственный педагогический университет',
    domains: ['adpu.edu.az'],
  },
  {
    id: 'ADU',
    az: 'Azərbaycan Dillər Universiteti',
    en: 'Azerbaijan University of Languages',
    ru: 'Азербайджанский университет языков',
    domains: ['adu.edu.az'],
  },
  {
    id: 'KHAZAR',
    az: 'Xəzər Universiteti',
    en: 'Khazar University',
    ru: 'Университет Хазар',
    // Not .edu.az - Khazar is private and uses a .org domain.
    domains: ['khazar.org'],
  },
  {
    id: 'AzMIU',
    az: 'Azərbaycan Memarlıq və İnşaat Universiteti',
    en: 'Azerbaijan University of Architecture and Construction',
    ru: 'Азербайджанский архитектурно-строительный университет',
    domains: ['azmiu.edu.az'],
  },
  {
    id: 'ASADA',
    az: 'Azərbaycan Dövlət Aqrar Universiteti',
    en: 'Azerbaijan State Agricultural University',
    ru: 'Азербайджанский государственный аграрный университет',
    domains: ['adau.edu.az'],
  },
  {
    id: 'GDU',
    az: 'Gəncə Dövlət Universiteti',
    en: 'Ganja State University',
    ru: 'Гянджинский государственный университет',
    domains: ['gdu.edu.az'],
  },
  {
    id: 'SDU',
    az: 'Sumqayıt Dövlət Universiteti',
    en: 'Sumgait State University',
    ru: 'Сумгаитский государственный университет',
    domains: ['sdu.edu.az'],
  },
  {
    id: 'NDU',
    az: 'Naxçıvan Dövlət Universiteti',
    en: 'Nakhchivan State University',
    ru: 'Нахчыванский государственный университет',
    domains: ['ndu.edu.az'],
  },
  {
    id: 'MDU',
    az: 'Mingəçevir Dövlət Universiteti',
    en: 'Mingachevir State University',
    ru: 'Мингячевирский государственный университет',
    domains: ['mdu.edu.az'],
  },
  {
    id: 'LDU',
    az: 'Lənkəran Dövlət Universiteti',
    en: 'Lankaran State University',
    ru: 'Лянкяранский государственный университет',
    domains: ['lsu.edu.az'],
  },
  {
    id: 'AUL',
    az: 'Azərbaycan Universiteti',
    en: 'Azerbaijan University',
    ru: 'Университет Азербайджан',
    domains: ['au.edu.az'],
  },
];

/**
 * Reverse index: domain -> university id. Built once at module load.
 *
 * A flat map rather than a scan through `UNIVERSITIES` on every keystroke.
 * With 18 institutions the difference is irrelevant for correctness but the
 * lookup runs on every character typed into the email field, and a map keeps
 * that honest as the list grows.
 */
const DOMAIN_INDEX: ReadonlyMap<string, string> = new Map(
  UNIVERSITIES.flatMap((uni) => uni.domains.map((domain) => [domain, uni.id] as const)),
);

/**
 * Resolves a university from an email address.
 *
 * Returns null when the address is incomplete, has no domain, or the domain is
 * not one we recognise (gmail, mail.ru, a personal domain). Returning null
 * rather than guessing matters: plenty of genuine students sign up with a
 * personal address because their university mailbox is unusable, and silently
 * picking the wrong institution for them is worse than picking none.
 *
 * Subdomains resolve to their parent, so `name@std.ada.edu.az` and
 * `name@ada.edu.az` both find ADA. Azerbaijani universities commonly issue
 * student mail on a `std.` or `stu.` subdomain, and matching only the exact
 * domain would miss most real student addresses.
 */
export function detectUniversityFromEmail(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at === -1) return null;

  const domain = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, '');
  if (!domain.includes('.')) return null; // still typing

  const exact = DOMAIN_INDEX.get(domain);
  if (exact) return exact;

  // Walk up the label chain: std.ada.edu.az -> ada.edu.az -> edu.az -> az
  const labels = domain.split('.');
  for (let i = 1; i < labels.length - 1; i++) {
    const parent = labels.slice(i).join('.');
    const match = DOMAIN_INDEX.get(parent);
    if (match) return match;
  }

  return null;
}

/** Localised display name. Falls back to the code if the id is unknown. */
export function universityName(id: string, locale: 'az' | 'en' | 'ru'): string {
  return UNIVERSITIES.find((uni) => uni.id === id)?.[locale] ?? id;
}

/** True when the address is on an official domain for the selected university. */
export function emailMatchesUniversity(email: string, universityId: string): boolean {
  return detectUniversityFromEmail(email) === universityId;
}
