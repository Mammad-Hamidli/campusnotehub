/**
 * Merges the copy introduced by the zero-retention / hybrid-review revision
 * into all three locale bundles in one operation.
 *
 * Deep-merges rather than replacing namespaces, so existing keys survive.
 * Run once: node scripts/add-retention-copy.mjs && npm run check:i18n
 */
import { readFileSync, writeFileSync } from 'node:fs';

const ADDITIONS = {
  az: {
    auth: {
      register: {
        phone: 'Telefon nömrəsi',
        phoneHint: 'Seçimlidir, lakin hesabın bərpası və ödənişlər üçün lazım olacaq',
      },
    },
    verification: {
      banner: {
        processing: 'Sənədləriniz indi yoxlanılır. Bu bir neçə saniyə çəkir.',
        resubmitRequired: 'Yoxlama müddəti bitdi. Sənədləri yenidən yükləyin.',
        attemptsExhausted: 'Cəhd limiti bitib. Dəstək xidməti ilə əlaqə saxlayın.',
      },
      quality: {
        pdfUnsafe: 'Bu PDF-də icra oluna bilən məzmun var və qəbul edilmir.',
        pdfEncrypted: 'Şifrələnmiş PDF qəbul edilmir. Parolsuz fayl yükləyin.',
      },
    },
    register: {
      retention: {
        title: 'Sənədləriniz saxlanılmır',
        lead: 'Şəkillər yalnız yoxlama anında emal olunur və dərhal silinir. Serverlərimizdə və ya buludda qalmır.',
        deleted: 'Yoxlamadan dərhal sonra tamamilə silinir',
        flagsOnly: 'Bazada yalnız "doğrulanıb: bəli/xeyr" saxlanılır',
        humanReview: 'Şübhəli hallarda moderator baxa bilər',
        window: 'Belə hallarda şəkil ən çox 24 saat şifrələnmiş qalır',
      },
    },
    admin: {
      title: 'Moderasiya',
      queue: {
        title: 'Yoxlama növbəsi',
        empty: 'Gözləyən müraciət yoxdur',
        priority: 'Prioritet',
        submitted: 'Göndərilib',
        expiresIn: '{minutes} dəqiqə qalıb',
        confidence: 'Etibarlılıq',
      },
      review: {
        title: 'Sənəd yoxlaması',
        applicant: 'Müraciətçi',
        signals: 'Aşkarlanan siqnallar',
        devices: 'Cihazlar',
        relatedAccounts: 'Bu cihazdakı digər hesablar',
        approve: 'Təsdiqlə',
        reject: 'Rədd et',
        ban: 'Blokla',
        reason: 'Səbəb',
        reasonHint: 'Ən azı 10 simvol. Audit jurnalında saxlanılır.',
        bufferExpired: 'Şəkillərin saxlanma müddəti bitib. İstifadəçidən yenidən yükləmə tələb edin.',
        confirmBan: 'Bu hesab birdəfəlik bloklanacaq. Davam edilsin?',
        noteAutoBan: 'Sistem avtomatik bloklamır — qərarı siz verirsiniz.',
      },
    },
  },

  en: {
    auth: {
      register: {
        phone: 'Phone number',
        phoneHint: 'Optional, but needed for account recovery and payouts',
      },
    },
    verification: {
      banner: {
        processing: 'Your documents are being checked right now. This takes a few seconds.',
        resubmitRequired: 'The review window expired. Please upload your documents again.',
        attemptsExhausted: 'You have used all attempts. Please contact support.',
      },
      quality: {
        pdfUnsafe: 'This PDF contains active content and cannot be accepted.',
        pdfEncrypted: 'Password-protected PDFs are not accepted. Upload an unlocked file.',
      },
    },
    register: {
      retention: {
        title: 'Your documents are not stored',
        lead: 'The images are processed at the moment of verification and deleted immediately. They are never kept on our servers or in cloud storage.',
        deleted: 'Erased the instant the check finishes',
        flagsOnly: 'The database keeps only "verified: yes/no"',
        humanReview: 'A moderator may look if the check is inconclusive',
        window: 'In that case the image is held encrypted for at most 24 hours',
      },
    },
    admin: {
      title: 'Moderation',
      queue: {
        title: 'Verification queue',
        empty: 'Nothing waiting for review',
        priority: 'Priority',
        submitted: 'Submitted',
        expiresIn: '{minutes} minutes left',
        confidence: 'Confidence',
      },
      review: {
        title: 'Document review',
        applicant: 'Applicant',
        signals: 'Detected signals',
        devices: 'Devices',
        relatedAccounts: 'Other accounts on this device',
        approve: 'Approve',
        reject: 'Reject',
        ban: 'Ban',
        reason: 'Reason',
        reasonHint: 'At least 10 characters. Recorded in the audit log.',
        bufferExpired: 'The images have expired. Ask the applicant to submit again.',
        confirmBan: 'This permanently bans the account. Continue?',
        noteAutoBan: 'The system never bans automatically — this decision is yours.',
      },
    },
  },

  ru: {
    auth: {
      register: {
        phone: 'Номер телефона',
        phoneHint: 'Необязательно, но нужен для восстановления доступа и выплат',
      },
    },
    verification: {
      banner: {
        processing: 'Ваши документы проверяются прямо сейчас. Это занимает несколько секунд.',
        resubmitRequired: 'Срок проверки истёк. Загрузите документы заново.',
        attemptsExhausted: 'Попытки исчерпаны. Обратитесь в поддержку.',
      },
      quality: {
        pdfUnsafe: 'В этом PDF есть активное содержимое, он не принимается.',
        pdfEncrypted: 'PDF с паролем не принимаются. Загрузите файл без защиты.',
      },
    },
    register: {
      retention: {
        title: 'Ваши документы не хранятся',
        lead: 'Изображения обрабатываются в момент проверки и сразу удаляются. Они не остаются ни на наших серверах, ни в облачном хранилище.',
        deleted: 'Удаляются сразу после завершения проверки',
        flagsOnly: 'В базе остаётся только «проверен: да/нет»',
        humanReview: 'При сомнениях документ может посмотреть модератор',
        window: 'В этом случае изображение хранится зашифрованным не более 24 часов',
      },
    },
    admin: {
      title: 'Модерация',
      queue: {
        title: 'Очередь проверки',
        empty: 'Заявок на проверке нет',
        priority: 'Приоритет',
        submitted: 'Отправлено',
        expiresIn: 'Осталось минут: {minutes}',
        confidence: 'Уверенность',
      },
      review: {
        title: 'Проверка документов',
        applicant: 'Заявитель',
        signals: 'Обнаруженные сигналы',
        devices: 'Устройства',
        relatedAccounts: 'Другие аккаунты на этом устройстве',
        approve: 'Одобрить',
        reject: 'Отклонить',
        ban: 'Заблокировать',
        reason: 'Причина',
        reasonHint: 'Минимум 10 символов. Записывается в журнал аудита.',
        bufferExpired: 'Срок хранения изображений истёк. Попросите заявителя загрузить их заново.',
        confirmBan: 'Аккаунт будет заблокирован навсегда. Продолжить?',
        noteAutoBan: 'Система никогда не блокирует автоматически — решение принимаете вы.',
      },
    },
  },
};

/** Deep merge that never drops an existing key. */
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
  const current = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, `${JSON.stringify(merge(current, additions), null, 2)}\n`, 'utf8');
  console.log(`merged into ${path}`);
}
