import type { LocalizedSitePage } from './types';

/**
 * /about. Describes the product as the code implements it today; keep it in
 * step when a feature changes (notes stop being free, verification rules
 * change). Section ids and order must match across locales - site.test.ts.
 */
export const ABOUT: LocalizedSitePage = {
  en: {
    eyebrow: 'About us',
    title: 'About campusnotehub',
    summary:
      'campusnotehub is the social platform for university students and graduates in Azerbaijan: one place to follow classmates, share class notes and get career advice from people who do the job.',
    sections: [
      {
        id: 'who',
        heading: 'Who we are',
        body: [
          'campusnotehub is built in Baku for the students of Azerbaijani universities. The idea is simple: the most useful things at university - good class notes, honest advice and news from your campus - should be easy to find and free to share.',
          'Students can confirm their student status with their documents, and a verified badge shows who has. Mentors are verified before they can offer sessions.',
        ],
      },
      {
        id: 'what',
        heading: 'What you can do here',
        body: [
          {
            list: [
              'Campus feed - post news, questions and photos, comment and like, follow classmates and filter the feed by university.',
              "UniNotes - upload your class notes and download other students' notes for free. A moderator reviews every file before it is published.",
              'PocketMentor - book one-on-one sessions with working professionals in IT, marketing, law, engineering and more.',
            ],
          },
        ],
      },
      {
        id: 'principles',
        heading: 'What we believe in',
        body: [
          {
            list: [
              'Free knowledge. Reading and downloading class notes is free for every member.',
              'You control your information. You decide who sees your real name, contact details and university, field by field.',
              'No selling of data. We do not sell your personal data and we do not use it for third-party advertising.',
              'Real people. Verification, moderation and reporting keep the community genuine and safe.',
            ],
          },
        ],
      },
      {
        id: 'languages',
        heading: 'Made for Azerbaijan',
        body: [
          'campusnotehub works in Azerbaijani, English and Russian - switch at any time from the language menu. A post written in another language can be translated with one tap.',
        ],
      },
      {
        id: 'join',
        heading: 'Get involved',
        body: [
          'New here? [Create a free account](/register) and find your classmates. A professional who would like to help students? [Become a mentor](/mentors/apply). For anything else - ideas, partnerships, press - [contact us](/contact).',
        ],
      },
    ],
  },

  az: {
    eyebrow: 'Haqqımızda',
    title: 'campusnotehub haqqında',
    summary:
      'campusnotehub Azərbaycanda universitet tələbələri və məzunları üçün sosial platformadır: qrup yoldaşlarınızı izləmək, konspekt paylaşmaq və bu işi görən insanlardan karyera məsləhəti almaq üçün bir məkan.',
    sections: [
      {
        id: 'who',
        heading: 'Biz kimik',
        body: [
          'campusnotehub Bakıda, Azərbaycan universitetlərinin tələbələri üçün yaradılır. İdeya sadədir: universitetdə ən faydalı şeylər - yaxşı konspektlər, səmimi məsləhət və kampusdan xəbərlər - asan tapılmalı və pulsuz paylaşılmalıdır.',
          'Tələbələr sənədləri ilə tələbə statuslarını təsdiqləyə bilər, doğrulanmış nişan isə bunu kimin etdiyini göstərir. Mentorlar sessiya təklif etməzdən əvvəl doğrulanır.',
        ],
      },
      {
        id: 'what',
        heading: 'Burada nə edə bilərsiniz',
        body: [
          {
            list: [
              'Kampus lenti - xəbər, sual və şəkil paylaşın, şərh yazın və bəyənin, qrup yoldaşlarınızı izləyin və lenti universitetə görə süzün.',
              'UniNotes - öz konspektlərinizi yükləyin, digər tələbələrin konspektlərini isə pulsuz endirin. Hər fayl dərc olunmazdan əvvəl moderator tərəfindən yoxlanılır.',
              'PocketMentor - İT, marketinq, hüquq, mühəndislik və digər sahələrdə çalışan mütəxəssislərlə təkbətək görüş sifariş edin.',
            ],
          },
        ],
      },
      {
        id: 'principles',
        heading: 'Nəyə inanırıq',
        body: [
          {
            list: [
              'Pulsuz bilik. Konspektləri oxumaq və endirmək bütün üzvlər üçün pulsuzdur.',
              'Məlumatlarınıza siz nəzarət edirsiniz. Həqiqi adınızı, əlaqə məlumatlarınızı və universitetinizi kimin görəcəyinə hər sahə üzrə ayrıca siz qərar verirsiniz.',
              'Məlumat satışı yoxdur. Şəxsi məlumatlarınızı satmırıq və üçüncü tərəf reklamı üçün istifadə etmirik.',
              'Real insanlar. Doğrulama, moderasiya və şikayət imkanı icmanı səmimi və təhlükəsiz saxlayır.',
            ],
          },
        ],
      },
      {
        id: 'languages',
        heading: 'Azərbaycan üçün yaradılıb',
        body: [
          'campusnotehub Azərbaycan, ingilis və rus dillərində işləyir - dili istənilən vaxt dil menyusundan dəyişə bilərsiniz. Başqa dildə yazılmış paylaşımı bir toxunuşla tərcümə etmək olar.',
        ],
      },
      {
        id: 'join',
        heading: 'Bizə qoşulun',
        body: [
          'Yenisiniz? [Pulsuz hesab yaradın](/register) və qrup yoldaşlarınızı tapın. Tələbələrə kömək etmək istəyən mütəxəssissiniz? [Mentor olun](/mentors/apply). Qalan hər şey üçün - ideyalar, əməkdaşlıq, mətbuat - [bizimlə əlaqə saxlayın](/contact).',
        ],
      },
    ],
  },

  ru: {
    eyebrow: 'О нас',
    title: 'О campusnotehub',
    summary:
      'campusnotehub - социальная платформа для студентов и выпускников университетов Азербайджана: здесь можно следить за однокурсниками, делиться конспектами и получать советы о карьере от тех, кто уже работает в профессии.',
    sections: [
      {
        id: 'who',
        heading: 'Кто мы',
        body: [
          'campusnotehub создаётся в Баку для студентов азербайджанских университетов. Идея простая: самое полезное в университете - хорошие конспекты, честные советы и новости кампуса - должно легко находиться и бесплатно передаваться другим.',
          'Студенты могут подтвердить свой статус документами, а значок верификации показывает, кто это сделал. Менторы проходят проверку, прежде чем смогут предлагать сессии.',
        ],
      },
      {
        id: 'what',
        heading: 'Что здесь можно делать',
        body: [
          {
            list: [
              'Лента кампуса - публикуйте новости, вопросы и фото, комментируйте и ставьте лайки, подписывайтесь на однокурсников и фильтруйте ленту по университету.',
              'UniNotes - загружайте свои конспекты и бесплатно скачивайте конспекты других студентов. Каждый файл проверяет модератор перед публикацией.',
              'PocketMentor - записывайтесь на индивидуальные встречи с практикующими специалистами в IT, маркетинге, праве, инженерии и других областях.',
            ],
          },
        ],
      },
      {
        id: 'principles',
        heading: 'Во что мы верим',
        body: [
          {
            list: [
              'Свободные знания. Читать и скачивать конспекты может каждый участник - бесплатно.',
              'Вы управляете своими данными. Кто видит ваше настоящее имя, контакты и университет, вы решаете отдельно для каждого поля.',
              'Никакой продажи данных. Мы не продаём ваши персональные данные и не используем их для сторонней рекламы.',
              'Настоящие люди. Верификация, модерация и жалобы помогают сохранять сообщество честным и безопасным.',
            ],
          },
        ],
      },
      {
        id: 'languages',
        heading: 'Сделано для Азербайджана',
        body: [
          'campusnotehub работает на азербайджанском, английском и русском языках - язык можно сменить в любой момент в меню языка. Публикацию на другом языке можно перевести одним нажатием.',
        ],
      },
      {
        id: 'join',
        heading: 'Присоединяйтесь',
        body: [
          'Впервые здесь? [Создайте бесплатный аккаунт](/register) и найдите однокурсников. Вы специалист и хотите помогать студентам? [Станьте ментором](/mentors/apply). По всем остальным вопросам - идеи, партнёрство, пресса - [напишите нам](/contact).',
        ],
      },
    ],
  },
};
