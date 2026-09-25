import type { LocalizedSitePage } from './types';

/**
 * /legal/security ("Safety" in the footer).
 *
 * Every protection listed here is one the code enforces - keep it that way:
 *   - passwords: argon2id hashes only (lib/crypto/hash.ts);
 *   - lockout after repeated failed sign-ins (users.failedLoginCount);
 *   - idle timeout and server-side revocation on sign-out (lib/auth/session.ts,
 *     app/logout/route.ts) - the timeout is configurable, so no number is quoted;
 *   - identity documents deleted after review (lib/verification/reviewBuffer.ts);
 *   - note files stored as authenticated assets and downloadable only by a
 *     signed-in member (lib/cloudinary/server.ts, /api/notes/[noteId]/file).
 *     Post images are NOT claimed: /api/media/[mediaId] serves them by
 *     unguessable id without a per-post check, on purpose - see that route.
 * Section ids and order must match across locales - site.test.ts.
 */
export const SAFETY: LocalizedSitePage = {
  en: {
    eyebrow: 'Safety',
    title: 'Safety and security',
    summary:
      'How we protect your account and your data, and what you can do to keep yourself and the community safe.',
    sections: [
      {
        id: 'your-account',
        heading: 'Protect your account',
        body: [
          {
            list: [
              'Use a password you do not use anywhere else.',
              'Turn on two-factor authentication in [Settings → Security](/settings/security) and keep your recovery codes offline.',
              'From time to time, check the devices signed in to your account in [Settings → Account](/settings?tab=account) and sign out any you do not recognise.',
              'Sign out when you use a shared or public computer.',
            ],
          },
          'We will never ask for your password, verification codes or recovery codes - not by email and not in a message. Anyone who asks is not us.',
        ],
      },
      {
        id: 'our-measures',
        heading: 'How we protect your data',
        body: [
          {
            list: [
              'Passwords are stored only as strong one-way hashes, never in a readable form.',
              'Repeated wrong passwords temporarily lock sign-in, which stops guessing attacks.',
              'Sessions end after a period of inactivity, and signing out ends the session on our servers, not only in your browser.',
              'Identity documents uploaded for verification are used only for that check and are deleted after review. We keep only the outcome.',
              'Note files are stored privately and can be downloaded only by signed-in members.',
              'All traffic to campusnotehub is encrypted in transit (HTTPS).',
            ],
          },
        ],
      },
      {
        id: 'community',
        heading: 'A safe community',
        body: [
          {
            list: [
              'A verified badge shows who has confirmed their student or professional status.',
              'Following works by request: nobody follows you without your approval.',
              'You decide who sees each of your personal details in [Settings → Privacy](/settings?tab=privacy).',
              'Posts that break the rules can be reported from their ••• menu, and moderators review every report.',
              'Uploaded notes are checked by a moderator before they are published.',
            ],
          },
        ],
      },
      {
        id: 'mentoring',
        heading: 'Meeting mentors safely',
        body: [
          {
            list: [
              'Book sessions through campusnotehub, so there is a record of who you met and when.',
              'Never share passwords, codes or bank card details with a mentor or with anyone else.',
              'If a session makes you uncomfortable, end it and tell us at supportcampushub@gmail.com.',
            ],
          },
        ],
      },
      {
        id: 'report',
        heading: 'Report a problem',
        body: [
          'If you think someone else has access to your account, change your password, sign out all other devices in [Settings → Account](/settings?tab=account) and write to us at supportcampushub@gmail.com.',
          'Found a security vulnerability? Email supportcampushub@gmail.com with "Security" in the subject and the steps to reproduce it. Please give us reasonable time to fix it before making it public, and do not access other people\'s data or disrupt the service while testing.',
          'How we process personal data is described in the [Privacy Policy](/legal/privacy).',
        ],
      },
    ],
  },

  az: {
    eyebrow: 'Təhlükəsizlik',
    title: 'Təhlükəsizlik',
    summary:
      'Hesabınızı və məlumatlarınızı necə qoruduğumuz, özünüzü və icmanı qorumaq üçün isə nə edə biləcəyiniz.',
    sections: [
      {
        id: 'your-account',
        heading: 'Hesabınızı qoruyun',
        body: [
          {
            list: [
              'Başqa heç yerdə istifadə etmədiyiniz şifrə seçin.',
              '[Tənzimləmələr → Təhlükəsizlik](/settings/security) bölməsində iki mərhələli doğrulamanı aktivləşdirin və bərpa kodlarını oflayn saxlayın.',
              'Vaxtaşırı [Tənzimləmələr → Hesab](/settings?tab=account) bölməsində hesabınıza daxil olmuş cihazları yoxlayın və tanımadıqlarınızdan çıxış edin.',
              'Ortaq və ya ictimai kompüterdən istifadə etdikdə hesabdan çıxın.',
            ],
          },
          'Biz heç vaxt şifrənizi, doğrulama və ya bərpa kodlarınızı soruşmuruq - nə e-poçtla, nə də mesajla. Bunu soruşan biz deyilik.',
        ],
      },
      {
        id: 'our-measures',
        heading: 'Məlumatlarınızı necə qoruyuruq',
        body: [
          {
            list: [
              'Şifrələr yalnız güclü birtərəfli heş şəklində saxlanılır, heç vaxt oxuna bilən formada deyil.',
              'Dəfələrlə səhv şifrə daxil edildikdə giriş müvəqqəti bloklanır - bu, şifrə təxmin etmə hücumlarının qarşısını alır.',
              'Sessiyalar müəyyən müddət fəaliyyət olmadıqda başa çatır, hesabdan çıxış isə sessiyanı təkcə brauzerinizdə deyil, serverlərimizdə də bitirir.',
              'Doğrulama üçün yüklənən şəxsiyyət sənədləri yalnız həmin yoxlama üçün istifadə olunur və yoxlamadan sonra silinir. Biz yalnız nəticəni saxlayırıq.',
              'Konspekt faylları qapalı saxlanılır və onları yalnız hesaba daxil olmuş üzvlər endirə bilər.',
              'campusnotehub ilə bütün əlaqə ötürülmə zamanı şifrələnir (HTTPS).',
            ],
          },
        ],
      },
      {
        id: 'community',
        heading: 'Təhlükəsiz icma',
        body: [
          {
            list: [
              'Doğrulanmış nişan tələbə və ya peşəkar statusunu təsdiqləyənləri göstərir.',
              'İzləmə sorğu ilə işləyir: heç kim sizin razılığınız olmadan sizi izləyə bilməz.',
              'Şəxsi məlumatlarınızın hər birini kimin görəcəyinə [Tənzimləmələr → Məxfilik](/settings?tab=privacy) bölməsində siz qərar verirsiniz.',
              'Qaydaları pozan paylaşımlardan ••• menyusu vasitəsilə şikayət etmək olar və moderatorlar hər şikayəti nəzərdən keçirir.',
              'Yüklənən konspektlər dərc olunmazdan əvvəl moderator tərəfindən yoxlanılır.',
            ],
          },
        ],
      },
      {
        id: 'mentoring',
        heading: 'Mentorlarla təhlükəsiz görüş',
        body: [
          {
            list: [
              'Görüşləri campusnotehub vasitəsilə sifariş edin ki, kiminlə və nə vaxt görüşdüyünüzün qeydi qalsın.',
              'Şifrə, kod və ya bank kartı məlumatlarını heç vaxt mentorla və ya başqası ilə bölüşməyin.',
              'Görüş sizi narahat edirsə, onu bitirin və supportcampushub@gmail.com ünvanına bizə yazın.',
            ],
          },
        ],
      },
      {
        id: 'report',
        heading: 'Problem barədə məlumat verin',
        body: [
          'Hesabınıza başqasının daxil olduğunu düşünürsünüzsə, şifrənizi dəyişin, [Tənzimləmələr → Hesab](/settings?tab=account) bölməsində bütün digər cihazlardan çıxış edin və supportcampushub@gmail.com ünvanına bizə yazın.',
          'Təhlükəsizlik boşluğu tapmısınız? Mövzu sətrində "Security" yazaraq və təkrarlama addımlarını göstərərək supportcampushub@gmail.com ünvanına yazın. Açıqlamazdan əvvəl onu düzəltməyimiz üçün bizə ağlabatan vaxt verin və yoxlama zamanı başqalarının məlumatlarına daxil olmayın, xidmətin işini pozmayın.',
          'Şəxsi məlumatların necə emal olunduğu [Məxfilik siyasətində](/legal/privacy) izah olunub.',
        ],
      },
    ],
  },

  ru: {
    eyebrow: 'Безопасность',
    title: 'Безопасность',
    summary: 'Как мы защищаем ваш аккаунт и данные и что можете сделать вы, чтобы обезопасить себя и сообщество.',
    sections: [
      {
        id: 'your-account',
        heading: 'Защитите свой аккаунт',
        body: [
          {
            list: [
              'Используйте пароль, который больше нигде не используете.',
              'Включите двухфакторную аутентификацию в разделе [Настройки → Безопасность](/settings/security) и храните резервные коды офлайн.',
              'Время от времени проверяйте устройства, на которых выполнен вход, в разделе [Настройки → Аккаунт](/settings?tab=account) и завершайте сеансы на незнакомых.',
              'Выходите из аккаунта на общих и публичных компьютерах.',
            ],
          },
          'Мы никогда не просим ваш пароль, коды подтверждения или резервные коды - ни по почте, ни в сообщениях. Тот, кто просит, - не мы.',
        ],
      },
      {
        id: 'our-measures',
        heading: 'Как мы защищаем ваши данные',
        body: [
          {
            list: [
              'Пароли хранятся только в виде стойких односторонних хешей и никогда - в читаемом виде.',
              'После нескольких неверных паролей вход временно блокируется - это останавливает подбор пароля.',
              'Сеанс завершается после периода неактивности, а выход из аккаунта завершает сеанс на наших серверах, а не только в браузере.',
              'Документы, загруженные для верификации, используются только для этой проверки и удаляются после неё. Мы храним только результат.',
              'Файлы конспектов хранятся закрыто, и скачать их могут только участники, вошедшие в аккаунт.',
              'Всё соединение с campusnotehub шифруется при передаче (HTTPS).',
            ],
          },
        ],
      },
      {
        id: 'community',
        heading: 'Безопасное сообщество',
        body: [
          {
            list: [
              'Значок верификации показывает, кто подтвердил свой студенческий или профессиональный статус.',
              'Подписка работает по запросу: никто не подпишется на вас без вашего согласия.',
              'Кто видит каждое из ваших личных данных, вы решаете в разделе [Настройки → Приватность](/settings?tab=privacy).',
              'На публикации, нарушающие правила, можно пожаловаться через меню •••, и модераторы рассматривают каждую жалобу.',
              'Загруженные конспекты проверяет модератор перед публикацией.',
            ],
          },
        ],
      },
      {
        id: 'mentoring',
        heading: 'Безопасные встречи с менторами',
        body: [
          {
            list: [
              'Записывайтесь на встречи через campusnotehub, чтобы оставалась запись о том, с кем и когда вы встречались.',
              'Никогда не сообщайте пароли, коды или данные банковской карты ни ментору, ни кому-либо ещё.',
              'Если встреча вызывает у вас дискомфорт, завершите её и напишите нам на supportcampushub@gmail.com.',
            ],
          },
        ],
      },
      {
        id: 'report',
        heading: 'Сообщить о проблеме',
        body: [
          'Если вы считаете, что кто-то получил доступ к вашему аккаунту, смените пароль, завершите сеансы на всех других устройствах в разделе [Настройки → Аккаунт](/settings?tab=account) и напишите нам на supportcampushub@gmail.com.',
          'Нашли уязвимость? Напишите на supportcampushub@gmail.com с темой «Security» и шагами для воспроизведения. Пожалуйста, дайте нам разумное время на исправление, прежде чем публиковать её, и во время проверки не получайте доступ к чужим данным и не нарушайте работу сервиса.',
          'Как мы обрабатываем персональные данные, описано в [Политике конфиденциальности](/legal/privacy).',
        ],
      },
    ],
  },
};
