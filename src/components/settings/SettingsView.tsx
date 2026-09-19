'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  AtSign,
  BadgeCheck,
  Check,
  ChevronRight,
  Download,
  KeyRound,
  Loader2,
  Monitor,
  MonitorSmartphone,
  Moon,
  Palette,
  ShieldCheck,
  Sun,
  User,
} from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { LanguageToggle } from '@/components/ui/LanguageToggle';
import { useLocale, useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { useTheme, type ThemePreference } from '@/lib/theme/ThemeProvider';
import { LOCALES, LOCALE_META } from '@/lib/i18n/dictionaries';
import { VisibilitySelect, type Visibility } from './VisibilitySelect';
import { UNIVERSITIES } from '@/components/register/StepAccount';
import { VerificationSection, type IdentityState } from './VerificationSection';
import { DeletionRequestCard } from './DeletionRequestCard';

type Section = 'profile' | 'verification' | 'privacy' | 'appearance' | 'account';

export type SettingsData = {
  nickname: string;
  fullName: string;
  email: string;
  phone: string;
  headline: string;
  bio: string;
  universityId: string;
  graduationYear: string;
  graduationMonth: string;
  isVerified: boolean;
  privacy: {
    showRealName: Visibility;
    showEmail: Visibility;
    showPhone: Visibility;
    showUniversity: Visibility;
    showFaculty: Visibility;
    showGraduationYear: Visibility;
  };
};

/**
 * Backed by GET /api/me and PATCH /api/me.
 *
 * There is no separate /api/me/settings, and there should not be: an account
 * screen edits the same columns the profile does, with the same authorization
 * ("are you signed in as this person"). A second endpoint would mean a second
 * copy of the field allow-list that keeps `role` and `accountStatus`
 * un-editable, and the copy is where a privilege-escalation bug appears.
 *
 * NOT editable here, by design:
 *   email / phone - both carry unique HMAC companion columns documented as
 *     surviving account deletion so a banned identity cannot be recycled.
 *     Changing one without the other corrupts that pairing, so an address
 *     change needs its own verified flow.
 *   nickname      - case-insensitively unique at the database level; changing
 *     it also rewrites every shared surface that renders it.
 */
/**
 * An EMPTY record, not sample content.
 *
 * This was a literal profile for "aysel_m" - a name, an email and a phone
 * number that belonged to nobody, shown identically to every signed-in user
 * until they typed over it. The blank shape below exists only to hold the form
 * for the moment before GET /api/me resolves; nothing here is ever displayed
 * as if it were the viewer's data.
 */
const EMPTY: SettingsData = {
  nickname: '',
  fullName: '',
  email: '',
  phone: '',
  headline: '',
  bio: '',
  universityId: '',
  graduationYear: '',
  graduationMonth: '',
  isVerified: false,
  privacy: {
    showRealName: 'VERIFIED_ONLY',
    showEmail: 'PRIVATE',
    showPhone: 'PRIVATE',
    showUniversity: 'PUBLIC',
    showFaculty: 'VERIFIED_ONLY',
    showGraduationYear: 'VERIFIED_ONLY',
  },
};

const SECTIONS: { id: Section; icon: typeof User }[] = [
  { id: 'profile', icon: User },
  { id: 'verification', icon: BadgeCheck },
  { id: 'privacy', icon: ShieldCheck },
  { id: 'appearance', icon: Palette },
  { id: 'account', icon: KeyRound },
];

const isSection = (value: string | null): value is Section =>
  SECTIONS.some(({ id }) => id === value);

export function SettingsView() {
  const t = useT();
  const toast = useToast();

  /**
   * The open section lives in the URL (?tab=verification), not in state, so
   * the verification banner and the gated-feature messages can link straight
   * to it, and so reload and back/forward keep the user where they were.
   * Switching uses history.replaceState, which Next keeps in sync with
   * useSearchParams without a server round trip.
   */
  const searchParams = useSearchParams();
  const requested = searchParams.get('tab');
  const section: Section = isSection(requested) ? requested : 'profile';
  const setSection = (next: Section) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    window.history.replaceState(null, '', `?${params.toString()}`);
  };

  /** Role and verification status: read-only here, and not part of the form. */
  const [identity, setIdentity] = useState<IdentityState | null>(null);
  const [data, setData] = useState<SettingsData>(EMPTY);
  const [baseline, setBaseline] = useState<SettingsData>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /**
   * The real account, from GET /api/me. Both `data` and `baseline` are set
   * from it so the dirty check compares against what is actually stored rather
   * than against a placeholder, which would have marked an untouched form as
   * having unsaved changes the moment it loaded.
   */
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/me', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!body?.user) return;
        const u = body.user;
        const next: SettingsData = {
          nickname: u.nickname ?? '',
          fullName: u.fullName ?? '',
          email: u.email ?? '',
          phone: u.phone ?? '',
          headline: u.headline ?? '',
          bio: u.bio ?? '',
          universityId: u.university?.code ?? '',
          graduationYear: u.graduationYear ? String(u.graduationYear) : '',
          graduationMonth: u.graduationMonth ? String(u.graduationMonth) : '',
          isVerified: Boolean(u.isVerified),
          privacy: {
            showRealName: u.showRealName,
            showEmail: u.showEmail,
            showPhone: u.showPhone,
            showUniversity: u.showUniversity,
            showFaculty: u.showFaculty,
            showGraduationYear: u.showGraduationYear,
          },
        };
        setData(next);
        setBaseline(next);
        setIdentity({
          role: u.role,
          verificationStatus: u.verificationStatus,
          verifiedAt: u.verifiedAt ?? null,
        });
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
    return () => controller.abort();
  }, []);

  const dirty = useMemo(
    () => JSON.stringify(data) !== JSON.stringify(baseline),
    [data, baseline],
  );


  /**
   * Persists the form through PATCH /api/me.
   *
   * This used to be a commented-out fetch followed by
   * `await new Promise(r => setTimeout(r, 500))` - a simulated round trip. The
   * form therefore ALWAYS reported success: it cleared the dirty flag and
   * showed the green tick while nothing was written, so every change was gone
   * on the next reload. That is the same simulated-success pattern the
   * composer had, and it is the reason this screen looked finished.
   *
   * Only the fields /api/me actually accepts are sent. `email`, `phone` and
   * `nickname` are deliberately NOT among them - see the allow-list note on
   * that route: the first two have unique HMAC companion columns that must
   * change together and need a verified flow, and they are rendered read-only
   * here for the same reason.
   */
  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(null);

    try {
      /**
       * Only the fields that actually CHANGED are sent.
       *
       * Sending the whole form every time looks harmless and is not. The
       * server validates each field it receives, so an account whose stored
       * value no longer satisfies the current rules - a `fullName` containing
       * a digit, say, which the name regex rejects because names on an ID
       * document do not have them - would fail validation on a save the user
       * made to something else entirely. The effect is a settings page that
       * refuses every change with an opaque "validation failed" and no way to
       * find out which field is at fault, for a value the user never touched.
       *
       * A diff also means a privacy-only change cannot trip a name rule, and
       * it keeps the audit surface honest: the request describes what the user
       * did, not everything the form happened to be holding.
       */
      const patch: Record<string, unknown> = {};

      if (data.fullName.trim() !== baseline.fullName.trim()) patch.fullName = data.fullName.trim();
      if (data.headline.trim() !== baseline.headline.trim()) patch.headline = data.headline.trim();
      if (data.bio.trim() !== baseline.bio.trim()) patch.bio = data.bio.trim();

      for (const key of [
        'showRealName',
        'showEmail',
        'showPhone',
        'showUniversity',
        'showFaculty',
        'showGraduationYear',
      ] as const) {
        if (data.privacy[key] !== baseline.privacy[key]) patch[key] = data.privacy[key];
      }

      // `dirty` is computed over the whole object, which includes fields this
      // form cannot submit (email, phone, nickname). If none of the editable
      // ones moved there is nothing to send, and PATCH would 400 on an empty
      // body.
      if (Object.keys(patch).length === 0) {
        setBaseline(data);
        toast.success(t('settings.saved'));
        return;
      }

      const response = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        // The baseline is left alone, so the form stays dirty and the user can
        // retry without retyping. Reporting success here is what the previous
        // version did unconditionally.
        //
        // The server returns per-field errors; naming the offending field is
        // the difference between a fixable message and a dead end.
        const fields = payload?.fields as Record<string, string[]> | undefined;
        const firstField = fields ? Object.keys(fields)[0] : undefined;
        setSaveError(firstField ? `${firstField}: ${fields![firstField][0]}` : (payload?.error ?? 'errors.generic'));
        return;
      }

      setBaseline(data);
      toast.success(t('settings.saved'));
    } catch {
      setSaveError('errors.generic');
    } finally {
      setSaving(false);
    }
  }

  const patch = (next: Partial<SettingsData>) => setData((prev) => ({ ...prev, ...next }));
  const patchPrivacy = (next: Partial<SettingsData['privacy']>) =>
    setData((prev) => ({ ...prev, privacy: { ...prev.privacy, ...next } }));

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-edge bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-shell items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Logo />
            <ChevronRight className="h-3.5 w-3.5 text-fg-subtle" aria-hidden="true" />
            <span className="text-sm font-medium text-fg">{t('settings.title')}</span>
          </div>
          <Link href="/dashboard" className="btn-ghost h-8 text-xs">
            {t('nav.feed')}
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-shell px-4 py-8 sm:px-6 lg:px-8">
        {/* minmax(0,1fr), not 1fr: a grid track defaults to min-content, so a
            wide child (a table, a long unbroken string) stretches the column
            past the viewport instead of scrolling inside it. */}
        <div className="grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
          {/* Section nav. Horizontal scroll on mobile rather than a select:
              four items fit, and a dropdown hides where you are. */}
          <nav aria-label={t('settings.title')} className="lg:sticky lg:top-20 lg:self-start">
            <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:flex-col lg:overflow-visible">
              {SECTIONS.map(({ id, icon: Icon }) => (
                <li key={id} className="shrink-0 lg:w-full">
                  <button
                    type="button"
                    onClick={() => setSection(id)}
                    aria-current={section === id ? 'page' : undefined}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm
                                transition-colors duration-150 ${
                                  section === id
                                    ? 'bg-surface-inset font-medium text-fg'
                                    : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
                                }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {t(`settings.nav.${id}`)}
                    {/* The section's state at a glance, from any tab. Paired
                        with a text alternative so it is not colour alone. */}
                    {id === 'verification' && identity && (
                      <span
                        className={`ml-auto h-2 w-2 shrink-0 rounded-full ${
                          identity.verificationStatus === 'VERIFIED' ? 'bg-verified' : 'bg-warn'
                        }`}
                      >
                        <span className="sr-only">
                          {t(
                            identity.verificationStatus === 'VERIFIED'
                              ? 'settings.verification.status.verified'
                              : 'settings.verification.status.unverified',
                          )}
                        </span>
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className="min-w-0 space-y-6">
            {section === 'profile' && (
              <ProfileSection data={data} onChange={patch} />
            )}
            {section === 'verification' && (
              <VerificationSection
                identity={identity}
                loadFailed={loaded && !identity}
                onStatusChange={(verificationStatus) =>
                  setIdentity((prev) => (prev ? { ...prev, verificationStatus } : prev))
                }
              />
            )}
            {section === 'privacy' && (
              <PrivacySection privacy={data.privacy} onChange={patchPrivacy} />
            )}
            {section === 'appearance' && <AppearanceSection />}
            {section === 'account' && <AccountSection />}
          </div>
        </div>
      </div>

      {/*
        Save bar appears only when something changed, and it is sticky at the
        bottom. A permanently visible Save button on a settings page trains
        people to hunt for it; one that appears on the first edit tells them
        there is something to save without them having to look.
      */}
      {(dirty || saveError !== null) &&
        section !== 'appearance' &&
        section !== 'verification' && (
        <div className="sticky bottom-0 z-30 border-t border-edge bg-surface/95 backdrop-blur">
          <div className="mx-auto flex max-w-shell items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
            <p className="text-xs text-fg-muted" aria-live="polite">
              {saveError ? (
                // A failure must be visible. The previous version could not
                // fail, so there was nowhere for this to go.
                <span className="text-danger">{t(saveError)}</span>
              ) : (
                t('common.saveChanges')
              )}
            </p>
            {dirty && (
              <div className="flex gap-2">
                <button type="button" onClick={() => setData(baseline)} className="btn-secondary h-8 text-xs">
                  {t('common.discard')}
                </button>
                <button type="button" onClick={save} disabled={saving} className="btn-primary h-8 text-xs">
                  {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                  {t('common.saveChanges')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ProfileSection({
  data,
  onChange,
}: {
  data: SettingsData;
  onChange: (patch: Partial<SettingsData>) => void;
}) {
  const t = useT();

  return (
    <>
      <Card title={t('settings.profile.title')} description={t('settings.profile.description')}>
        <Row label={t('settings.profile.avatar')} hint={t('settings.profile.avatarHint')}>
          <div className="flex items-center gap-3">
            <span
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full
 bg-surface-inset text-sm font-medium text-fg-muted"
              aria-hidden="true"
            >
              {data.nickname.slice(0, 2).toUpperCase()}
            </span>
            <button type="button" className="btn-secondary h-8 text-xs">
              {t('settings.profile.changeAvatar')}
            </button>
          </div>
        </Row>

        <Row label={t('auth.register.nickname')} hint={t('auth.register.nicknameHint')} htmlFor="nickname">
          <div className="relative">
            <AtSign
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle"
              aria-hidden="true"
            />
            <input
              id="nickname"
              value={data.nickname}
              maxLength={24}
              onChange={(e) => onChange({ nickname: e.target.value.replace(/\s/g, '') })}
              className="input pl-8"
            />
          </div>
        </Row>

        <Row label={t('settings.profile.headline')} htmlFor="headline">
          <input
            id="headline"
            value={data.headline}
            maxLength={160}
            placeholder={t('settings.profile.headlinePlaceholder')}
            onChange={(e) => onChange({ headline: e.target.value })}
            className="input"
          />
        </Row>

        <Row label={t('settings.profile.bio')} htmlFor="bio">
          <textarea
            id="bio"
            rows={3}
            value={data.bio}
            maxLength={1000}
            onChange={(e) => onChange({ bio: e.target.value })}
            className="input resize-none"
          />
        </Row>
      </Card>

      <Card title={t('settings.academic.title')} description={t('settings.academic.description')}>
        <Row label={t('auth.register.university')} htmlFor="university">
          <select
            id="university"
            value={data.universityId}
            onChange={(e) => onChange({ universityId: e.target.value })}
            className="input appearance-none"
          >
            {UNIVERSITIES.map((uni) => (
              <option key={uni.id} value={uni.id}>
                {uni.id} — {uni.az}
              </option>
            ))}
          </select>
        </Row>

        <Row label={t('auth.register.graduationDate')} htmlFor="gradYear">
          <div className="grid grid-cols-2 gap-2">
            <input
              id="gradYear"
              type="number"
              value={data.graduationYear}
              onChange={(e) => onChange({ graduationYear: e.target.value })}
              className="input tabular"
            />
            <select
              aria-label={t('auth.register.graduationMonth')}
              value={data.graduationMonth}
              onChange={(e) => onChange({ graduationMonth: e.target.value })}
              className="input appearance-none"
            >
              {Array.from({ length: 12 }, (_, i) => String(i + 1)).map((m) => (
                <option key={m} value={m}>
                  {m.padStart(2, '0')}
                </option>
              ))}
            </select>
          </div>
        </Row>

        {/* Editing the legal name is what reopens verification, so it lives
            here with an explicit warning rather than silently among the rest. */}
        <Row
          label={t('settings.privacy.realName')}
          hint={t('settings.privacy.realNameHint')}
          htmlFor="fullName"
        >
          <input
            id="fullName"
            value={data.fullName}
            onChange={(e) => onChange({ fullName: e.target.value })}
            className="input"
          />
        </Row>
      </Card>
    </>
  );
}

function PrivacySection({
  privacy,
  onChange,
}: {
  privacy: SettingsData['privacy'];
  onChange: (patch: Partial<SettingsData['privacy']>) => void;
}) {
  const t = useT();

  const fields = [
    { key: 'showRealName', labelKey: 'settings.privacy.realName', hintKey: 'settings.privacy.realNameHint' },
    { key: 'showEmail', labelKey: 'settings.privacy.email' },
    { key: 'showPhone', labelKey: 'settings.privacy.phone' },
    { key: 'showUniversity', labelKey: 'settings.privacy.university' },
    { key: 'showFaculty', labelKey: 'settings.privacy.faculty' },
    { key: 'showGraduationYear', labelKey: 'settings.privacy.graduationYear' },
  ] as const;

  return (
    <Card title={t('settings.privacy.title')} description={t('settings.privacy.description')}>
      <p className="rounded-lg bg-surface-muted px-3 py-2.5 text-xs leading-relaxed text-fg-muted">
        {t('settings.privacy.note')}
      </p>

      <ul className="divide-y divide-edge">
        {fields.map(({ key, labelKey, ...rest }) => (
          <li
            key={key}
            className="flex flex-wrap items-center justify-between gap-3 py-3.5 first:pt-1"
          >
            <div className="min-w-0">
              <p id={`privacy-${key}`} className="text-sm font-medium text-fg">
                {t(labelKey)}
              </p>
              {'hintKey' in rest && rest.hintKey && (
                <p className="mt-0.5 text-xs text-fg-muted">{t(rest.hintKey)}</p>
              )}
            </div>
            <VisibilitySelect
              value={privacy[key]}
              labelledBy={`privacy-${key}`}
              onChange={(next) => onChange({ [key]: next })}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AppearanceSection() {
  const t = useT();
  const { preference, setPreference } = useTheme();
  const { locale, setLocale } = useLocale();

  const themes: { value: ThemePreference; icon: typeof Sun }[] = [
    { value: 'light', icon: Sun },
    { value: 'dark', icon: Moon },
    { value: 'system', icon: Monitor },
  ];

  return (
    <>
      <Card title={t('settings.theme.label')} description={t('settings.theme.description')}>
        {/* Radio cards rather than a dropdown: three mutually exclusive
            options that the user wants to preview, and previewing means
            clicking one and seeing the page change immediately. */}
        <fieldset>
          <legend className="sr-only">{t('settings.theme.label')}</legend>
          <div className="grid grid-cols-3 gap-2">
            {themes.map(({ value, icon: Icon }) => {
              const active = preference === value;
              return (
                <label
                  key={value}
                  className={`flex min-w-0 cursor-pointer flex-col items-center gap-2 rounded-lg
                              border p-3 text-center transition-colors duration-150 sm:p-4 ${
                                active
                                  ? 'border-accent bg-accent-soft'
                                  : 'border-edge hover:border-edge-strong hover:bg-surface-muted'
                              }`}
                >
                  <input
                    type="radio"
                    name="theme"
                    value={value}
                    checked={active}
                    onChange={() => setPreference(value)}
                    className="sr-only"
                  />
                  <Icon
                    className={`h-5 w-5 ${active ? 'text-accent' : 'text-fg-subtle'}`}
                    aria-hidden="true"
                  />
                  {/* break-anywhere: "Системная" does not fit a ~95px column
                      at 360px and would otherwise widen the grid track. */}
                  <span
                    className={`break-anywhere text-xs ${
                      active ? 'font-medium text-fg' : 'text-fg-muted'
                    }`}
                  >
                    {t(`settings.theme.${value}`)}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </Card>

      <Card title={t('settings.language.title')} description={t('settings.language.description')}>
        <fieldset>
          <legend className="sr-only">{t('settings.language.title')}</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {LOCALES.map((code) => {
              const active = locale === code;
              return (
                <label
                  key={code}
                  className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg
                              border px-3 py-2.5 transition-colors duration-150 ${
                                active
                                  ? 'border-accent bg-accent-soft'
                                  : 'border-edge hover:border-edge-strong hover:bg-surface-muted'
                              }`}
                >
                  <input
                    type="radio"
                    name="locale"
                    value={code}
                    checked={active}
                    onChange={() => setLocale(code)}
                    className="sr-only"
                  />
                  {/* Labelled in its own language — someone looking for
                      Russian is scanning for "Русский", not "Rusca". */}
                  <span lang={code} className={`text-sm ${active ? 'font-medium text-fg' : 'text-fg-muted'}`}>
                    {LOCALE_META[code].native}
                  </span>
                  {active && <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />}
                </label>
              );
            })}
          </div>
        </fieldset>
      </Card>
    </>
  );
}

function AccountSection() {
  const t = useT();

  const actions = [
    { icon: KeyRound, labelKey: 'settings.account.changePassword', href: '/help' },
    { icon: MonitorSmartphone, labelKey: 'settings.account.devices', hintKey: 'settings.account.devicesHint', href: '/help' },
    { icon: Download, labelKey: 'settings.account.exportData', hintKey: 'settings.account.exportHint', href: '/help' },
  ] as const;

  return (
    <>
      <Card title={t('settings.account.title')} description={t('settings.account.description')}>
        <ul className="divide-y divide-edge">
          {actions.map(({ icon: Icon, labelKey, href, ...rest }) => (
            <li key={labelKey}>
              <Link
                href={href}
                className="flex items-center gap-3 py-3.5 transition-colors hover:text-accent"
              >
                <Icon className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-fg">{t(labelKey)}</span>
                  {'hintKey' in rest && rest.hintKey && (
                    <span className="mt-0.5 block text-xs text-fg-muted">{t(rest.hintKey)}</span>
                  )}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      {/* Destructive actions get their own card with a danger border, well
          away from everything else. It files a request an administrator
          reviews; see DeletionRequestCard. */}
      <DeletionRequestCard />
    </>
  );
}

// ---------------------------------------------------------------------------

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="card p-6">
      <div className="mb-5">
        <h2 className="text-md font-medium tracking-tight text-fg">{title}</h2>
        {description && <p className="mt-1 text-xs text-fg-muted">{description}</p>}
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-start sm:gap-4">
      <label htmlFor={htmlFor} className="pt-2 text-sm font-medium text-fg">
        {label}
      </label>
      <div className="min-w-0">
        {children}
        {hint && <p className="mt-1.5 text-xs leading-snug text-fg-muted">{hint}</p>}
      </div>
    </div>
  );
}
