import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

/**
 * Authorised universities for the registration dropdown.
 *
 * `emailDomains` is a trust signal, not a gate: a matching university address
 * raises the authenticity score, but plenty of genuine students sign up with
 * Gmail because their university mailbox is unusable, so a non-matching domain
 * must never block registration on its own.
 */
const UNIVERSITIES = [
  { code: 'BDU', nameAz: 'Bakı Dövlət Universiteti', nameEn: 'Baku State University', nameRu: 'Бакинский государственный университет', city: 'Bakı', emailDomains: ['bsu.edu.az'] },
  { code: 'ADA', nameAz: 'ADA Universiteti', nameEn: 'ADA University', nameRu: 'Университет АДА', city: 'Bakı', emailDomains: ['ada.edu.az'] },
  { code: 'UNEC', nameAz: 'Azərbaycan Dövlət İqtisad Universiteti', nameEn: 'Azerbaijan State University of Economics', nameRu: 'Азербайджанский государственный экономический университет', city: 'Bakı', emailDomains: ['unec.edu.az'] },
  { code: 'ADNSU', nameAz: 'Azərbaycan Dövlət Neft və Sənaye Universiteti', nameEn: 'Azerbaijan State Oil and Industry University', nameRu: 'Азербайджанский государственный университет нефти и промышленности', city: 'Bakı', emailDomains: ['asoiu.edu.az'] },
  { code: 'BMU', nameAz: 'Bakı Mühəndislik Universiteti', nameEn: 'Baku Engineering University', nameRu: 'Бакинский инженерный университет', city: 'Xırdalan', emailDomains: ['beu.edu.az'] },
  { code: 'AzMİU', nameAz: 'Azərbaycan Memarlıq və İnşaat Universiteti', nameEn: 'Azerbaijan University of Architecture and Construction', nameRu: 'Азербайджанский архитектурно-строительный университет', city: 'Bakı', emailDomains: ['azmiu.edu.az'] },
  { code: 'ATU', nameAz: 'Azərbaycan Tibb Universiteti', nameEn: 'Azerbaijan Medical University', nameRu: 'Азербайджанский медицинский университет', city: 'Bakı', emailDomains: ['amu.edu.az'] },
  { code: 'ADPU', nameAz: 'Azərbaycan Dövlət Pedaqoji Universiteti', nameEn: 'Azerbaijan State Pedagogical University', nameRu: 'Азербайджанский государственный педагогический университет', city: 'Bakı', emailDomains: ['adpu.edu.az'] },
  { code: 'ADU', nameAz: 'Azərbaycan Dillər Universiteti', nameEn: 'Azerbaijan University of Languages', nameRu: 'Азербайджанский университет языков', city: 'Bakı', emailDomains: ['adu.edu.az'] },
  { code: 'KHAZAR', nameAz: 'Xəzər Universiteti', nameEn: 'Khazar University', nameRu: 'Университет Хазар', city: 'Bakı', emailDomains: ['khazar.org'] },
  { code: 'ASADA', nameAz: 'Azərbaycan Dövlət Aqrar Universiteti', nameEn: 'Azerbaijan State Agricultural University', nameRu: 'Азербайджанский государственный аграрный университет', city: 'Gəncə', emailDomains: ['adau.edu.az'] },
  { code: 'GDU', nameAz: 'Gəncə Dövlət Universiteti', nameEn: 'Ganja State University', nameRu: 'Гянджинский государственный университет', city: 'Gəncə', emailDomains: ['gdu.edu.az'] },
  { code: 'MDU', nameAz: 'Mingəçevir Dövlət Universiteti', nameEn: 'Mingachevir State University', nameRu: 'Мингячевирский государственный университет', city: 'Mingəçevir', emailDomains: ['mdu.edu.az'] },
  { code: 'NDU', nameAz: 'Naxçıvan Dövlət Universiteti', nameEn: 'Nakhchivan State University', nameRu: 'Нахчыванский государственный университет', city: 'Naxçıvan', emailDomains: ['ndu.edu.az'] },
  { code: 'SDU', nameAz: 'Sumqayıt Dövlət Universiteti', nameEn: 'Sumgait State University', nameRu: 'Сумгаитский государственный университет', city: 'Sumqayıt', emailDomains: ['sdu.edu.az'] },
  { code: 'LDU', nameAz: 'Lənkəran Dövlət Universiteti', nameEn: 'Lankaran State University', nameRu: 'Лянкяранский государственный университет', city: 'Lənkəran', emailDomains: ['lsu.edu.az'] },
  { code: 'AUL', nameAz: 'Azərbaycan Universiteti', nameEn: 'Azerbaijan University', nameRu: 'Университет Азербайджан', city: 'Bakı', emailDomains: ['au.edu.az'] },
  { code: 'ASU', nameAz: 'Azərbaycan Texniki Universiteti', nameEn: 'Azerbaijan Technical University', nameRu: 'Азербайджанский технический университет', city: 'Bakı', emailDomains: ['aztu.edu.az'] },
];

/** Common tags, pre-seeded so the first users see a populated tag picker. */
const TAGS = [
  { slug: 'examalert', label: 'ExamAlert' },
  { slug: 'career', label: 'Career' },
  { slug: 'notes', label: 'Notes' },
  { slug: 'internship', label: 'Internship' },
  { slug: 'scholarship', label: 'Scholarship' },
  { slug: 'deadline', label: 'Deadline' },
  { slug: 'studygroup', label: 'StudyGroup' },
  { slug: 'thesis', label: 'Thesis' },
];

async function main() {
  for (const uni of UNIVERSITIES) {
    await db.university.upsert({
      where: { code: uni.code },
      create: uni,
      update: { nameAz: uni.nameAz, nameEn: uni.nameEn, nameRu: uni.nameRu, emailDomains: uni.emailDomains },
    });
  }
  console.log(`Seeded ${UNIVERSITIES.length} universities`);

  for (const tag of TAGS) {
    await db.tag.upsert({ where: { slug: tag.slug }, create: tag, update: {} });
  }
  console.log(`Seeded ${TAGS.length} tags`);

  // Platform-side ledger accounts must exist before any money moves.
  for (const type of ['PLATFORM_REVENUE', 'PLATFORM_ESCROW', 'EXTERNAL_GATEWAY'] as const) {
    const existing = await db.ledgerAccount.findFirst({ where: { type, walletId: null } });
    if (!existing) await db.ledgerAccount.create({ data: { type, walletId: null } });
  }
  console.log('Seeded platform ledger accounts');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
