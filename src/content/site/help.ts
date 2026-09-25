import type { LocalizedSitePage } from './types';

/**
 * /help. Every answer describes a flow that exists in the app today and links
 * to the screen that performs it; site.test.ts checks those links resolve.
 * Section ids and order must match across locales.
 */
export const HELP: LocalizedSitePage = {
  en: {
    eyebrow: 'Help',
    title: 'Help centre',
    summary: "Answers to the questions we hear most often. Can't find yours? [Contact us](/contact) and we will help.",
    sections: [
      {
        id: 'getting-started',
        heading: 'Getting started',
        body: [
          {
            faq: [
              {
                q: 'How do I create an account?',
                a: 'Choose [Sign up](/register), fill in your details and confirm your email address with the link we send you. You can also continue with Google; you then pick a nickname and finish your profile before you can post.',
              },
              {
                q: 'Do I need to verify my identity?',
                a: 'Not to use the feed or UniNotes. Booking a mentor session, or offering one as a mentor, needs a verified account: upload your documents on the [verification page](/verify). The images are used only for that check and are deleted after review.',
              },
              {
                q: 'Which languages can I use?',
                a: 'Azerbaijani, English and Russian. Switch at any time from the language menu at the top of the page.',
              },
            ],
          },
        ],
      },
      {
        id: 'account',
        heading: 'Your account',
        body: [
          {
            faq: [
              {
                q: 'I forgot my password.',
                a: 'On the [sign-in page](/login) choose "Forgot your password?" and enter your email address. We send you a link to set a new password; it works once and expires after a short time.',
              },
              {
                q: 'How do I change my email address or password?',
                a: 'Both are in [Settings → Security](/settings/security). A new email address takes effect only after you confirm it from that inbox.',
              },
              {
                q: 'How do I turn on two-factor authentication?',
                a: 'Open [Settings → Security](/settings/security) and scan the QR code with an authenticator app. Keep your recovery codes somewhere safe - they are your way back in if you lose your phone.',
              },
              {
                q: "I see a device I don't recognise.",
                a: 'Open [Settings → Account](/settings?tab=account), sign that device out, then change your password.',
              },
              {
                q: 'How do I download or delete my data?',
                a: '[Download my data](/settings/data) gives you a copy of everything we hold about your account. To close your account, choose Delete account in [Settings → Account](/settings?tab=account); an administrator reviews the request.',
              },
            ],
          },
        ],
      },
      {
        id: 'feed',
        heading: 'Feed and followers',
        body: [
          {
            faq: [
              {
                q: 'How does following work?',
                a: 'When you follow someone they receive a follow request and decide whether to accept it. Requests sent to you appear in [Notifications](/notifications).',
              },
              {
                q: 'How do I delete or report a post?',
                a: "Open the ••• menu on the post. On your own post you can delete it; on someone else's you can report it to our moderators.",
              },
              {
                q: 'Can I read a post written in another language?',
                a: 'Yes. Choose Translate under the post and pick a language. The translation is automatic, so it may not be exact.',
              },
            ],
          },
        ],
      },
      {
        id: 'notes',
        heading: 'UniNotes',
        body: [
          {
            faq: [
              {
                q: 'Are notes really free?',
                a: 'Yes. Any signed-in member can read and download published notes, and rate the ones that helped.',
              },
              {
                q: 'How do I upload notes?',
                a: 'Choose [New note](/notes/new), add a title and subject and attach a PDF or Word file of up to 10 MB. A moderator reviews every upload before it is published.',
              },
              {
                q: 'Where are the notes I saved?',
                a: 'Under [Saved items](/dashboard?tab=saved) on your dashboard.',
              },
            ],
          },
        ],
      },
      {
        id: 'mentoring',
        heading: 'PocketMentor',
        body: [
          {
            faq: [
              {
                q: 'How do I book a mentor?',
                a: "Open a mentor's profile in [PocketMentor](/mentors), pick an open time and confirm. Booking needs a verified account.",
              },
              {
                q: 'How do I become a mentor?',
                a: 'Apply on the [Become a mentor](/mentors/apply) page with your experience and availability. We review every application; once it is approved your profile appears in the directory.',
              },
            ],
          },
        ],
      },
      {
        id: 'privacy',
        heading: 'Privacy',
        body: [
          {
            faq: [
              {
                q: 'Who can see my personal details?',
                a: 'Your nickname is always public. For your profile photo, real name, email, phone, university, faculty and graduation year you choose, one by one - everyone, verified students only, or only you - in [Settings → Privacy](/settings?tab=privacy).',
              },
              {
                q: 'Where can I read how my data is used?',
                a: 'In our [Privacy Policy](/legal/privacy). How we keep accounts secure is described on the [Safety and security](/legal/security) page.',
              },
            ],
          },
        ],
      },
    ],
  },

  az: {
    eyebrow: 'Kömək',
    title: 'Kömək mərkəzi',
    summary: 'Ən çox verilən suallara cavablar. Sualınızı tapmadınız? [Bizə yazın](/contact), kömək edək.',
    sections: [
      {
        id: 'getting-started',
        heading: 'Başlanğıc',
        body: [
          {
            faq: [
              {
                q: 'Hesabı necə yarada bilərəm?',
                a: '[Qeydiyyat](/register) səhifəsində məlumatlarınızı doldurun və göndərdiyimiz keçidlə e-poçt ünvanınızı təsdiqləyin. Google ilə də davam edə bilərsiniz; bu halda paylaşım etməzdən əvvəl nikneym seçib profilinizi tamamlayırsınız.',
              },
              {
                q: 'Şəxsiyyətimi doğrulamalıyammı?',
                a: 'Lent və UniNotes üçün lazım deyil. Mentorla görüş sifariş etmək və ya mentor kimi görüş təklif etmək üçün hesab doğrulanmalıdır: sənədlərinizi [doğrulama səhifəsində](/verify) yükləyin. Şəkillər yalnız bu yoxlama üçün istifadə olunur və yoxlamadan sonra silinir.',
              },
              {
                q: 'Hansı dillərdən istifadə edə bilərəm?',
                a: 'Azərbaycan, ingilis və rus dillərindən. Dili istənilən vaxt səhifənin yuxarısındakı dil menyusundan dəyişə bilərsiniz.',
              },
            ],
          },
        ],
      },
      {
        id: 'account',
        heading: 'Hesabınız',
        body: [
          {
            faq: [
              {
                q: 'Şifrəmi unutmuşam.',
                a: '[Giriş səhifəsində](/login) "Şifrəni unutmusunuz?" seçin və e-poçt ünvanınızı daxil edin. Yeni şifrə təyin etmək üçün sizə keçid göndəririk; o, bir dəfə işləyir və qısa müddətdən sonra etibarsız olur.',
              },
              {
                q: 'E-poçt ünvanımı və ya şifrəmi necə dəyişə bilərəm?',
                a: 'Hər ikisi [Tənzimləmələr → Təhlükəsizlik](/settings/security) bölməsindədir. Yeni e-poçt ünvanı yalnız həmin poçt qutusundan təsdiqlədikdən sonra qüvvəyə minir.',
              },
              {
                q: 'İki mərhələli doğrulamanı necə aktivləşdirim?',
                a: '[Tənzimləmələr → Təhlükəsizlik](/settings/security) bölməsini açın və QR kodu autentifikator tətbiqi ilə skan edin. Bərpa kodlarını etibarlı yerdə saxlayın - telefonunuzu itirsəniz, hesaba yalnız onlarla qayıda bilərsiniz.',
              },
              {
                q: 'Tanımadığım bir cihaz görürəm.',
                a: '[Tənzimləmələr → Hesab](/settings?tab=account) bölməsini açın, həmin cihazdan çıxış edin və sonra şifrənizi dəyişin.',
              },
              {
                q: 'Məlumatlarımı necə yükləyə və ya silə bilərəm?',
                a: '[Məlumatlarımı yüklə](/settings/data) hesabınız haqqında saxladığımız bütün məlumatların surətini verir. Hesabınızı bağlamaq üçün [Tənzimləmələr → Hesab](/settings?tab=account) bölməsində "Hesabı sil" seçin; sorğunu administrator nəzərdən keçirir.',
              },
            ],
          },
        ],
      },
      {
        id: 'feed',
        heading: 'Lent və izləyicilər',
        body: [
          {
            faq: [
              {
                q: 'İzləmə necə işləyir?',
                a: 'Kimisə izləmək istədikdə ona izləmə sorğusu gedir və o, qəbul edib-etməməyə özü qərar verir. Sizə gələn sorğular [Bildirişlər](/notifications) bölməsində görünür.',
              },
              {
                q: 'Paylaşımı necə silə və ya şikayət edə bilərəm?',
                a: 'Paylaşımdakı ••• menyusunu açın. Öz paylaşımınızı silə, başqasının paylaşımından isə moderatorlarımıza şikayət edə bilərsiniz.',
              },
              {
                q: 'Başqa dildə yazılmış paylaşımı oxuya bilərəmmi?',
                a: 'Bəli. Paylaşımın altında "Tərcümə et" seçin və dili müəyyən edin. Tərcümə avtomatikdir, ona görə tam dəqiq olmaya bilər.',
              },
            ],
          },
        ],
      },
      {
        id: 'notes',
        heading: 'UniNotes',
        body: [
          {
            faq: [
              {
                q: 'Konspektlər həqiqətən pulsuzdur?',
                a: 'Bəli. Daxil olmuş istənilən üzv dərc olunmuş konspektləri oxuya, endirə və faydalı olanları qiymətləndirə bilər.',
              },
              {
                q: 'Konspekti necə yükləyə bilərəm?',
                a: '[Yeni konspekt](/notes/new) seçin, başlıq və fənni yazın, 10 MB-a qədər PDF və ya Word faylı əlavə edin. Hər yükləməni dərc olunmazdan əvvəl moderator yoxlayır.',
              },
              {
                q: 'Yadda saxladığım konspektlər haradadır?',
                a: 'İdarə panelinizdəki [Saxlanılanlar](/dashboard?tab=saved) bölməsində.',
              },
            ],
          },
        ],
      },
      {
        id: 'mentoring',
        heading: 'PocketMentor',
        body: [
          {
            faq: [
              {
                q: 'Mentorla görüşü necə sifariş edim?',
                a: '[PocketMentor](/mentors) bölməsində mentorun profilini açın, boş vaxtı seçin və təsdiqləyin. Sifariş üçün hesab doğrulanmış olmalıdır.',
              },
              {
                q: 'Necə mentor ola bilərəm?',
                a: '[Mentor ol](/mentors/apply) səhifəsində təcrübənizi və boş vaxtlarınızı göstərərək müraciət edin. Hər müraciəti nəzərdən keçiririk; təsdiqləndikdən sonra profiliniz kataloqda görünür.',
              },
            ],
          },
        ],
      },
      {
        id: 'privacy',
        heading: 'Məxfilik',
        body: [
          {
            faq: [
              {
                q: 'Şəxsi məlumatlarımı kim görə bilər?',
                a: 'Nikneyminiz həmişə açıqdır. Profil şəkli, həqiqi ad, e-poçt, telefon, universitet, fakültə və məzun olma ili üçün hər birini ayrıca - hamı, yalnız doğrulanmış tələbələr və ya yalnız siz - [Tənzimləmələr → Məxfilik](/settings?tab=privacy) bölməsində seçirsiniz.',
              },
              {
                q: 'Məlumatlarımın necə istifadə olunduğunu harada oxuya bilərəm?',
                a: '[Məxfilik siyasətində](/legal/privacy). Hesabların necə qorunduğu [Təhlükəsizlik](/legal/security) səhifəsində izah olunub.',
              },
            ],
          },
        ],
      },
    ],
  },

  ru: {
    eyebrow: 'Помощь',
    title: 'Центр помощи',
    summary: 'Ответы на самые частые вопросы. Не нашли свой? [Напишите нам](/contact), и мы поможем.',
    sections: [
      {
        id: 'getting-started',
        heading: 'Начало работы',
        body: [
          {
            faq: [
              {
                q: 'Как создать аккаунт?',
                a: 'Выберите [Регистрацию](/register), заполните данные и подтвердите адрес электронной почты по ссылке из письма. Можно также продолжить через Google; тогда перед первой публикацией вы выберете никнейм и заполните профиль.',
              },
              {
                q: 'Нужно ли подтверждать личность?',
                a: 'Для ленты и UniNotes - нет. Чтобы записаться к ментору или проводить сессии в качестве ментора, аккаунт должен быть верифицирован: загрузите документы на [странице верификации](/verify). Изображения используются только для этой проверки и удаляются после неё.',
              },
              {
                q: 'Какие языки доступны?',
                a: 'Азербайджанский, английский и русский. Язык можно сменить в любой момент в меню языка вверху страницы.',
              },
            ],
          },
        ],
      },
      {
        id: 'account',
        heading: 'Ваш аккаунт',
        body: [
          {
            faq: [
              {
                q: 'Я забыл пароль.',
                a: 'На [странице входа](/login) выберите «Забыли пароль?» и введите адрес электронной почты. Мы пришлём ссылку для установки нового пароля; она работает один раз и вскоре перестаёт действовать.',
              },
              {
                q: 'Как изменить электронную почту или пароль?',
                a: 'Оба параметра находятся в разделе [Настройки → Безопасность](/settings/security). Новый адрес почты начинает действовать только после подтверждения из этого почтового ящика.',
              },
              {
                q: 'Как включить двухфакторную аутентификацию?',
                a: 'Откройте [Настройки → Безопасность](/settings/security) и отсканируйте QR-код приложением-аутентификатором. Храните резервные коды в надёжном месте - только с ними можно вернуться в аккаунт, если вы потеряете телефон.',
              },
              {
                q: 'Я вижу незнакомое устройство.',
                a: 'Откройте [Настройки → Аккаунт](/settings?tab=account), завершите сеанс на этом устройстве и смените пароль.',
              },
              {
                q: 'Как скачать или удалить свои данные?',
                a: '[Скачать мои данные](/settings/data) - копия всего, что мы храним о вашем аккаунте. Чтобы закрыть аккаунт, выберите «Удалить аккаунт» в разделе [Настройки → Аккаунт](/settings?tab=account); запрос рассматривает администратор.',
              },
            ],
          },
        ],
      },
      {
        id: 'feed',
        heading: 'Лента и подписчики',
        body: [
          {
            faq: [
              {
                q: 'Как работают подписки?',
                a: 'Когда вы подписываетесь на человека, он получает запрос на подписку и сам решает, принять ли его. Запросы к вам появляются в [Уведомлениях](/notifications).',
              },
              {
                q: 'Как удалить публикацию или пожаловаться на неё?',
                a: 'Откройте меню ••• на публикации. Свою публикацию можно удалить, на чужую - пожаловаться модераторам.',
              },
              {
                q: 'Можно ли прочитать публикацию на другом языке?',
                a: 'Да. Нажмите «Перевести» под публикацией и выберите язык. Перевод автоматический, поэтому может быть неточным.',
              },
            ],
          },
        ],
      },
      {
        id: 'notes',
        heading: 'UniNotes',
        body: [
          {
            faq: [
              {
                q: 'Конспекты действительно бесплатные?',
                a: 'Да. Любой вошедший участник может читать и скачивать опубликованные конспекты и оценивать те, что помогли.',
              },
              {
                q: 'Как загрузить конспект?',
                a: 'Выберите [Новый конспект](/notes/new), укажите название и предмет и прикрепите файл PDF или Word размером до 10 МБ. Каждую загрузку перед публикацией проверяет модератор.',
              },
              {
                q: 'Где сохранённые конспекты?',
                a: 'В разделе [Сохранённое](/dashboard?tab=saved) на вашей панели.',
              },
            ],
          },
        ],
      },
      {
        id: 'mentoring',
        heading: 'PocketMentor',
        body: [
          {
            faq: [
              {
                q: 'Как записаться к ментору?',
                a: 'Откройте профиль ментора в [PocketMentor](/mentors), выберите свободное время и подтвердите. Для записи нужен верифицированный аккаунт.',
              },
              {
                q: 'Как стать ментором?',
                a: 'Подайте заявку на странице [Стать ментором](/mentors/apply), указав опыт и удобное время. Мы рассматриваем каждую заявку; после одобрения ваш профиль появится в каталоге.',
              },
            ],
          },
        ],
      },
      {
        id: 'privacy',
        heading: 'Приватность',
        body: [
          {
            faq: [
              {
                q: 'Кто видит мои личные данные?',
                a: 'Ваш никнейм всегда публичен. Для фото профиля, настоящего имени, почты, телефона, университета, факультета и года выпуска вы выбираете отдельно - все, только верифицированные студенты или только вы - в разделе [Настройки → Приватность](/settings?tab=privacy).',
              },
              {
                q: 'Где прочитать, как используются мои данные?',
                a: 'В [Политике конфиденциальности](/legal/privacy). Как мы защищаем аккаунты, описано на странице [Безопасность](/legal/security).',
              },
            ],
          },
        ],
      },
    ],
  },
};
