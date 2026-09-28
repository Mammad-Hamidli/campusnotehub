'use client';

import { useRef, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Send } from 'lucide-react';
import { useLocale, useT } from '@/lib/i18n/LocaleProvider';
import { CONTACT_LIMITS, CONTACT_MESSAGE_MIN, contactSchema } from '@/server/validators/contact';

type FieldName = 'name' | 'email' | 'subject' | 'message';
type Values = Record<FieldName, string>;
type Errors = Partial<Record<FieldName, string>>;

const FIELDS: FieldName[] = ['name', 'email', 'subject', 'message'];
const EMPTY: Values = { name: '', email: '', subject: '', message: '' };

/** First message key per field, from zod's flattened errors (client or server). */
function firstErrors(fields: Record<string, string[] | undefined>): Errors {
  const errors: Errors = {};
  for (const field of FIELDS) {
    const key = fields[field]?.[0];
    if (key) errors[field] = key;
  }
  return errors;
}

/**
 * The /contact form. Posts to /api/contact, which emails the team.
 *
 * Validated with the SAME zod schema as the route, so a field error shown here
 * is the one the server would return, under the same message key. The server
 * still validates everything; this only saves a round trip.
 */
export function ContactForm() {
  const t = useT();
  const { locale } = useLocale();
  const formRef = useRef<HTMLFormElement>(null);

  const [values, setValues] = useState<Values>(EMPTY);
  const [website, setWebsite] = useState(''); // honeypot - see the route
  const [errors, setErrors] = useState<Errors>({});
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [failure, setFailure] = useState<string | null>(null);

  function update(field: FieldName, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function showErrors(found: Errors) {
    setErrors(found);
    const first = FIELDS.find((field) => found[field]);
    if (first) formRef.current?.querySelector<HTMLElement>(`#contact-${first}`)?.focus();
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === 'sending') return;

    const parsed = contactSchema.safeParse({ ...values, locale });
    if (!parsed.success) {
      showErrors(firstErrors(parsed.error.flatten().fieldErrors));
      return;
    }

    setStatus('sending');
    setFailure(null);
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...parsed.data, website }),
      });
      const body = await res.json().catch(() => ({}));

      if (res.ok) {
        setValues(EMPTY);
        setStatus('sent');
        return;
      }
      setStatus('idle');
      if (res.status === 400 && body.fields) {
        showErrors(firstErrors(body.fields));
        return;
      }
      setFailure(res.status === 429 ? 'errors.rateLimited' : 'contact.form.failed');
    } catch {
      setStatus('idle');
      setFailure('errors.network');
    }
  }

  return (
    <section aria-labelledby="contact-form-heading" className="card mt-8 p-5 sm:p-6">
      <h2 id="contact-form-heading" className="text-base font-semibold tracking-tight text-fg">
        {t('contact.form.title')}
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-fg-muted">{t('contact.form.subtitle')}</p>

      {status === 'sent' ? (
        <div role="status" className="mt-5 flex items-start gap-3 rounded-lg bg-verified-soft p-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-verified" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-fg">{t('contact.form.successTitle')}</p>
            <p className="mt-0.5 text-sm leading-relaxed text-fg-muted">{t('contact.form.successBody')}</p>
            <button type="button" onClick={() => setStatus('idle')} className="btn-secondary mt-3 px-3 py-1.5 text-sm">
              {t('contact.form.sendAnother')}
            </button>
          </div>
        </div>
      ) : (
        <form ref={formRef} method="post" onSubmit={submit} noValidate className="relative mt-5 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field name="name" label={t('contact.form.name')} error={errors.name && t(errors.name)}>
              {(describedBy) => (
                <input
                  id="contact-name"
                  name="name"
                  autoComplete="name"
                  required
                  aria-required="true"
                  aria-invalid={!!errors.name}
                  aria-describedby={describedBy}
                  maxLength={CONTACT_LIMITS.name}
                  value={values.name}
                  onChange={(e) => update('name', e.target.value)}
                  className={`input ${errors.name ? 'input-invalid' : ''}`}
                />
              )}
            </Field>
            <Field name="email" label={t('contact.form.email')} error={errors.email && t(errors.email)}>
              {(describedBy) => (
                <input
                  id="contact-email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  required
                  aria-required="true"
                  aria-invalid={!!errors.email}
                  aria-describedby={describedBy}
                  maxLength={CONTACT_LIMITS.email}
                  value={values.email}
                  onChange={(e) => update('email', e.target.value)}
                  placeholder={t('auth.register.emailPlaceholder')}
                  className={`input ${errors.email ? 'input-invalid' : ''}`}
                />
              )}
            </Field>
          </div>

          <Field name="subject" label={t('contact.form.subject')} error={errors.subject && t(errors.subject)}>
            {(describedBy) => (
              <input
                id="contact-subject"
                name="subject"
                required
                aria-required="true"
                aria-invalid={!!errors.subject}
                aria-describedby={describedBy}
                maxLength={CONTACT_LIMITS.subject}
                value={values.subject}
                onChange={(e) => update('subject', e.target.value)}
                className={`input ${errors.subject ? 'input-invalid' : ''}`}
              />
            )}
          </Field>

          <Field
            name="message"
            label={t('contact.form.message')}
            hint={t('contact.form.messageHint', { min: CONTACT_MESSAGE_MIN })}
            error={errors.message && t(errors.message)}
            counter={`${values.message.length} / ${CONTACT_LIMITS.message}`}
          >
            {(describedBy) => (
              <textarea
                id="contact-message"
                name="message"
                required
                aria-required="true"
                aria-invalid={!!errors.message}
                aria-describedby={describedBy}
                rows={6}
                maxLength={CONTACT_LIMITS.message}
                value={values.message}
                onChange={(e) => update('message', e.target.value)}
                className={`input min-h-32 resize-y ${errors.message ? 'input-invalid' : ''}`}
              />
            )}
          </Field>

          {/* Honeypot. Off-screen and out of the tab order and the
              accessibility tree, so only a bot filling every field finds it. */}
          <div aria-hidden="true" className="pointer-events-none absolute -left-[9999px] top-0 h-px w-px overflow-hidden opacity-0">
            <label htmlFor="contact-website">Website</label>
            <input
              id="contact-website"
              name="website"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </div>

          {failure && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{t(failure)}</span>
            </p>
          )}

          <button type="submit" disabled={status === 'sending'} className="btn-primary h-11 w-full sm:w-auto sm:px-6">
            {status === 'sending' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
            {t(status === 'sending' ? 'contact.form.sending' : 'contact.form.submit')}
          </button>
        </form>
      )}
    </section>
  );
}

/**
 * Label, control, and either the error or the hint below it - wired to the
 * control with aria-describedby, which the render prop receives.
 */
function Field({
  name,
  label,
  hint,
  error,
  counter,
  children,
}: {
  name: FieldName;
  label: string;
  hint?: string;
  error?: string | false;
  counter?: string;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const id = `contact-${name}`;
  const noteId = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 flex items-center gap-1 text-sm font-medium text-fg">
        {label}
        <span className="text-danger" aria-hidden="true">
          *
        </span>
      </label>
      {children(noteId)}
      {(error || hint || counter) && (
        <div className="mt-1.5 flex items-start justify-between gap-3">
          {error ? (
            <p id={noteId} role="alert" className="flex min-w-0 items-start gap-1.5 text-xs text-danger">
              <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{error}</span>
            </p>
          ) : hint ? (
            <p id={noteId} className="min-w-0 text-xs leading-snug text-fg-muted">
              {hint}
            </p>
          ) : (
            <span />
          )}
          {counter && (
            <span className="shrink-0 text-2xs tabular-nums text-fg-subtle" aria-hidden="true">
              {counter}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
