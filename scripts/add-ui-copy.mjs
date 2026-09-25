/**
 * Copy for the UI overhaul: nickname, settings, privacy controls, theme,
 * granular validation messages, and the under-construction stubs.
 *
 * Deep-merges into all three bundles in one operation so no locale can be
 * left behind. Run once, then `npm run check:i18n`.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const ADDITIONS = {
  az: {
    common: { saveChanges: 'Dəyişiklikləri saxla', saved: 'Saxlanıldı', discard: 'Ləğv et', comingSoon: 'Tezliklə' },
    nav: { settings: 'Tənzimləmələr', help: 'Kömək', messages: 'Mesajlar', bookmarks: 'Yadda saxlanılanlar', explore: 'Kəşf et' },
    auth: {
      register: {
        nickname: 'İstifadəçi adı',
        nicknameHint: 'Platformada bu ad görünəcək. Hərf, rəqəm və alt xətt, 3-24 simvol.',
        graduationDate: 'Məzuniyyət tarixi',
        consentsLegend: 'Razılıqlar',
        showPassword: 'Şifrəni göstər',
        hidePassword: 'Şifrəni gizlət',
        termsShort: 'İstifadə şərtləri',
        consentShort: 'Sənəd emalına razılıq',
        strength: { weak: 'Zəif', fair: 'Orta', good: 'Yaxşı', strong: 'Güclü' },
      },
      errors: {
        nameTooShort: 'Ad və soyad ən azı 3 simvol olmalıdır',
        nameInvalid: 'Yalnız hərf, boşluq və defis istifadə edin',
        nicknameInvalid: 'Yalnız hərf, rəqəm və alt xətt. 3-24 simvol.',
        nicknameReserved: 'Bu istifadəçi adı istifadə edilə bilməz',
        nicknameTaken: 'Bu istifadəçi adı artıq tutulub',
        emailInvalid: 'Düzgün e-poçt ünvanı daxil edin',
        phoneInvalid: 'Düzgün Azərbaycan nömrəsi daxil edin (+994 5X XXX XX XX)',
        phoneTaken: 'Bu nömrə artıq istifadə olunur',
        consentRequired: 'Sənədlərin emalına razılıq verməlisiniz',
      },
    },
    verification: { errors: { allFourRequired: 'Dörd sənədin hamısını yükləyin' } },
    errors: {
      fieldRequired: 'Bu sahə mütləqdir',
      summaryTitle: 'Formada {count} xəta var',
    },
    settings: {
      title: 'Tənzimləmələr',
      subtitle: 'Profilinizi və məxfilik parametrlərinizi idarə edin',
      saved: 'Dəyişikliklər saxlanıldı',
      nav: { profile: 'Profil', privacy: 'Məxfilik', appearance: 'Görünüş', account: 'Hesab' },
      profile: {
        title: 'Profil',
        description: 'Bu məlumatlar platformada görünür',
        avatar: 'Profil şəkli',
        avatarHint: 'JPG və ya PNG, maksimum 2 MB',
        changeAvatar: 'Şəkli dəyiş',
        removeAvatar: 'Şəkli sil',
        headline: 'Qısa təqdimat',
        headlinePlaceholder: 'Kompüter elmləri, 3-cü kurs',
        bio: 'Haqqımda',
      },
      academic: { title: 'Akademik məlumat', description: 'Universitet və məzuniyyət tarixi' },
      privacy: {
        title: 'Məxfilik',
        description: 'Hansı məlumatınızı kimin görəcəyini seçin',
        note: 'İstifadəçi adınız və profil şəkliniz həmişə ictimaidir — platforma onlarsız işləmir.',
        realName: 'Ad və soyad',
        realNameHint: 'Şəxsiyyət vəsiqənizdəki ad',
        email: 'E-poçt',
        phone: 'Telefon nömrəsi',
        university: 'Universitet',
        faculty: 'Fakültə',
        graduationYear: 'Məzuniyyət ili',
        options: {
          PUBLIC: 'Hamı',
          PUBLIC_hint: 'Qeydiyyatsız ziyarətçilər də daxil',
          VERIFIED_ONLY: 'Doğrulanmış tələbələr',
          VERIFIED_ONLY_hint: 'Yalnız sənədi təsdiqlənmiş istifadəçilər',
          PRIVATE: 'Yalnız mən',
          PRIVATE_hint: 'Heç kim görməyəcək',
        },
      },
      theme: { label: 'Mövzu', light: 'İşıqlı', dark: 'Qaranlıq', system: 'Sistem', description: 'Sistem seçimi cihazınızın parametrlərinə uyğunlaşır' },
      language: { title: 'Dil', description: 'Platformanın dili' },
      account: {
        title: 'Hesab',
        description: 'Təhlükəsizlik və hesabın idarə edilməsi',
        changePassword: 'Şifrəni dəyiş',
        devices: 'Cihazlar',
        devicesHint: 'Hesabınıza daxil olmuş cihazlar',
        exportData: 'Məlumatlarımı yüklə',
        exportHint: 'Bütün məlumatlarınızın JSON kopyası',
        deleteAccount: 'Hesabı sil',
        deleteHint: 'Bu əməliyyat geri qaytarıla bilməz',
      },
    },
    stub: {
      title: 'Bu bölmə hazırlanır',
      body: 'Bu hissə hazırda qurulur və tezliklə əlçatan olacaq.',
      back: 'Geri qayıt',
      toFeed: 'Lentə keç',
    },
    notFound: {
      title: 'Səhifə tapılmadı',
      body: 'Axtardığınız səhifə mövcud deyil və ya köçürülüb.',
    },
  },

  en: {
    common: { saveChanges: 'Save changes', saved: 'Saved', discard: 'Discard', comingSoon: 'Coming soon' },
    nav: { settings: 'Settings', help: 'Help', messages: 'Messages', bookmarks: 'Bookmarks', explore: 'Explore' },
    auth: {
      register: {
        nickname: 'Nickname',
        nicknameHint: 'This is what people see across the platform. Letters, numbers and underscore, 3-24 characters.',
        graduationDate: 'Graduation date',
        consentsLegend: 'Consents',
        showPassword: 'Show password',
        hidePassword: 'Hide password',
        termsShort: 'Terms of Service',
        consentShort: 'Document processing consent',
        strength: { weak: 'Weak', fair: 'Fair', good: 'Good', strong: 'Strong' },
      },
      errors: {
        nameTooShort: 'Your full name needs at least 3 characters',
        nameInvalid: 'Use letters, spaces and hyphens only',
        nicknameInvalid: 'Letters, numbers and underscore only. 3-24 characters.',
        nicknameReserved: 'That nickname is not available',
        nicknameTaken: 'That nickname is already taken',
        emailInvalid: 'Enter a valid email address',
        phoneInvalid: 'Enter a valid Azerbaijani number (+994 5X XXX XX XX)',
        phoneTaken: 'That number is already in use',
        consentRequired: 'You must consent to document processing',
      },
    },
    verification: { errors: { allFourRequired: 'Upload all four documents to continue' } },
    errors: {
      fieldRequired: 'This field is required',
      summaryTitle: 'There are {count} problems with this form',
    },
    settings: {
      title: 'Settings',
      subtitle: 'Manage your profile and privacy',
      saved: 'Your changes were saved',
      nav: { profile: 'Profile', privacy: 'Privacy', appearance: 'Appearance', account: 'Account' },
      profile: {
        title: 'Profile',
        description: 'This is what other people see',
        avatar: 'Profile picture',
        avatarHint: 'JPG or PNG, up to 2 MB',
        changeAvatar: 'Change picture',
        removeAvatar: 'Remove picture',
        headline: 'Headline',
        headlinePlaceholder: 'Computer Science, 3rd year',
        bio: 'About',
      },
      academic: { title: 'Academic details', description: 'University and graduation date' },
      privacy: {
        title: 'Privacy',
        description: 'Choose who can see each piece of information',
        note: 'Your nickname and picture are always public — the platform does not work without them.',
        realName: 'Full name',
        realNameHint: 'The name on your ID document',
        email: 'Email',
        phone: 'Phone number',
        university: 'University',
        faculty: 'Faculty',
        graduationYear: 'Graduation year',
        options: {
          PUBLIC: 'Everyone',
          PUBLIC_hint: 'Including signed-out visitors',
          VERIFIED_ONLY: 'Verified students',
          VERIFIED_ONLY_hint: 'Only document-verified users',
          PRIVATE: 'Only me',
          PRIVATE_hint: 'Nobody else can see it',
        },
      },
      theme: { label: 'Theme', light: 'Light', dark: 'Dark', system: 'System', description: 'System follows your device setting' },
      language: { title: 'Language', description: 'Interface language' },
      account: {
        title: 'Account',
        description: 'Security and account management',
        changePassword: 'Change password',
        devices: 'Devices',
        devicesHint: 'Devices that have signed in to your account',
        exportData: 'Download my data',
        exportHint: 'A JSON copy of everything we hold',
        deleteAccount: 'Delete account',
        deleteHint: 'This cannot be undone',
      },
    },
    stub: {
      title: 'This section is under construction',
      body: 'We are still building this part of campusnotehub. It will be available soon.',
      back: 'Go back',
      toFeed: 'Go to the feed',
    },
    notFound: {
      title: 'Page not found',
      body: 'The page you are looking for does not exist or has moved.',
    },
  },

  ru: {
    common: { saveChanges: 'Сохранить изменения', saved: 'Сохранено', discard: 'Отменить', comingSoon: 'Скоро' },
    nav: { settings: 'Настройки', help: 'Помощь', messages: 'Сообщения', bookmarks: 'Закладки', explore: 'Обзор' },
    auth: {
      register: {
        nickname: 'Никнейм',
        nicknameHint: 'Это имя будут видеть на платформе. Буквы, цифры и подчёркивание, 3-24 символа.',
        graduationDate: 'Дата выпуска',
        consentsLegend: 'Согласия',
        showPassword: 'Показать пароль',
        hidePassword: 'Скрыть пароль',
        termsShort: 'Условия использования',
        consentShort: 'Согласие на обработку документов',
        strength: { weak: 'Слабый', fair: 'Средний', good: 'Хороший', strong: 'Надёжный' },
      },
      errors: {
        nameTooShort: 'Имя и фамилия — минимум 3 символа',
        nameInvalid: 'Только буквы, пробелы и дефисы',
        nicknameInvalid: 'Только буквы, цифры и подчёркивание. 3-24 символа.',
        nicknameReserved: 'Этот никнейм недоступен',
        nicknameTaken: 'Этот никнейм уже занят',
        emailInvalid: 'Введите корректный адрес почты',
        phoneInvalid: 'Введите корректный номер (+994 5X XXX XX XX)',
        phoneTaken: 'Этот номер уже используется',
        consentRequired: 'Нужно согласие на обработку документов',
      },
    },
    verification: { errors: { allFourRequired: 'Загрузите все четыре документа' } },
    errors: {
      fieldRequired: 'Обязательное поле',
      summaryTitle: 'В форме {count} ошибок',
    },
    settings: {
      title: 'Настройки',
      subtitle: 'Управление профилем и приватностью',
      saved: 'Изменения сохранены',
      nav: { profile: 'Профиль', privacy: 'Приватность', appearance: 'Оформление', account: 'Аккаунт' },
      profile: {
        title: 'Профиль',
        description: 'Это видят другие пользователи',
        avatar: 'Фото профиля',
        avatarHint: 'JPG или PNG, до 2 МБ',
        changeAvatar: 'Изменить фото',
        removeAvatar: 'Удалить фото',
        headline: 'Краткое описание',
        headlinePlaceholder: 'Компьютерные науки, 3 курс',
        bio: 'О себе',
      },
      academic: { title: 'Учебные данные', description: 'Университет и дата выпуска' },
      privacy: {
        title: 'Приватность',
        description: 'Выберите, кто видит каждый пункт',
        note: 'Никнейм и фото профиля всегда публичны — без них платформа не работает.',
        realName: 'Имя и фамилия',
        realNameHint: 'Имя из удостоверения личности',
        email: 'Электронная почта',
        phone: 'Номер телефона',
        university: 'Университет',
        faculty: 'Факультет',
        graduationYear: 'Год выпуска',
        options: {
          PUBLIC: 'Все',
          PUBLIC_hint: 'Включая незарегистрированных посетителей',
          VERIFIED_ONLY: 'Проверенные студенты',
          VERIFIED_ONLY_hint: 'Только пользователи с подтверждёнными документами',
          PRIVATE: 'Только я',
          PRIVATE_hint: 'Никто больше не увидит',
        },
      },
      theme: { label: 'Тема', light: 'Светлая', dark: 'Тёмная', system: 'Системная', description: 'Системная следует настройкам устройства' },
      language: { title: 'Язык', description: 'Язык интерфейса' },
      account: {
        title: 'Аккаунт',
        description: 'Безопасность и управление аккаунтом',
        changePassword: 'Сменить пароль',
        devices: 'Устройства',
        devicesHint: 'Устройства, с которых выполнялся вход',
        exportData: 'Скачать мои данные',
        exportHint: 'JSON-копия всех ваших данных',
        deleteAccount: 'Удалить аккаунт',
        deleteHint: 'Это действие необратимо',
      },
    },
    stub: {
      title: 'Раздел в разработке',
      body: 'Мы всё ещё строим эту часть campusnotehub. Она появится совсем скоро.',
      back: 'Назад',
      toFeed: 'Перейти в ленту',
    },
    notFound: {
      title: 'Страница не найдена',
      body: 'Страница, которую вы ищете, не существует или была перемещена.',
    },
  },
};

function merge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && typeof out[key] === 'object'
        ? merge(out[key], value)
        : value;
  }
  return out;
}

for (const [locale, additions] of Object.entries(ADDITIONS)) {
  const path = `messages/${locale}.json`;
  writeFileSync(
    path,
    `${JSON.stringify(merge(JSON.parse(readFileSync(path, 'utf8')), additions), null, 2)}\n`,
    'utf8',
  );
  console.log(`merged into ${path}`);
}
