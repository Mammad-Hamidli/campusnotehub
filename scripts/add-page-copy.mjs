/**
 * One-shot merge of the landing / register-wizard / dashboard copy into the
 * three locale bundles.
 *
 * Written as a script rather than three hand-edits so all locales gain the
 * same key set in the same operation - the failure mode this avoids is adding
 * a key to en.json, forgetting az.json, and shipping a raw key path to the
 * DEFAULT locale, which is the one nobody QAs.
 *
 * Run once: node scripts/add-page-copy.mjs && node scripts/check-i18n.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const ADDITIONS = {
  az: {
    landing: {
      nav: { features: 'İmkanlar', how: 'Necə işləyir', about: 'Haqqımızda' },
      hero: {
        badge: 'Yalnız doğrulanmış tələbələr',
        titleLead: 'Tələbələr və gələcək peşəkarlar üçün',
        titleAccent: 'tam ekosistem',
        subtitle:
          'Konspekt al və sat, sahəsində çalışan peşəkarlarla birbaşa görüş, kampus xəbərlərini bir yerdə izlə. Hər hesab tələbə bileti və şəxsiyyət vəsiqəsi ilə doğrulanır.',
        ctaNotes: 'Konspektlərə bax',
        ctaMentor: 'Mentor tap',
        trust: 'Saxta profil yoxdur — hər hesab sənədlə yoxlanılır',
      },
      stats: {
        students: 'Aktiv tələbə',
        notes: 'Paylaşılan konspekt',
        hours: 'Mentorluq saatı',
        universities: 'Universitet',
        live: 'Canlı',
      },
      features: {
        eyebrow: 'Üç məhsul, bir hesab',
        title: 'Universitet həyatın üçün lazım olan hər şey',
        subtitle:
          'Doğrulanmış tələbə şəxsiyyəti üç məhsulun da təməlidir. Bir dəfə yoxlanırsan, hər yerdə istifadə edirsən.',
        notes: {
          title: 'UniNotes',
          body: 'Tələbədən tələbəyə konspekt bazarı. Yüklə, qazanc əldə et və ya lazım olanı tap.',
          p1: 'İlk səhifə önizləməsi avtomatik yaradılır',
          p2: 'Daxili balans ilə təhlükəsiz ödəniş',
          p3: 'Yalnız alanlar rəy yaza bilir',
        },
        mentor: {
          title: 'PocketMentor',
          body: 'Sahəsində çalışan peşəkarlarla fərdi karyera məsləhəti.',
          p1: 'IT, marketinq, hüquq, mühəndislik və daha çox',
          p2: 'Boş vaxtlardan seç, dərhal təsdiqlə',
          p3: 'Görüş bitənə qədər ödəniş saxlanılır',
        },
        feed: {
          title: 'Kampus lenti',
          body: 'İmtahan xəbərdarlıqları, təqaüd elanları, sual-cavab — universitetin üzrə filtrlə.',
          p1: 'Universitetə görə filtr',
          p2: 'Etiketlərlə mövzu axtarışı',
          p3: 'Şəkil və qeyd paylaşımı',
        },
      },
      ticker: {
        title: 'Kampusda indi',
        joined: '{name} qoşuldu',
        verified: '{name} doğrulandı',
        uploaded: '{name} yeni konspekt yüklədi',
        booked: '{name} mentor görüşü təyin etdi',
        popular: '{title} bu gün {count} dəfə alındı',
      },
      cta: {
        title: 'Bu gün başla',
        body: 'Qeydiyyat 2 dəqiqə çəkir. Sənədlər yoxlanarkən platformadan istifadə edə bilərsən.',
        button: 'Pulsuz hesab yarat',
        secondary: 'Əvvəlcə konspektlərə bax',
      },
      footer: {
        tagline: 'Azərbaycan universitetləri üçün doğrulanmış tələbə platforması.',
        product: 'Məhsul',
        company: 'Şirkət',
        legal: 'Hüquqi',
        terms: 'İstifadə şərtləri',
        privacy: 'Məxfilik siyasəti',
        security: 'Təhlükəsizlik',
        contact: 'Əlaqə',
        rights: 'Bütün hüquqlar qorunur.',
      },
    },
    register: {
      steps: { account: 'Hesab', documents: 'Sənədlər', review: 'Yoxlama' },
      stepHint: {
        account: 'Əsas məlumatlar',
        documents: 'Dörd şəkil tələb olunur',
        review: 'Göndərməzdən əvvəl yoxla',
      },
      next: 'Davam et',
      back: 'Geri',
      finish: 'Doğrulamaya göndər',
      aside: {
        title: 'Niyə sənəd tələb edirik?',
        b1: 'Saxta profillər və konspekt oğurluğunun qarşısını alır',
        b2: 'Mentorlar kiminlə danışdığını bilir',
        b3: 'Ödənişlərin təhlükəsizliyini təmin edir',
        privacy:
          'Şəkillər şifrələnmiş anbarda saxlanılır və yoxlama bitdikdən 30 gün sonra silinir.',
      },
      scanner: {
        title: 'Sənəd bütövlüyü skaneri',
        idle: 'Hazırdır',
        scanning: 'Yoxlanılır...',
        passed: 'Bütün sənədlər keçdi',
        failed: 'Problem aşkarlandı',
        checkEdit: 'Redaktə izləri',
        checkScreen: 'Ekran şəkli',
        checkQuality: 'Şəkil keyfiyyəti',
        checkMatch: 'Ad uyğunluğu',
        note: 'Bu yoxlama brauzerdə ilkin nəticə verir. Yekun qərar serverdə alınır.',
      },
      review: {
        title: 'Məlumatları yoxla',
        body: 'Göndərdikdən sonra hesabın dərhal aktivləşir, yoxlama arxa planda davam edir.',
        edit: 'Dəyiş',
        documents: 'Yüklənmiş sənədlər',
      },
      blocked: {
        title: 'Qeydiyyat tamamlanmadı',
        body: 'Təhlükəsizlik yoxlaması bu müraciəti bloklayıb.',
      },
    },
    dashboard: {
      greeting: 'Salam, {name}',
      subtitle: 'Kampusda bu gün nə baş verir',
      graduation: {
        title: 'Məzuniyyətə sayğac',
        months: '{count} ay qalıb',
        days: '{count} gün qalıb',
        body: '{month} {year} tarixində məzun olursan. Vaxtı çatanda məzun statusuna keçməyi xatırladacağıq.',
        cta: 'Profili yenilə',
      },
      trending: {
        title: 'Populyar konspektlər',
        subtitle: 'Bu həftə ən çox alınanlar',
        viewAll: 'Hamısına bax',
      },
      quickActions: 'Sürətli əməliyyatlar',
      sellNote: 'Konspekt sat',
      findMentor: 'Mentor tap',
    },
  },

  en: {
    landing: {
      nav: { features: 'Features', how: 'How it works', about: 'About' },
      hero: {
        badge: 'Verified students only',
        titleLead: 'The complete ecosystem for students and',
        titleAccent: 'future professionals',
        subtitle:
          'Buy and sell study notes, book working professionals for 1-on-1 career advice, and keep up with your campus — all in one place. Every account is verified with a student card and national ID.',
        ctaNotes: 'Explore notes',
        ctaMentor: 'Find a mentor',
        trust: 'No fake profiles — every account is document-verified',
      },
      stats: {
        students: 'Active students',
        notes: 'Notes shared',
        hours: 'Mentorship hours',
        universities: 'Universities',
        live: 'Live',
      },
      features: {
        eyebrow: 'Three products, one account',
        title: 'Everything your university years actually need',
        subtitle:
          'A verified student identity is the spine all three products run on. Get checked once, use it everywhere.',
        notes: {
          title: 'UniNotes',
          body: 'A student-to-student marketplace for study material. Upload, earn, or find what you need.',
          p1: 'First-page preview generated automatically',
          p2: 'Secure payment through your internal balance',
          p3: 'Only verified buyers can leave reviews',
        },
        mentor: {
          title: 'PocketMentor',
          body: 'One-on-one career guidance from people actually doing the job.',
          p1: 'IT, marketing, law, engineering and more',
          p2: 'Pick an open slot, confirm instantly',
          p3: 'Payment held until the session is done',
        },
        feed: {
          title: 'Campus feed',
          body: 'Exam alerts, scholarship deadlines, questions and answers — filtered to your university.',
          p1: 'Filter by university',
          p2: 'Follow topics through tags',
          p3: 'Share images and notes inline',
        },
      },
      ticker: {
        title: 'Happening on campus',
        joined: '{name} joined',
        verified: '{name} got verified',
        uploaded: '{name} uploaded a new note',
        booked: '{name} booked a mentor session',
        popular: '{title} bought {count} times today',
      },
      cta: {
        title: 'Start today',
        body: 'Signing up takes two minutes. You can use the platform while your documents are being checked.',
        button: 'Create a free account',
        secondary: 'Browse notes first',
      },
      footer: {
        tagline: 'The verified student platform for Azerbaijani universities.',
        product: 'Product',
        company: 'Company',
        legal: 'Legal',
        terms: 'Terms of Service',
        privacy: 'Privacy Policy',
        security: 'Security',
        contact: 'Contact',
        rights: 'All rights reserved.',
      },
    },
    register: {
      steps: { account: 'Account', documents: 'Documents', review: 'Review' },
      stepHint: {
        account: 'Basic details',
        documents: 'Four photos required',
        review: 'Check before sending',
      },
      next: 'Continue',
      back: 'Back',
      finish: 'Submit for verification',
      aside: {
        title: 'Why we ask for documents',
        b1: 'Keeps fake profiles and stolen notes off the platform',
        b2: 'Mentors know who they are talking to',
        b3: 'Makes payments safe for both sides',
        privacy:
          'Images are stored in an encrypted vault and destroyed 30 days after the check completes.',
      },
      scanner: {
        title: 'Document integrity scanner',
        idle: 'Ready',
        scanning: 'Scanning...',
        passed: 'All documents passed',
        failed: 'Problem detected',
        checkEdit: 'Editing traces',
        checkScreen: 'Screen recapture',
        checkQuality: 'Image quality',
        checkMatch: 'Name consistency',
        note: 'This is a first-pass check in your browser. The final decision is made server-side.',
      },
      review: {
        title: 'Check your details',
        body: 'Your account activates immediately after you submit; verification continues in the background.',
        edit: 'Edit',
        documents: 'Uploaded documents',
      },
      blocked: {
        title: 'Registration could not be completed',
        body: 'A security check has blocked this submission.',
      },
    },
    dashboard: {
      greeting: 'Hi, {name}',
      subtitle: 'Here is what is happening on campus today',
      graduation: {
        title: 'Graduation countdown',
        months: '{count} months to go',
        days: '{count} days to go',
        body: 'You graduate in {month} {year}. We will remind you to switch to alumni status when the time comes.',
        cta: 'Update profile',
      },
      trending: {
        title: 'Trending notes',
        subtitle: 'Most bought this week',
        viewAll: 'View all',
      },
      quickActions: 'Quick actions',
      sellNote: 'Sell a note',
      findMentor: 'Find a mentor',
    },
  },

  ru: {
    landing: {
      nav: { features: 'Возможности', how: 'Как это работает', about: 'О нас' },
      hero: {
        badge: 'Только проверенные студенты',
        titleLead: 'Полная экосистема для студентов и',
        titleAccent: 'будущих профессионалов',
        subtitle:
          'Покупайте и продавайте конспекты, записывайтесь на индивидуальные консультации к практикам и следите за жизнью кампуса — в одном месте. Каждый аккаунт проверен по студенческому билету и удостоверению личности.',
        ctaNotes: 'Смотреть конспекты',
        ctaMentor: 'Найти ментора',
        trust: 'Никаких фейковых профилей — каждый аккаунт проверен по документам',
      },
      stats: {
        students: 'Активных студентов',
        notes: 'Конспектов загружено',
        hours: 'Часов менторства',
        universities: 'Университетов',
        live: 'В эфире',
      },
      features: {
        eyebrow: 'Три продукта, один аккаунт',
        title: 'Всё, что действительно нужно в университете',
        subtitle:
          'Проверенная студенческая личность — основа всех трёх продуктов. Проверка одна, польза везде.',
        notes: {
          title: 'UniNotes',
          body: 'Площадка конспектов от студентов для студентов. Загружайте, зарабатывайте или находите нужное.',
          p1: 'Предпросмотр первой страницы создаётся автоматически',
          p2: 'Безопасная оплата через внутренний баланс',
          p3: 'Отзывы пишут только реальные покупатели',
        },
        mentor: {
          title: 'PocketMentor',
          body: 'Индивидуальные карьерные консультации с теми, кто работает в профессии.',
          p1: 'IT, маркетинг, право, инженерия и другое',
          p2: 'Выберите свободный слот и подтвердите сразу',
          p3: 'Оплата удерживается до конца встречи',
        },
        feed: {
          title: 'Лента кампуса',
          body: 'Оповещения об экзаменах, дедлайны стипендий, вопросы и ответы — с фильтром по вашему университету.',
          p1: 'Фильтр по университету',
          p2: 'Темы по тегам',
          p3: 'Изображения и конспекты прямо в ленте',
        },
      },
      ticker: {
        title: 'Сейчас в кампусе',
        joined: '{name} присоединился(ась)',
        verified: '{name} прошёл(ла) проверку',
        uploaded: '{name} загрузил(а) новый конспект',
        booked: '{name} записался(ась) к ментору',
        popular: '{title} купили сегодня {count} раз',
      },
      cta: {
        title: 'Начните сегодня',
        body: 'Регистрация занимает две минуты. Платформой можно пользоваться, пока документы проверяются.',
        button: 'Создать бесплатный аккаунт',
        secondary: 'Сначала посмотреть конспекты',
      },
      footer: {
        tagline: 'Проверенная студенческая платформа для университетов Азербайджана.',
        product: 'Продукт',
        company: 'Компания',
        legal: 'Правовая информация',
        terms: 'Условия использования',
        privacy: 'Политика конфиденциальности',
        security: 'Безопасность',
        contact: 'Контакты',
        rights: 'Все права защищены.',
      },
    },
    register: {
      steps: { account: 'Аккаунт', documents: 'Документы', review: 'Проверка' },
      stepHint: {
        account: 'Основные данные',
        documents: 'Нужны четыре фото',
        review: 'Проверьте перед отправкой',
      },
      next: 'Продолжить',
      back: 'Назад',
      finish: 'Отправить на проверку',
      aside: {
        title: 'Зачем нужны документы',
        b1: 'Не пускает фейковые профили и краденые конспекты',
        b2: 'Менторы знают, с кем говорят',
        b3: 'Делает платежи безопасными для обеих сторон',
        privacy:
          'Изображения хранятся в зашифрованном хранилище и удаляются через 30 дней после проверки.',
      },
      scanner: {
        title: 'Сканер целостности документов',
        idle: 'Готов',
        scanning: 'Проверка...',
        passed: 'Все документы прошли',
        failed: 'Обнаружена проблема',
        checkEdit: 'Следы редактирования',
        checkScreen: 'Съёмка с экрана',
        checkQuality: 'Качество изображения',
        checkMatch: 'Совпадение имени',
        note: 'Это предварительная проверка в браузере. Окончательное решение принимается на сервере.',
      },
      review: {
        title: 'Проверьте данные',
        body: 'Аккаунт активируется сразу после отправки, проверка продолжится в фоне.',
        edit: 'Изменить',
        documents: 'Загруженные документы',
      },
      blocked: {
        title: 'Регистрация не завершена',
        body: 'Проверка безопасности заблокировала эту заявку.',
      },
    },
    dashboard: {
      greeting: 'Привет, {name}',
      subtitle: 'Что происходит в кампусе сегодня',
      graduation: {
        title: 'Обратный отсчёт до выпуска',
        months: 'Осталось месяцев: {count}',
        days: 'Осталось дней: {count}',
        body: 'Вы выпускаетесь в {month} {year}. Мы напомним сменить статус на выпускника, когда придёт время.',
        cta: 'Обновить профиль',
      },
      trending: {
        title: 'Популярные конспекты',
        subtitle: 'Чаще всего покупали на этой неделе',
        viewAll: 'Смотреть все',
      },
      quickActions: 'Быстрые действия',
      sellNote: 'Продать конспект',
      findMentor: 'Найти ментора',
    },
  },
};

for (const [locale, additions] of Object.entries(ADDITIONS)) {
  const path = `messages/${locale}.json`;
  const current = JSON.parse(readFileSync(path, 'utf8'));
  const merged = { ...current, ...additions };
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  console.log(`merged ${Object.keys(additions).length} namespaces into ${path}`);
}
