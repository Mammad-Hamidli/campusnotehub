import type { LocalizedSitePage } from './types';

/**
 * /contact. The address is the monitored support mailbox - the same one the
 * Privacy Policy and every transactional email name (EMAIL_SUPPORT_ADDRESS,
 * see lib/email/identity.ts). Change it in all of them together.
 * Section ids and order must match across locales - site.test.ts.
 */
export const CONTACT: LocalizedSitePage = {
  en: {
    eyebrow: 'Contact',
    title: 'Contact us',
    summary: 'A question, feedback or a problem with your account - we read every message.',
    sections: [
      {
        id: 'support',
        heading: 'Support',
        body: [
          'Write to supportcampushub@gmail.com. Tell us your nickname and what happened; a screenshot helps. We reply by email.',
          'Never include your password or any code in a message - we will never ask for them.',
          'Many answers are already in the [Help centre](/help).',
        ],
      },
      {
        id: 'privacy',
        heading: 'Privacy and your data',
        body: [
          'Questions about your personal data can go to the same address. You can also [download your data](/settings/data) yourself at any time, and request account deletion in [Settings → Account](/settings?tab=account).',
        ],
      },
      {
        id: 'security',
        heading: 'Security issues',
        body: [
          'To report a vulnerability or an account someone else may be using, email supportcampushub@gmail.com with "Security" in the subject. [Safety and security](/legal/security) explains what to include.',
        ],
      },
      {
        id: 'partners',
        heading: 'Mentors and partnerships',
        body: [
          'Professionals who would like to mentor students can apply on the [Become a mentor](/mentors/apply) page. Universities, student clubs and organisations that want to work with us: write to supportcampushub@gmail.com.',
        ],
      },
      {
        id: 'location',
        heading: 'Where we are',
        body: ['campusnotehub is based in Baku, Azerbaijan.'],
      },
    ],
  },

  az: {
    eyebrow: 'Əlaqə',
    title: 'Bizimlə əlaqə',
    summary: 'Sual, rəy və ya hesabınızla bağlı problem - hər mesajı oxuyuruq.',
    sections: [
      {
        id: 'support',
        heading: 'Dəstək',
        body: [
          'supportcampushub@gmail.com ünvanına yazın. Nikneyminizi və nə baş verdiyini qeyd edin; ekran şəkli kömək edir. Cavabı e-poçtla göndəririk.',
          'Mesaja heç vaxt şifrənizi və ya hər hansı kodu əlavə etməyin - biz onları heç vaxt soruşmuruq.',
          'Bir çox cavab artıq [Kömək mərkəzində](/help) var.',
        ],
      },
      {
        id: 'privacy',
        heading: 'Məxfilik və məlumatlarınız',
        body: [
          'Şəxsi məlumatlarınızla bağlı sualları eyni ünvana göndərə bilərsiniz. Həmçinin istənilən vaxt [məlumatlarınızı özünüz yükləyə](/settings/data) və [Tənzimləmələr → Hesab](/settings?tab=account) bölməsində hesabın silinməsini tələb edə bilərsiniz.',
        ],
      },
      {
        id: 'security',
        heading: 'Təhlükəsizlik problemləri',
        body: [
          'Təhlükəsizlik boşluğu və ya başqasının istifadə etdiyi hesab barədə məlumat vermək üçün mövzu sətrində "Security" yazaraq supportcampushub@gmail.com ünvanına yazın. Nələri qeyd etmək lazım olduğu [Təhlükəsizlik](/legal/security) səhifəsində izah olunub.',
        ],
      },
      {
        id: 'partners',
        heading: 'Mentorlar və əməkdaşlıq',
        body: [
          'Tələbələrə mentorluq etmək istəyən mütəxəssislər [Mentor ol](/mentors/apply) səhifəsində müraciət edə bilər. Bizimlə əməkdaşlıq etmək istəyən universitetlər, tələbə klubları və təşkilatlar supportcampushub@gmail.com ünvanına yaza bilər.',
        ],
      },
      {
        id: 'location',
        heading: 'Harada yerləşirik',
        body: ['campusnotehub Bakıda, Azərbaycanda yerləşir.'],
      },
    ],
  },

  ru: {
    eyebrow: 'Контакты',
    title: 'Связаться с нами',
    summary: 'Вопрос, отзыв или проблема с аккаунтом - мы читаем каждое сообщение.',
    sections: [
      {
        id: 'support',
        heading: 'Поддержка',
        body: [
          'Напишите на supportcampushub@gmail.com. Укажите свой никнейм и опишите, что произошло; скриншот поможет. Мы отвечаем по электронной почте.',
          'Никогда не отправляйте в сообщении пароль или коды - мы их никогда не запрашиваем.',
          'Многие ответы уже есть в [Центре помощи](/help).',
        ],
      },
      {
        id: 'privacy',
        heading: 'Приватность и ваши данные',
        body: [
          'Вопросы о персональных данных можно отправлять на тот же адрес. Кроме того, вы в любой момент можете [скачать свои данные](/settings/data) сами и запросить удаление аккаунта в разделе [Настройки → Аккаунт](/settings?tab=account).',
        ],
      },
      {
        id: 'security',
        heading: 'Вопросы безопасности',
        body: [
          'Чтобы сообщить об уязвимости или об аккаунте, которым может пользоваться кто-то другой, напишите на supportcampushub@gmail.com с темой «Security». Что указать в письме, описано на странице [Безопасность](/legal/security).',
        ],
      },
      {
        id: 'partners',
        heading: 'Менторы и партнёрство',
        body: [
          'Специалисты, которые хотят стать менторами для студентов, могут подать заявку на странице [Стать ментором](/mentors/apply). Университеты, студенческие клубы и организации, желающие сотрудничать с нами, могут написать на supportcampushub@gmail.com.',
        ],
      },
      {
        id: 'location',
        heading: 'Где мы находимся',
        body: ['campusnotehub находится в Баку, Азербайджан.'],
      },
    ],
  },
};
