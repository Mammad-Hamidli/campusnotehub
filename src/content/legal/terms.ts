import type { LocalizedLegalDocument } from './types';

/**
 * Terms of Service - PLACEHOLDER TEXT.
 *
 * Generic starting copy so /legal/terms is a real page. It has not been
 * reviewed by counsel and must be replaced before it is relied on; the page
 * says so in a visible notice (legal.draftNotice). When editing:
 *   - change all three locales together; section ids and order must match
 *     across az / en / ru, and legal.test.ts enforces it
 *   - bump `effective`
 */
export const TERMS: LocalizedLegalDocument = {
  effective: '2026-10-03',
  content: {
    en: {
      title: 'Terms of Service',
      summary:
        'These terms govern your use of CampusNoteHub: the campus feed, UniNotes and PocketMentor. Please read them carefully before creating an account.',
      sections: [
        {
          id: 'acceptance',
          heading: '1. Acceptance of these terms',
          body: [
            'By creating an account or otherwise using CampusNoteHub (the "Platform"), you agree to be bound by these Terms of Service and by our Privacy Policy. If you do not agree, do not use the Platform.',
            'If you use the Platform on behalf of an organisation, you confirm that you are authorised to accept these terms on its behalf.',
          ],
        },
        {
          id: 'eligibility',
          heading: '2. Eligibility',
          body: [
            'You must be at least 16 years old to create an account. Some features, such as booking or offering mentor sessions, are available only to users who have completed identity verification.',
            'You may hold only one personal account. Accounts are personal and may not be sold, transferred or shared.',
          ],
        },
        {
          id: 'accounts',
          heading: '3. Your account',
          body: [
            'You agree to provide accurate information when registering and to keep it up to date. You are responsible for keeping your password confidential and for all activity that takes place under your account.',
            'Tell us immediately at supportcampushub@gmail.com if you believe your account has been accessed without your permission.',
          ],
        },
        {
          id: 'verification',
          heading: '4. Identity verification',
          body: [
            'To keep the community trustworthy, we may ask you to verify that you are a student, graduate or professional by submitting identity or enrolment documents. Submitting forged, altered or another person\'s documents is prohibited and will result in the permanent suspension of your account.',
            'How we handle verification documents is described in our Privacy Policy.',
          ],
        },
        {
          id: 'conduct',
          heading: '5. Acceptable use',
          body: [
            'You agree not to use the Platform to:',
            {
              list: [
                'post content that is unlawful, harassing, hateful, discriminatory, sexually explicit or violent;',
                'impersonate another person or misrepresent your affiliation with a university or organisation;',
                'upload material that infringes copyright or other intellectual property rights;',
                'facilitate academic dishonesty, such as selling completed assignments or exam answers;',
                'send spam, run unauthorised advertising, or collect other users\' data;',
                'interfere with the security or operation of the Platform, including probing, scanning or overloading our systems.',
              ],
            },
          ],
        },
        {
          id: 'content',
          heading: '6. Your content',
          body: [
            'You keep ownership of the posts, comments, notes and other material you upload ("Your Content"). By uploading it, you grant CampusNoteHub a non-exclusive, worldwide, royalty-free licence to host, store, display and distribute Your Content solely to operate and improve the Platform.',
            'You confirm that you have the rights needed to share Your Content and that it does not violate these terms or any law. We may remove content that we reasonably believe breaches these terms.',
          ],
        },
        {
          id: 'notes',
          heading: '7. UniNotes',
          body: [
            'Users may share study notes. Every note is reviewed by a moderator before it is published. Authors are responsible for the accuracy of their notes and must own the material they share.',
            'Published notes are free to download for any signed-in user, for their own study. Downloaded notes may not be sold, republished or redistributed.',
          ],
        },
        {
          id: 'mentors',
          heading: '8. PocketMentor sessions',
          body: [
            'Mentors are independent users, not employees or agents of CampusNoteHub. We do not guarantee the outcome or quality of any session.',
            'Booking a session is free. Any rate shown on a mentor\'s profile is set by the mentor for information only: the Platform does not charge, hold or deduct it.',
          ],
        },
        {
          id: 'payments',
          heading: '9. Prices and payments',
          body: [
            'CampusNoteHub has no in-app purchases, wallet or stored balance, and does not process payments. The feed, UniNotes and booking mentor sessions are free.',
            'Prices shown on the Platform, such as a mentor\'s hourly rate in Azerbaijani manat (AZN), are for information only. Any payment users arrange directly with each other happens outside the Platform and is not handled or guaranteed by CampusNoteHub.',
          ],
        },
        {
          id: 'termination',
          heading: '10. Suspension and termination',
          body: [
            'We may restrict, suspend or close an account that breaches these terms, poses a risk to other users, or is required to be closed by law. Where appropriate, we will tell you the reason and give you an opportunity to respond.',
            'You may request deletion of your account at any time from Settings. Deletion requests are reviewed by an administrator, as described in the Privacy Policy.',
          ],
        },
        {
          id: 'liability',
          heading: '11. Disclaimers and limitation of liability',
          body: [
            'The Platform is provided "as is" and "as available". We do not warrant that it will be uninterrupted or error-free, or that content provided by other users is accurate.',
            'To the fullest extent permitted by law, CampusNoteHub is not liable for indirect, incidental or consequential damages, or for any loss of data, profits or opportunity arising from your use of the Platform.',
          ],
        },
        {
          id: 'changes',
          heading: '12. Changes to these terms',
          body: [
            'We may update these terms from time to time. When changes are significant, we will notify you by email or through the Platform before they take effect. Continuing to use the Platform after that date means you accept the updated terms.',
          ],
        },
        {
          id: 'law',
          heading: '13. Governing law',
          body: [
            'These terms are governed by the laws of the Republic of Azerbaijan. Any dispute that cannot be resolved informally will be submitted to the competent courts of Baku.',
          ],
        },
        {
          id: 'contact',
          heading: '14. Contact',
          body: ['Questions about these terms can be sent to supportcampushub@gmail.com.'],
        },
      ],
    },

    az: {
      title: 'İstifadə Şərtləri',
      summary:
        'Bu şərtlər CampusNoteHub-dan - kampus lenti, UniNotes və PocketMentor-dan istifadə qaydalarını müəyyən edir. Hesab yaratmazdan əvvəl onları diqqətlə oxuyun.',
      sections: [
        {
          id: 'acceptance',
          heading: '1. Şərtlərin qəbulu',
          body: [
            'Hesab yaratmaqla və ya CampusNoteHub-dan ("Platforma") hər hansı formada istifadə etməklə siz bu İstifadə Şərtlərini və Məxfilik Siyasətimizi qəbul etmiş olursunuz. Razı deyilsinizsə, Platformadan istifadə etməyin.',
            'Platformadan hər hansı təşkilat adından istifadə edirsinizsə, həmin təşkilat adından bu şərtləri qəbul etməyə səlahiyyətiniz olduğunu təsdiq edirsiniz.',
          ],
        },
        {
          id: 'eligibility',
          heading: '2. İstifadəçilərə qoyulan tələblər',
          body: [
            'Hesab yaratmaq üçün ən azı 16 yaşınız olmalıdır. Mentor sessiyası sifariş etmək və ya təklif etmək kimi bəzi funksiyalar yalnız şəxsiyyətini təsdiqləmiş istifadəçilər üçün əlçatandır.',
            'Hər istifadəçinin yalnız bir şəxsi hesabı ola bilər. Hesab şəxsidir; onu satmaq, başqasına ötürmək və ya paylaşmaq qadağandır.',
          ],
        },
        {
          id: 'accounts',
          heading: '3. Hesabınız',
          body: [
            'Qeydiyyat zamanı düzgün məlumat təqdim etməyi və onu aktual saxlamağı öhdənizə götürürsünüz. Şifrənizin məxfiliyinə və hesabınızda baş verən bütün fəaliyyətə görə siz məsuliyyət daşıyırsınız.',
            'Hesabınıza icazəsiz daxil olunduğundan şübhələnirsinizsə, dərhal supportcampushub@gmail.com ünvanına yazın.',
          ],
        },
        {
          id: 'verification',
          heading: '4. Şəxsiyyətin təsdiqlənməsi',
          body: [
            'İcmanın etibarlılığını qorumaq üçün tələbə, məzun və ya mütəxəssis olduğunuzu təsdiqləyən şəxsiyyət və ya təhsil sənədləri təqdim etməyiniz istənilə bilər. Saxta, dəyişdirilmiş və ya başqasına məxsus sənəd təqdim etmək qadağandır və hesabın birdəfəlik bağlanması ilə nəticələnir.',
            'Təsdiqləmə sənədləri ilə necə davrandığımız Məxfilik Siyasətində izah olunur.',
          ],
        },
        {
          id: 'conduct',
          heading: '5. Qəbul edilən istifadə qaydaları',
          body: [
            'Platformadan aşağıdakı məqsədlərlə istifadə etməməyi öhdənizə götürürsünüz:',
            {
              list: [
                'qanunsuz, təhqiramiz, nifrət və ayrı-seçkilik yayan, açıq-saçıq və ya zorakılıq xarakterli məzmun paylaşmaq;',
                'başqa şəxsi təqlid etmək və ya universitet, yaxud təşkilatla əlaqənizi yanlış təqdim etmək;',
                'müəllif hüququnu və ya digər əqli mülkiyyət hüquqlarını pozan material yükləmək;',
                'akademik vicdansızlığa şərait yaratmaq, məsələn, hazır tapşırıq və ya imtahan cavabları satmaq;',
                'spam göndərmək, icazəsiz reklam yerləşdirmək və ya digər istifadəçilərin məlumatlarını toplamaq;',
                'Platformanın təhlükəsizliyinə və ya işinə müdaxilə etmək, o cümlədən sistemlərimizi yoxlamaq, skan etmək və ya həddən artıq yükləmək.',
              ],
            },
          ],
        },
        {
          id: 'content',
          heading: '6. Sizin məzmununuz',
          body: [
            'Yüklədiyiniz paylaşımlar, şərhlər, konspektlər və digər materiallar ("Sizin Məzmununuz") sizə məxsus olaraq qalır. Onları yükləməklə CampusNoteHub-a Sizin Məzmununuzu yalnız Platformanın fəaliyyəti və təkmilləşdirilməsi məqsədilə saxlamaq, göstərmək və yaymaq üçün qeyri-müstəsna, ümumdünya, ödənişsiz lisenziya verirsiniz.',
            'Sizin Məzmununuzu paylaşmaq üçün lazımi hüquqlara malik olduğunuzu və onun bu şərtləri və ya qanunu pozmadığını təsdiq edirsiniz. Bu şərtləri pozduğunu əsaslı şəkildə hesab etdiyimiz məzmunu silə bilərik.',
          ],
        },
        {
          id: 'notes',
          heading: '7. UniNotes',
          body: [
            'İstifadəçilər konspektlərini paylaşa bilər. Hər konspekt dərc olunmazdan əvvəl moderator tərəfindən yoxlanılır. Müəlliflər konspektlərinin düzgünlüyünə görə məsuliyyət daşıyır və paylaşdıqları materialın sahibi olmalıdırlar.',
            'Dərc olunmuş konspektləri sistemə daxil olmuş istənilən istifadəçi öz təhsili üçün pulsuz yükləyə bilər. Yüklənmiş konspektləri satmaq, yenidən dərc etmək və ya yaymaq qadağandır.',
          ],
        },
        {
          id: 'mentors',
          heading: '8. PocketMentor sessiyaları',
          body: [
            'Mentorlar CampusNoteHub-ın əməkdaşı və ya nümayəndəsi deyil, müstəqil istifadəçilərdir. Hər hansı sessiyanın nəticəsinə və ya keyfiyyətinə zəmanət vermirik.',
            'Sessiya sifarişi pulsuzdur. Mentorun profilində göstərilən qiyməti mentor özü müəyyən edir və o, yalnız məlumat xarakterlidir: Platforma bu məbləği tutmur, saxlamır və balansdan çıxmır.',
          ],
        },
        {
          id: 'payments',
          heading: '9. Qiymətlər və ödənişlər',
          body: [
            'CampusNoteHub-da tətbiqdaxili alış, pul kisəsi və ya balans yoxdur və Platforma ödəniş emal etmir. Lent, UniNotes və mentor sessiyalarının sifarişi pulsuzdur.',
            'Platformada göstərilən qiymətlər, məsələn, mentorun Azərbaycan manatı (AZN) ilə saatlıq qiyməti, yalnız məlumat xarakterlidir. İstifadəçilərin bir-biri ilə birbaşa razılaşdırdığı istənilən ödəniş Platformadan kənarda baş verir; CampusNoteHub onu emal etmir və ona zəmanət vermir.',
          ],
        },
        {
          id: 'termination',
          heading: '10. Hesabın dayandırılması və bağlanması',
          body: [
            'Bu şərtləri pozan, digər istifadəçilər üçün risk yaradan və ya qanuna əsasən bağlanmalı olan hesabı məhdudlaşdıra, dayandıra və ya bağlaya bilərik. Mümkün olduqda səbəbi sizə bildirəcək və cavab vermək imkanı yaradacağıq.',
            'İstənilən vaxt Parametrlər bölməsindən hesabınızın silinməsini tələb edə bilərsiniz. Silinmə sorğuları Məxfilik Siyasətində təsvir olunduğu kimi administrator tərəfindən yoxlanılır.',
          ],
        },
        {
          id: 'liability',
          heading: '11. Məsuliyyətdən imtina və məsuliyyətin məhdudlaşdırılması',
          body: [
            'Platforma "olduğu kimi" və "mövcud olduğu qədər" təqdim olunur. Onun fasiləsiz və ya xətasız işləyəcəyinə, yaxud digər istifadəçilərin təqdim etdiyi məzmunun düzgün olduğuna zəmanət vermirik.',
            'Qanunla icazə verilən maksimum həddə CampusNoteHub Platformadan istifadə nəticəsində yaranan dolayı, təsadüfi və ya nəticə etibarilə dəyən zərərə, həmçinin məlumat, gəlir və ya imkan itkisinə görə məsuliyyət daşımır.',
          ],
        },
        {
          id: 'changes',
          heading: '12. Şərtlərə dəyişikliklər',
          body: [
            'Bu şərtləri vaxtaşırı yeniləyə bilərik. Əhəmiyyətli dəyişikliklər qüvvəyə minməzdən əvvəl sizə e-poçt və ya Platforma vasitəsilə bildiriş göndərəcəyik. Həmin tarixdən sonra Platformadan istifadəni davam etdirməyiniz yenilənmiş şərtləri qəbul etdiyiniz deməkdir.',
          ],
        },
        {
          id: 'law',
          heading: '13. Tətbiq olunan hüquq',
          body: [
            'Bu şərtlər Azərbaycan Respublikasının qanunvericiliyi ilə tənzimlənir. Qeyri-rəsmi yolla həll edilə bilməyən mübahisələr Bakı şəhərinin müvafiq məhkəmələrinə təqdim olunur.',
          ],
        },
        {
          id: 'contact',
          heading: '14. Əlaqə',
          body: ['Bu şərtlərlə bağlı suallarınızı supportcampushub@gmail.com ünvanına göndərə bilərsiniz.'],
        },
      ],
    },

    ru: {
      title: 'Условия использования',
      summary:
        'Эти условия регулируют использование CampusNoteHub: ленты кампуса, UniNotes и PocketMentor. Пожалуйста, внимательно прочитайте их перед созданием аккаунта.',
      sections: [
        {
          id: 'acceptance',
          heading: '1. Принятие условий',
          body: [
            'Создавая аккаунт или иным образом используя CampusNoteHub («Платформа»), вы соглашаетесь с настоящими Условиями использования и нашей Политикой конфиденциальности. Если вы не согласны, не используйте Платформу.',
            'Если вы используете Платформу от имени организации, вы подтверждаете, что уполномочены принять эти условия от её имени.',
          ],
        },
        {
          id: 'eligibility',
          heading: '2. Требования к пользователям',
          body: [
            'Для создания аккаунта вам должно быть не менее 16 лет. Некоторые функции, например запись к менторам и проведение менторских сессий, доступны только пользователям, прошедшим проверку личности.',
            'У каждого пользователя может быть только один личный аккаунт. Аккаунт является личным: его нельзя продавать, передавать или использовать совместно.',
          ],
        },
        {
          id: 'accounts',
          heading: '3. Ваш аккаунт',
          body: [
            'Вы обязуетесь указывать достоверные данные при регистрации и поддерживать их в актуальном состоянии. Вы несёте ответственность за сохранность пароля и за все действия, совершённые в вашем аккаунте.',
            'Если вы подозреваете несанкционированный доступ к аккаунту, немедленно напишите на supportcampushub@gmail.com.',
          ],
        },
        {
          id: 'verification',
          heading: '4. Проверка личности',
          body: [
            'Чтобы сообщество оставалось надёжным, мы можем попросить вас подтвердить статус студента, выпускника или специалиста, предоставив документы, удостоверяющие личность или обучение. Предоставление поддельных, изменённых или чужих документов запрещено и влечёт бессрочную блокировку аккаунта.',
            'Порядок обработки документов описан в нашей Политике конфиденциальности.',
          ],
        },
        {
          id: 'conduct',
          heading: '5. Допустимое использование',
          body: [
            'Вы обязуетесь не использовать Платформу, чтобы:',
            {
              list: [
                'публиковать незаконные, оскорбительные, разжигающие ненависть, дискриминационные, откровенные или жестокие материалы;',
                'выдавать себя за другое лицо или искажать свою связь с университетом или организацией;',
                'загружать материалы, нарушающие авторские или иные права интеллектуальной собственности;',
                'способствовать академической нечестности, например продавать готовые задания или ответы на экзамены;',
                'рассылать спам, размещать несанкционированную рекламу или собирать данные других пользователей;',
                'вмешиваться в безопасность или работу Платформы, в том числе зондировать, сканировать или перегружать наши системы.',
              ],
            },
          ],
        },
        {
          id: 'content',
          heading: '6. Ваш контент',
          body: [
            'Публикации, комментарии, конспекты и другие загруженные вами материалы («Ваш контент») остаются вашей собственностью. Загружая их, вы предоставляете CampusNoteHub неисключительную, всемирную, безвозмездную лицензию на хранение, отображение и распространение Вашего контента исключительно для работы и улучшения Платформы.',
            'Вы подтверждаете, что обладаете необходимыми правами на Ваш контент и что он не нарушает эти условия или закон. Мы можем удалить контент, который, по нашему обоснованному мнению, нарушает эти условия.',
          ],
        },
        {
          id: 'notes',
          heading: '7. UniNotes',
          body: [
            'Пользователи могут делиться конспектами. Каждый конспект проверяется модератором перед публикацией. Авторы отвечают за точность своих конспектов и должны быть правообладателями материалов, которыми делятся.',
            'Опубликованные конспекты любой вошедший в аккаунт пользователь может бесплатно скачать для собственной учёбы. Продавать, повторно публиковать или распространять скачанные конспекты запрещено.',
          ],
        },
        {
          id: 'mentors',
          heading: '8. Сессии PocketMentor',
          body: [
            'Менторы — независимые пользователи, а не сотрудники или представители CampusNoteHub. Мы не гарантируем результат или качество сессий.',
            'Запись на сессию бесплатна. Ставку в профиле ментора устанавливает сам ментор, и она указана только для информации: Платформа не взимает, не удерживает и не списывает эту сумму.',
          ],
        },
        {
          id: 'payments',
          heading: '9. Цены и платежи',
          body: [
            'В CampusNoteHub нет встроенных покупок, кошелька или баланса, и Платформа не обрабатывает платежи. Лента, UniNotes и запись к менторам бесплатны.',
            'Цены на Платформе, например ставка ментора в час в азербайджанских манатах (AZN), указаны только для информации. Любые платежи, о которых пользователи договариваются напрямую, происходят вне Платформы; CampusNoteHub их не обрабатывает и не гарантирует.',
          ],
        },
        {
          id: 'termination',
          heading: '10. Приостановка и закрытие аккаунта',
          body: [
            'Мы можем ограничить, приостановить или закрыть аккаунт, который нарушает эти условия, создаёт риск для других пользователей или подлежит закрытию по закону. По возможности мы сообщим причину и дадим возможность ответить.',
            'Вы можете в любой момент запросить удаление аккаунта в Настройках. Запросы на удаление рассматриваются администратором, как описано в Политике конфиденциальности.',
          ],
        },
        {
          id: 'liability',
          heading: '11. Отказ от гарантий и ограничение ответственности',
          body: [
            'Платформа предоставляется «как есть» и «по мере доступности». Мы не гарантируем её бесперебойную или безошибочную работу, а также точность контента других пользователей.',
            'В максимальной степени, допустимой законом, CampusNoteHub не несёт ответственности за косвенный, случайный или последующий ущерб, а также за потерю данных, прибыли или возможностей в связи с использованием Платформы.',
          ],
        },
        {
          id: 'changes',
          heading: '12. Изменение условий',
          body: [
            'Мы можем время от времени обновлять эти условия. О существенных изменениях мы сообщим по электронной почте или через Платформу до вступления их в силу. Продолжая пользоваться Платформой после этой даты, вы принимаете обновлённые условия.',
          ],
        },
        {
          id: 'law',
          heading: '13. Применимое право',
          body: [
            'Эти условия регулируются законодательством Азербайджанской Республики. Споры, которые не удалось урегулировать в досудебном порядке, передаются в компетентные суды города Баку.',
          ],
        },
        {
          id: 'contact',
          heading: '14. Контакты',
          body: ['Вопросы об этих условиях можно направить на supportcampushub@gmail.com.'],
        },
      ],
    },
  },
};
