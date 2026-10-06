/**
 * Dates as people read them in az / en / ru, WITHOUT the runtime's Intl
 * locale data. Every date shown to a person goes through formatDate().
 *
 * ---------------------------------------------------------------------------
 * WHY NOT Intl.DateTimeFormat / toLocaleDateString
 * ---------------------------------------------------------------------------
 * Chromium (Chrome, Edge, and the desktop app's WebView2) ships ICU WITHOUT
 * Azerbaijani calendar data. For `az` it falls back to the CLDR root locale,
 * whose month names are literally "M01".."M12" and whose pattern is
 * "y MMM d". So `toLocaleDateString('az', { day: 'numeric', month: 'short' })`
 * printed "M10 6" in the browser, and a join date printed "2026 M10". That
 * "M" is missing locale data, not a formatting token, so nothing justifies
 * keeping it. Node has full ICU and prints "6 okt", which also made every
 * server-rendered az date a hydration mismatch (see the az number case in
 * the mentor panel's format.ts).
 *
 * So the names and patterns live here, copied from CLDR exactly as Node's
 * full ICU 77 prints them for az-AZ, en-GB and ru-RU. Only the numbers come
 * from the clock, through an `en-US` numeric formatter (en is in every ICU
 * build) when a time zone is given. The output is identical on the server, in
 * every browser and in the desktop app.
 */

export type DateFormat =
  /** 6 okt · 6 Oct · 6 окт. */
  | 'dayMonth'
  /** 6 oktyabr · 6 October · 6 октября */
  | 'dayMonthLong'
  /** 6 okt 2026 · 6 Oct 2026 · 6 окт. 2026 г. */
  | 'date'
  /** 6 oktyabr 2026 · 6 October 2026 · 6 октября 2026 г. */
  | 'dateLong'
  /** oktyabr 2026 · October 2026 · октябрь 2026 г. */
  | 'monthYear'
  /** 6 okt 2026, 14:05 · 6 Oct 2026, 14:05 · 6 окт. 2026 г., 14:05 */
  | 'dateTime'
  /** 6 okt, 14:05 · 6 Oct, 14:05 · 6 окт., 14:05 */
  | 'dayMonthTime'
  /** 6 okt, Ç.a., 14:05 · Tue 6 Oct, 14:05 · вт, 6 окт., 14:05 */
  | 'weekdayDateTime'
  /** A column header: Ç.A. · Tue · вт */
  | 'weekday'
  /** 14:05 - every supported locale uses the 24-hour clock. */
  | 'time';

type Lang = 'az' | 'en' | 'ru';

type Fields = { year: number; month: number; day: number; weekday: number; hour: number; minute: number };

type LocaleData = {
  /** Abbreviated, in a date ("6 okt"). */
  monthsShort: readonly string[];
  /** Wide, in a date - Russian genitive ("6 октября"). */
  monthsLong: readonly string[];
  /** Wide, on its own - Russian nominative ("октябрь 2026 г."). */
  monthsAlone: readonly string[];
  /** Abbreviated, inside a date. 0 = Sunday. */
  weekdays: readonly string[];
  /** Abbreviated, as a heading. 0 = Sunday. */
  weekdaysAlone: readonly string[];
  /** The year as it follows a date ("2026 г." in Russian). */
  year: (y: number) => string;
  /** Joins a date and a time ("6 Oct 2026, 14:05"). */
  withTime: (date: string, time: string) => string;
  weekdayDateTime: (f: Fields, time: string) => string;
};

const DATA: Record<Lang, LocaleData> = {
  az: {
    monthsShort: ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avq', 'sen', 'okt', 'noy', 'dek'],
    monthsLong: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avqust', 'sentyabr', 'oktyabr', 'noyabr', 'dekabr'],
    monthsAlone: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avqust', 'sentyabr', 'oktyabr', 'noyabr', 'dekabr'],
    weekdays: ['B.', 'B.e.', 'Ç.a.', 'Ç.', 'C.a.', 'C.', 'Ş.'],
    weekdaysAlone: ['B.', 'B.E.', 'Ç.A.', 'Ç.', 'C.A.', 'C.', 'Ş.'],
    year: String,
    withTime: (date, time) => `${date}, ${time}`,
    // CLDR az: "d MMM, E" - the weekday follows the date.
    weekdayDateTime: (f, time) => `${f.day} ${DATA.az.monthsShort[f.month]}, ${DATA.az.weekdays[f.weekday]}, ${time}`,
  },
  en: {
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'],
    monthsLong: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    monthsAlone: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    weekdaysAlone: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    year: String,
    withTime: (date, time) => `${date}, ${time}`,
    weekdayDateTime: (f, time) => `${DATA.en.weekdays[f.weekday]} ${f.day} ${DATA.en.monthsShort[f.month]}, ${time}`,
  },
  ru: {
    monthsShort: ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'],
    monthsLong: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
    monthsAlone: ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'],
    weekdays: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
    weekdaysAlone: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
    year: (y) => `${y} г.`,
    withTime: (date, time) => `${date}, ${time}`,
    weekdayDateTime: (f, time) => `${DATA.ru.weekdays[f.weekday]}, ${f.day} ${DATA.ru.monthsShort[f.month]}, ${time}`,
  },
};

