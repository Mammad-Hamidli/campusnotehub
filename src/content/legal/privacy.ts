import type { LocalizedLegalDocument } from './types';

/**
 * Privacy Policy - PLACEHOLDER TEXT.
 *
 * Generic starting copy so /legal/privacy is a real page. It has not been
 * reviewed by counsel and must be replaced before it is relied on; the page
 * says so in a visible notice (legal.draftNotice).
 *
 * Where it is specific, it describes what the code actually does today, and
 * must be kept in step with it:
 *   - cookies: exactly the five first-party cookies set by the app (CH_AT,
 *     CH_RT, CH_RF in lib/auth + middleware, CH_LOCALE, CH_THEME). There are no
 *     analytics or advertising scripts. Adding one means updating #cookies.
 *   - verification images are held only for the review window and then
 *     deleted (see the admin review buffer).
 *
 * Section ids and order must match across locales; legal.test.ts enforces it.
 */
export const PRIVACY: LocalizedLegalDocument = {
  effective: '2026-09-19',
  content: {
    en: {
      title: 'Privacy Policy',
      summary:
        'This policy explains what personal data CampusHub collects, why we collect it, how long we keep it, and the choices and rights you have.',
      sections: [
        {
          id: 'overview',
          heading: '1. Who we are',
          body: [
            'CampusHub (the "Platform", "we", "us") is a platform for university students and graduates in Azerbaijan. We are responsible for the personal data processed through the Platform and handle it in accordance with the Law of the Republic of Azerbaijan "On Personal Data" and other applicable law.',
          ],
        },
        {
          id: 'data',
          heading: '2. Data we collect',
          body: [
            'We collect only the data we need to run the Platform:',
            {
              list: [
                'Account data: your name, nickname, email address, phone number, date of birth, university, faculty and graduation year.',
                'Profile and content: your photo, bio, posts, comments, notes, reviews and messages you send through the Platform.',
                'Transaction data: wallet top-ups, purchases, bookings and payouts. Card details are handled by our payment provider and never reach our servers.',
                'Technical data: IP address, device and browser type, and security logs used to protect your account and prevent fraud.',
              ],
            },
          ],
        },
        {
          id: 'verification',
          heading: '3. Identity documents',
          body: [
            'If you choose to verify your account, you upload images of your identity and enrolment documents. We ask for your explicit consent at that moment.',
            'The images are used solely to confirm your student or professional status. They are kept only for the short period needed to complete the check, including a manual review by a moderator where required, and are then permanently deleted. We keep only the outcome of the check and the minimum record needed to prevent duplicate or fraudulent accounts.',
          ],
        },
        {
          id: 'use',
          heading: '4. How we use your data',
          body: [
            'We use personal data to:',
            {
              list: [
                'create and secure your account and keep you signed in;',
                'provide the feed, UniNotes, PocketMentor and wallet features you ask for;',
                'process payments and keep the financial records the law requires;',
                'moderate content and protect the community from fraud and abuse;',
                'send you service messages, such as booking confirmations and security alerts;',
                'improve the Platform and fix problems.',
              ],
            },
            'We do not sell your personal data and we do not use it for third-party advertising.',
          ],
        },
        {
          id: 'visibility',
          heading: '5. What other users can see',
          body: [
            'Your nickname and profile photo are always public. You decide who can see your real name, email, phone number, university, faculty and graduation year - everyone, verified students only, or only you - under Settings → Privacy.',
          ],
        },
        {
          id: 'sharing',
          heading: '6. Sharing with service providers',
          body: [
            'We share data only with providers that help us run the Platform - hosting and database services, image processing, email delivery and payment processing - and only as far as each one needs to do its job. They act on our instructions and are bound by confidentiality and data-protection obligations.',
            'We may also disclose data when required by law, or to protect the rights and safety of our users and the Platform.',
            'Some providers may process data outside Azerbaijan. When they do, we rely on appropriate safeguards to protect it.',
          ],
        },
        {
          id: 'retention',
          heading: '7. How long we keep data',
          body: [
            'We keep account data for as long as your account is active. After an account deletion is approved, we delete or anonymise your personal data, except records we must keep by law - such as financial transaction records - which are kept only for the legally required period.',
          ],
        },
        {
          id: 'cookies',
          heading: '8. Cookies',
          body: [
            'We use a small number of first-party cookies. We do not use analytics, advertising or tracking cookies.',
            {
              list: [
                'CH_AT, CH_RT and CH_RF (strictly necessary): keep you signed in securely and refresh your session.',
                'CH_LOCALE (preference): remembers the language you chose.',
                'CH_THEME (preference): remembers your light, dark or system theme.',
              ],
            },
            'Strictly necessary cookies cannot be switched off, because the Platform cannot work without them. You can delete cookies in your browser settings at any time; you will then be signed out and your preferences will reset.',
          ],
        },
        {
          id: 'security',
          heading: '9. Security',
          body: [
            'We protect your data with measures such as encrypted connections (HTTPS), hashed passwords, access controls for staff and audit logs of administrative actions. No system is completely secure, so please use a strong, unique password and tell us promptly about any suspected breach.',
          ],
        },
        {
          id: 'rights',
          heading: '10. Your rights',
          body: [
            'Subject to applicable law, you have the right to:',
            {
              list: [
                'access the personal data we hold about you;',
                'correct inaccurate or incomplete data;',
                'request deletion of your account and data (Settings → Account);',
                'withdraw consent you have given, without affecting processing that took place before;',
                'object to or ask us to restrict certain processing;',
                'lodge a complaint with the competent supervisory authority.',
              ],
            },
            'To exercise these rights, write to supportcampushub@gmail.com. We may need to confirm your identity before acting on a request.',
          ],
        },
        {
          id: 'children',
          heading: '11. Minimum age',
          body: [
            'The Platform is not intended for anyone under 16. We do not knowingly collect data from children under that age; if we learn that we have, we will delete it.',
          ],
        },
        {
          id: 'changes',
          heading: '12. Changes to this policy',
          body: [
            'We may update this policy from time to time. We will post the new version on this page with a new effective date and, for significant changes, notify you by email or through the Platform.',
          ],
        },
        {
          id: 'contact',
          heading: '13. Contact',
          body: ['Questions about this policy or your personal data can be sent to supportcampushub@gmail.com.'],
        },
      ],
    },

    az: {
      title: 'Məxfilik Siyasəti',
      summary:
        'Bu siyasət CampusHub-ın hansı şəxsi məlumatları topladığını, bunu nə üçün etdiyini, məlumatları nə qədər saxladığını, həmçinin sizin seçim imkanlarınızı və hüquqlarınızı izah edir.',
      sections: [
        {
          id: 'overview',
          heading: '1. Biz kimik',
          body: [
            'CampusHub ("Platforma", "biz") Azərbaycandakı universitet tələbələri və məzunları üçün platformadır. Platforma vasitəsilə emal olunan şəxsi məlumatlara görə biz məsuliyyət daşıyırıq və onları Azərbaycan Respublikasının "Fərdi məlumatlar haqqında" Qanununa və digər qüvvədə olan qanunvericiliyə uyğun emal edirik.',
          ],
        },
        {
          id: 'data',
          heading: '2. Topladığımız məlumatlar',
          body: [
            'Yalnız Platformanın işləməsi üçün zəruri olan məlumatları toplayırıq:',
            {
              list: [
                'Hesab məlumatları: adınız, istifadəçi adınız, e-poçt ünvanınız, telefon nömrəniz, doğum tarixiniz, universitetiniz, fakültəniz və məzun olma iliniz.',
                'Profil və məzmun: şəkliniz, haqqınızda məlumat, paylaşımlarınız, şərhləriniz, konspektləriniz, rəyləriniz və Platforma vasitəsilə göndərdiyiniz mesajlar.',
                'Əməliyyat məlumatları: balansın artırılması, alışlar, sifarişlər və ödənişlər. Kart məlumatlarınızı ödəniş provayderimiz emal edir və onlar serverlərimizə heç vaxt çatmır.',
                'Texniki məlumatlar: IP ünvanı, cihaz və brauzer növü, həmçinin hesabınızı qorumaq və fırıldaqçılığın qarşısını almaq üçün istifadə olunan təhlükəsizlik jurnalları.',
              ],
            },
          ],
        },
        {
          id: 'verification',
          heading: '3. Şəxsiyyət sənədləri',
          body: [
            'Hesabınızı təsdiqləməyi seçsəniz, şəxsiyyət və təhsil sənədlərinizin şəkillərini yükləyirsiniz. Həmin anda sizdən açıq razılıq istəyirik.',
            'Şəkillər yalnız tələbə və ya mütəxəssis statusunuzu təsdiqləmək üçün istifadə olunur. Onlar yoxlamanı - lazım gəldikdə moderatorun əl ilə baxışı da daxil olmaqla - başa çatdırmaq üçün tələb olunan qısa müddət ərzində saxlanılır, sonra isə birdəfəlik silinir. Biz yalnız yoxlamanın nəticəsini və təkrar və ya saxta hesabların qarşısını almaq üçün zəruri olan minimum qeydi saxlayırıq.',
          ],
        },
        {
          id: 'use',
          heading: '4. Məlumatlarınızdan necə istifadə edirik',
          body: [
            'Şəxsi məlumatlardan aşağıdakı məqsədlərlə istifadə edirik:',
            {
              list: [
                'hesabınızı yaratmaq, qorumaq və sizi sistemdə saxlamaq;',
                'lent, UniNotes, PocketMentor və pul kisəsi funksiyalarını təqdim etmək;',
                'ödənişləri emal etmək və qanunun tələb etdiyi maliyyə qeydlərini aparmaq;',
                'məzmunu moderasiya etmək və icmanı fırıldaqçılıqdan və sui-istifadədən qorumaq;',
                'sifariş təsdiqləri və təhlükəsizlik xəbərdarlıqları kimi xidməti mesajlar göndərmək;',
                'Platformanı təkmilləşdirmək və problemləri aradan qaldırmaq.',
              ],
            },
            'Şəxsi məlumatlarınızı satmırıq və üçüncü tərəf reklamı üçün istifadə etmirik.',
          ],
        },
        {
          id: 'visibility',
          heading: '5. Digər istifadəçilər nəyi görə bilər',
          body: [
            'İstifadəçi adınız və profil şəkliniz həmişə açıqdır. Həqiqi adınızı, e-poçtunuzu, telefon nömrənizi, universitetinizi, fakültənizi və məzun olma ilinizi kimin görə biləcəyini - hamı, yalnız təsdiqlənmiş tələbələr və ya yalnız siz - Parametrlər → Məxfilik bölməsində özünüz seçirsiniz.',
          ],
        },
        {
          id: 'sharing',
          heading: '6. Xidmət təminatçıları ilə paylaşım',
          body: [
            'Məlumatları yalnız Platformanın işləməsinə kömək edən təminatçılarla - hostinq və verilənlər bazası, şəkil emalı, e-poçt göndərişi və ödəniş emalı xidmətləri ilə - və yalnız onların öz işini görməsi üçün lazım olan həcmdə paylaşırıq. Onlar bizim göstərişlərimizlə hərəkət edir və məxfilik, eləcə də məlumatların qorunması öhdəlikləri ilə bağlıdırlar.',
            'Qanun tələb etdikdə və ya istifadəçilərimizin və Platformanın hüquqlarını və təhlükəsizliyini qorumaq üçün məlumatları açıqlaya bilərik.',
            'Bəzi təminatçılar məlumatları Azərbaycandan kənarda emal edə bilər. Belə hallarda məlumatların qorunması üçün müvafiq təminatlara əsaslanırıq.',
          ],
        },
        {
          id: 'retention',
          heading: '7. Məlumatları nə qədər saxlayırıq',
          body: [
            'Hesab məlumatlarını hesabınız aktiv olduğu müddətdə saxlayırıq. Hesabın silinməsi təsdiqləndikdən sonra şəxsi məlumatlarınızı silir və ya anonimləşdiririk; qanunla saxlanmalı olan qeydlər - məsələn, maliyyə əməliyyatları - yalnız qanunla müəyyən edilmiş müddət ərzində saxlanılır.',
          ],
        },
        {
          id: 'cookies',
          heading: '8. Kukilər',
          body: [
            'Az sayda birinci tərəf kukisindən istifadə edirik. Analitika, reklam və ya izləmə kukilərindən istifadə etmirik.',
            {
              list: [
                'CH_AT, CH_RT və CH_RF (ciddi zəruri): sizi təhlükəsiz şəkildə sistemdə saxlayır və sessiyanızı yeniləyir.',
                'CH_LOCALE (seçim): seçdiyiniz dili yadda saxlayır.',
                'CH_THEME (seçim): açıq, tünd və ya sistem mövzusunu yadda saxlayır.',
              ],
            },
            'Ciddi zəruri kukiləri söndürmək mümkün deyil, çünki Platforma onlarsız işləyə bilməz. Kukiləri istənilən vaxt brauzer parametrlərindən silə bilərsiniz; bu zaman sistemdən çıxacaqsınız və seçimləriniz sıfırlanacaq.',
          ],
        },
        {
          id: 'security',
          heading: '9. Təhlükəsizlik',
          body: [
            'Məlumatlarınızı şifrələnmiş bağlantılar (HTTPS), heşlənmiş şifrələr, əməkdaşlar üçün giriş nəzarəti və inzibati əməliyyatların audit jurnalları kimi tədbirlərlə qoruyuruq. Heç bir sistem tam təhlükəsiz deyil, ona görə də güclü və unikal şifrədən istifadə edin və hər hansı şübhəli pozuntu barədə bizə dərhal məlumat verin.',
          ],
        },
        {
          id: 'rights',
          heading: '10. Hüquqlarınız',
          body: [
            'Qüvvədə olan qanunvericiliyə uyğun olaraq aşağıdakı hüquqlara maliksiniz:',
            {
              list: [
                'haqqınızda saxladığımız şəxsi məlumatlarla tanış olmaq;',
                'yanlış və ya natamam məlumatları düzəltmək;',
                'hesabınızın və məlumatlarınızın silinməsini tələb etmək (Parametrlər → Hesab);',
                'verdiyiniz razılığı geri götürmək (bu, əvvəl aparılmış emala təsir etmir);',
                'müəyyən emala etiraz etmək və ya onun məhdudlaşdırılmasını tələb etmək;',
                'səlahiyyətli nəzarət orqanına şikayət etmək.',
              ],
            },
            'Bu hüquqlardan istifadə etmək üçün supportcampushub@gmail.com ünvanına yazın. Sorğunu icra etməzdən əvvəl şəxsiyyətinizi təsdiqləməyiniz istənilə bilər.',
          ],
        },
        {
          id: 'children',
          heading: '11. Minimum yaş',
          body: [
            'Platforma 16 yaşından kiçik şəxslər üçün nəzərdə tutulmayıb. Bu yaşdan kiçik uşaqlardan bilərəkdən məlumat toplamırıq; belə məlumat topladığımızı aşkar etsək, onu siləcəyik.',
          ],
        },
        {
          id: 'changes',
          heading: '12. Siyasətə dəyişikliklər',
          body: [
            'Bu siyasəti vaxtaşırı yeniləyə bilərik. Yeni versiyanı yeni qüvvəyəminmə tarixi ilə bu səhifədə dərc edəcək, əhəmiyyətli dəyişikliklər barədə isə sizə e-poçt və ya Platforma vasitəsilə məlumat verəcəyik.',
          ],
        },
        {
          id: 'contact',
          heading: '13. Əlaqə',
          body: ['Bu siyasət və ya şəxsi məlumatlarınızla bağlı suallarınızı supportcampushub@gmail.com ünvanına göndərə bilərsiniz.'],
        },
      ],
    },

    ru: {
      title: 'Политика конфиденциальности',
      summary:
        'Эта политика объясняет, какие персональные данные собирает CampusHub, зачем, как долго мы их храним, а также какие у вас есть возможности выбора и права.',
      sections: [
        {
          id: 'overview',
          heading: '1. Кто мы',
          body: [
            'CampusHub («Платформа», «мы») — платформа для студентов и выпускников университетов Азербайджана. Мы отвечаем за персональные данные, обрабатываемые через Платформу, и обрабатываем их в соответствии с Законом Азербайджанской Республики «О персональных данных» и иным применимым законодательством.',
          ],
        },
        {
          id: 'data',
          heading: '2. Какие данные мы собираем',
          body: [
            'Мы собираем только те данные, которые нужны для работы Платформы:',
            {
              list: [
                'Данные аккаунта: имя, никнейм, адрес электронной почты, номер телефона, дата рождения, университет, факультет и год выпуска.',
                'Профиль и контент: фото, описание, публикации, комментарии, конспекты, отзывы и сообщения, отправленные через Платформу.',
                'Данные о транзакциях: пополнения кошелька, покупки, бронирования и выплаты. Данные карт обрабатывает наш платёжный провайдер, и они никогда не попадают на наши серверы.',
                'Технические данные: IP-адрес, тип устройства и браузера, а также журналы безопасности, которые защищают аккаунт и предотвращают мошенничество.',
              ],
            },
          ],
        },
        {
          id: 'verification',
          heading: '3. Документы, удостоверяющие личность',
          body: [
            'Если вы решите подтвердить аккаунт, вы загружаете изображения документов, удостоверяющих личность и обучение. В этот момент мы запрашиваем ваше явное согласие.',
            'Изображения используются исключительно для подтверждения статуса студента или специалиста. Они хранятся лишь в течение короткого срока, необходимого для проверки, включая при необходимости ручную проверку модератором, после чего безвозвратно удаляются. Мы сохраняем только результат проверки и минимальную запись, необходимую для предотвращения дублирующих и мошеннических аккаунтов.',
          ],
        },
        {
          id: 'use',
          heading: '4. Как мы используем данные',
          body: [
            'Мы используем персональные данные, чтобы:',
            {
              list: [
                'создавать и защищать ваш аккаунт и сохранять вход в систему;',
                'предоставлять ленту, UniNotes, PocketMentor и кошелёк;',
                'обрабатывать платежи и вести финансовый учёт, требуемый законом;',
                'модерировать контент и защищать сообщество от мошенничества и злоупотреблений;',
                'отправлять служебные сообщения, например подтверждения бронирований и оповещения безопасности;',
                'улучшать Платформу и устранять неполадки.',
              ],
            },
            'Мы не продаём ваши персональные данные и не используем их для сторонней рекламы.',
          ],
        },
        {
          id: 'visibility',
          heading: '5. Что видят другие пользователи',
          body: [
            'Ваш никнейм и фото профиля всегда общедоступны. Кто может видеть ваше настоящее имя, почту, телефон, университет, факультет и год выпуска — все, только проверенные студенты или только вы, — вы решаете сами в разделе Настройки → Конфиденциальность.',
          ],
        },
        {
          id: 'sharing',
          heading: '6. Передача данных поставщикам услуг',
          body: [
            'Мы передаём данные только поставщикам, которые помогают обеспечивать работу Платформы, — услугам хостинга и баз данных, обработки изображений, доставки электронной почты и обработки платежей — и только в объёме, необходимом для выполнения их задач. Они действуют по нашим указаниям и связаны обязательствами о конфиденциальности и защите данных.',
            'Мы также можем раскрыть данные, если этого требует закон, или для защиты прав и безопасности пользователей и Платформы.',
            'Некоторые поставщики могут обрабатывать данные за пределами Азербайджана. В таких случаях мы применяем надлежащие меры защиты.',
          ],
        },
        {
          id: 'retention',
          heading: '7. Сроки хранения',
          body: [
            'Данные аккаунта хранятся, пока аккаунт активен. После одобрения запроса на удаление мы удаляем или обезличиваем ваши персональные данные, за исключением записей, которые обязаны хранить по закону, — например, о финансовых операциях, — и храним их только в течение установленного законом срока.',
          ],
        },
        {
          id: 'cookies',
          heading: '8. Файлы cookie',
          body: [
            'Мы используем небольшое количество собственных файлов cookie. Мы не используем аналитические, рекламные или отслеживающие cookie.',
            {
              list: [
                'CH_AT, CH_RT и CH_RF (строго необходимые): обеспечивают безопасный вход и обновление сессии.',
                'CH_LOCALE (настройки): запоминает выбранный язык.',
                'CH_THEME (настройки): запоминает светлую, тёмную или системную тему.',
              ],
            },
            'Строго необходимые cookie нельзя отключить, так как без них Платформа не работает. Вы можете удалить cookie в настройках браузера в любое время; после этого вы выйдете из аккаунта, а настройки будут сброшены.',
          ],
        },
        {
          id: 'security',
          heading: '9. Безопасность',
          body: [
            'Мы защищаем данные с помощью таких мер, как шифрованное соединение (HTTPS), хеширование паролей, контроль доступа для сотрудников и журналы аудита административных действий. Ни одна система не защищена полностью, поэтому используйте надёжный уникальный пароль и сразу сообщайте нам о любых подозрениях на взлом.',
          ],
        },
        {
          id: 'rights',
          heading: '10. Ваши права',
          body: [
            'В соответствии с применимым законодательством вы вправе:',
            {
              list: [
                'получить доступ к персональным данным, которые мы о вас храним;',
                'исправить неточные или неполные данные;',
                'запросить удаление аккаунта и данных (Настройки → Аккаунт);',
                'отозвать данное согласие, что не влияет на обработку, проведённую ранее;',
                'возразить против определённой обработки или потребовать её ограничения;',
                'подать жалобу в компетентный надзорный орган.',
              ],
            },
            'Чтобы воспользоваться этими правами, напишите на supportcampushub@gmail.com. Перед выполнением запроса нам может потребоваться подтвердить вашу личность.',
          ],
        },
        {
          id: 'children',
          heading: '11. Минимальный возраст',
          body: [
            'Платформа не предназначена для лиц младше 16 лет. Мы сознательно не собираем данные детей этого возраста; если нам станет известно о таком сборе, мы удалим эти данные.',
          ],
        },
        {
          id: 'changes',
          heading: '12. Изменения политики',
          body: [
            'Мы можем время от времени обновлять эту политику. Новая версия будет опубликована на этой странице с новой датой вступления в силу, а о существенных изменениях мы сообщим по электронной почте или через Платформу.',
          ],
        },
        {
          id: 'contact',
          heading: '13. Контакты',
          body: ['Вопросы об этой политике или ваших персональных данных можно направить на supportcampushub@gmail.com.'],
        },
      ],
    },
  },
};
