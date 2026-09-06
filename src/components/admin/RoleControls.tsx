'use client';

import { AlertTriangle } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

/**
 * The two extra inputs the admin dialogs need, shared by the users table, the
 * user detail modal and the verification console.
 *
 * They live here rather than inside one of those three because all three ask
 * the same questions - "which role?" and "for how long?" - and three copies of
 * a role list is how one of them ends up missing TEACHER after the enum grows.
 * The privileged-role warning in particular must read identically wherever it
 * appears; it is the last thing an operator sees before granting power over
 * other people's accounts.
 */

/**
 * Kept in step with ASSIGNABLE_ROLES in src/server/validators/admin.ts.
 *
 * Duplicated as a literal rather than imported: that module pulls in zod and
 * the Prisma enum, and importing it into a client component would drag the
 * server validator bundle into the browser. The server is the authority - it
 * re-validates every value against its own enum - so the cost of drift here is
 * a rejected request, not an unauthorised one.
 */
export const ASSIGNABLE_ROLE_VALUES = [
  'STUDENT',
  'ALUMNI',
  'MENTOR',
  'TEACHER',
  'MODERATOR',
  'ADMIN',
] as const;

export type AssignableRole = (typeof ASSIGNABLE_ROLE_VALUES)[number];

/** Roles that grant authority over other accounts. Mirrors PRIVILEGED_ROLES. */
export function isPrivilegedRole(role: string): boolean {
  return role === 'MODERATOR' || role === 'ADMIN';
}

export function RoleSelect({
  value,
  onChange,
  confirmed,
  onConfirmedChange,
  label,
}: {
  value: AssignableRole;
  onChange: (role: AssignableRole) => void;
  /** The acknowledgement checkbox state for a privileged grant. */
  confirmed: boolean;
  onConfirmedChange: (next: boolean) => void;
  label?: string;
}) {
  const t = useT();
  const privileged = isPrivilegedRole(value);

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-2xs font-medium text-fg-muted">
          {label ?? t('admin.users.assignRole')}
        </span>
        <select
          value={value}
          onChange={(event) => {
            onChange(event.target.value as AssignableRole);
            // Any change re-arms the acknowledgement. Otherwise ticking the
            // box for MODERATOR and then switching to ADMIN would carry the
            // consent across to a grant the operator never confirmed.
            onConfirmedChange(false);
          }}
          className="input mt-1 py-2 text-sm"
        >
          {ASSIGNABLE_ROLE_VALUES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </label>

      {/* Shown only for MODERATOR and ADMIN, and it gates the confirm button.
          The server requires the same acknowledgement, so skipping this dialog
          does not skip the safeguard. */}
      {privileged && (
        <PrivilegedRoleWarning confirmed={confirmed} onConfirmedChange={onConfirmedChange} />
      )}
    </div>
  );
}

/**
 * The acknowledgement shown before granting MODERATOR or ADMIN.
 *
 * Its own component because it appears in two places - the approval dialog in
 * the users table and the role dialog in the detail view - and this is the
 * last thing an operator reads before handing someone authority over other
 * people's accounts. Two copies of that sentence is one copy that eventually
 * says something weaker.
 */
export function PrivilegedRoleWarning({
  confirmed,
  onConfirmedChange,
}: {
  confirmed: boolean;
  onConfirmedChange: (next: boolean) => void;
}) {
  const t = useT();
  return (
    <div className="rounded-lg border border-warn/40 bg-warn-soft p-3">
      <p className="flex items-start gap-2 text-xs leading-relaxed text-warn-fg">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t('admin.users.privilegedWarning')}
      </p>
      <label className="mt-2.5 flex items-start gap-2 text-xs text-fg">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => onConfirmedChange(event.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-edge-strong"
        />
        <span>{t('admin.users.privilegedConfirm')}</span>
      </label>
    </div>
  );
}

/** Freeze durations, as offsets rather than a date picker. */
export const FREEZE_DURATIONS = [
  { key: 'h24', hours: 24 },
  { key: 'd7', hours: 24 * 7 },
  { key: 'd30', hours: 24 * 30 },
  // null = indefinite, which is the pre-existing suspension behaviour and is
  // still reachable. It is last, so the default lands on a bounded freeze.
  { key: 'indefinite', hours: null },
] as const;

export type FreezeDurationKey = (typeof FREEZE_DURATIONS)[number]['key'];

/**
 * Converts a duration choice into the ISO instant the API expects.
 *
 * Computed at CONFIRM time by the caller rather than when the dialog opens, so
 * a dialog left open for ten minutes still freezes for the full period the
 * operator selected instead of ten minutes less.
 */
export function freezeUntilIso(key: FreezeDurationKey): string | undefined {
  const found = FREEZE_DURATIONS.find((d) => d.key === key);
  if (!found || found.hours === null) return undefined;
  return new Date(Date.now() + found.hours * 3_600_000).toISOString();
}

export function FreezeDurationSelect({
  value,
  onChange,
}: {
  value: FreezeDurationKey;
  onChange: (key: FreezeDurationKey) => void;
}) {
  const t = useT();
  return (
    <label className="block">
      <span className="text-2xs font-medium text-fg-muted">
        {t('admin.users.freezeDuration')}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as FreezeDurationKey)}
        className="input mt-1 py-2 text-sm"
      >
        {FREEZE_DURATIONS.map((duration) => (
          <option key={duration.key} value={duration.key}>
            {t(`admin.users.durations.${duration.key}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