/** "az", "az-AZ", "ru_RU" ... -> the bundled language; anything else reads as English. */
function langOf(locale: string): Lang {
  const base = locale.slice(0, 2).toLowerCase();
  return base === 'az' || base === 'ru' ? base : 'en';
}

/** One numeric formatter per zone: building an Intl.DateTimeFormat is the expensive part. */
const zoned = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  if (!zoned.has(timeZone)) {
    try {
      zoned.set(
        timeZone,
        new Intl.DateTimeFormat('en-US', {
          timeZone,
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
          hourCycle: 'h23',
        }),
      );
    } catch {
      // An unknown zone name (a stale profile setting, say) - fall back to the device clock.
      zoned.set(timeZone, null);
    }
  }
  return zoned.get(timeZone)!;
}

/** The wall-clock fields of `date` in `timeZone`, or on the device clock when none is given. */
function fieldsOf(date: Date, timeZone?: string): Fields {
  const fmt = timeZone ? zoneFormatter(timeZone) : null;
  if (!fmt) {
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
      weekday: date.getDay(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
  const part: Record<string, number> = {};
  for (const { type, value } of fmt.formatToParts(date)) part[type] = Number(value);
  const month = part.month - 1;
  return {
    year: part.year,
    month,
    day: part.day,
    // From the calendar date itself, so no weekday name is ever parsed back.
    weekday: new Date(Date.UTC(part.year, month, part.day)).getUTCDay(),
    // Some engines print midnight as "24" even with h23.
    hour: part.hour % 24,
    minute: part.minute,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Formats an instant for a person.
 *
 * `locale` is the app locale ("az") or a BCP 47 tag ("az-AZ"). Without a
 * `timeZone` the device's clock is used, which is right in the browser. In
 * server-rendered UI pass an explicit zone ('UTC' for a calendar date), since
 * the server's zone is not the reader's. An invalid input renders as ''.
 */
export function formatDate(
  value: Date | string | number,
  locale: string,
  format: DateFormat,
  options: { timeZone?: string } = {},
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const data = DATA[langOf(locale)];
  const f = fieldsOf(date, options.timeZone);
  const time = `${pad(f.hour)}:${pad(f.minute)}`;
  const dayMonth = `${f.day} ${data.monthsShort[f.month]}`;
  const date_ = `${dayMonth} ${data.year(f.year)}`;

  switch (format) {
    case 'dayMonth':
      return dayMonth;
    case 'dayMonthLong':
      return `${f.day} ${data.monthsLong[f.month]}`;
    case 'date':
      return date_;
    case 'dateLong':
      return `${f.day} ${data.monthsLong[f.month]} ${data.year(f.year)}`;
    case 'monthYear':
      return `${data.monthsAlone[f.month]} ${data.year(f.year)}`;
    case 'dateTime':
      return data.withTime(date_, time);
    case 'dayMonthTime':
      return data.withTime(dayMonth, time);
    case 'weekdayDateTime':
      return data.weekdayDateTime(f, time);
    case 'weekday':
      return data.weekdaysAlone[f.weekday];
    case 'time':
      return time;
  }
}

/**
 * A compact age ("5 min", "3 saat", "2 д") through the locale's
 * `common.age.*` keys. These used to be hardcoded English ("5m"), whose
 * lone "m" an Azerbaijani reader could not tell from a month. Older than
 * `absoluteAfterDays`, it gives the date instead.
 */
export function formatAge(
  value: Date | string,
  locale: string,
  t: (key: string, params?: Record<string, string | number>) => string,
  { absoluteAfterDays = Infinity, now = Date.now() }: { absoluteAfterDays?: number; now?: number } = {},
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  if (seconds < 60) return t('common.age.now');
  if (seconds < 3600) return t('common.age.minutes', { count: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t('common.age.hours', { count: Math.floor(seconds / 3600) });
  const days = Math.floor(seconds / 86_400);
  return days < absoluteAfterDays ? t('common.age.days', { count: days }) : formatDate(date, locale, 'dayMonth');
}

/** A weekday heading by index (0 = Sunday), for schedules that have no date. */
export function weekdayName(weekday: number, locale: string): string {
  return DATA[langOf(locale)].weekdaysAlone[((weekday % 7) + 7) % 7];
}
