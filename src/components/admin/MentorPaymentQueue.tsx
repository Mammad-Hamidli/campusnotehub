'use client';

import { useState } from 'react';
import { Check, Paperclip, X } from 'lucide-react';
import { PageHeader } from './AdminShell';
import { Badge, EmptyState, ErrorState, TableSkeleton, formatDateTime, useAdminFetch } from './primitives';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useConfirm, useToast } from '@/components/ui/Feedback';

type Status = 'PENDING' | 'APPROVED' | 'INVALID';
type Receipt = {
  id: string;
  status: Status;
  fromAddress: string;
  subject: string;
  receivedAt: string;
  attachmentNames: string[];
  decidedAt: string | null;
  user: {
    id: string;
    nickname: string;
    fullName: string;
    email: string;
    mentorType: 'INDIVIDUAL' | 'COURSE' | null;
    mentorRegistrationStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | null;
  } | null;
};

const TABS: Status[] = ['PENDING', 'APPROVED', 'INVALID'];
const FEE: Record<'INDIVIDUAL' | 'COURSE', number> = { INDIVIDUAL: 10, COURSE: 30 };

/**
 * Receipts mentors sent in reply to the payment instructions email. The file
 * itself stays in the support mailbox; this queue is where the decision is
 * recorded. Approving the first receipt activates the mentor account.
 */
export function MentorPaymentQueue() {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Status>('PENDING');
  const [busyId, setBusyId] = useState<string | null>(null);
  const { data, error, loading, reload } = useAdminFetch<{ receipts: Receipt[] }>(
    `/api/admin/mentor-payment-receipts?status=${tab}`,
  );

  async function decide(receipt: Receipt, decision: 'APPROVED' | 'INVALID') {
    const approving = decision === 'APPROVED';
    const label = t(approving ? 'admin.mentorPayments.approve' : 'admin.mentorPayments.reject');
    const ok = await confirm({
      title: label,
      body: t(approving ? 'admin.mentorPayments.confirmApprove' : 'admin.mentorPayments.confirmReject', {
        name: receipt.user?.nickname ?? receipt.fromAddress,
      }),
      confirmLabel: label,
      ...(approving ? {} : { tone: 'danger' as const }),
    });
    if (!ok) return;
    setBusyId(receipt.id);
    try {
      const response = await fetch(`/api/admin/mentor-payment-receipts/${receipt.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'errors.generic');
      toast.success(t(
        !approving
          ? 'admin.mentorPayments.rejected'
          : result.activated ? 'admin.mentorPayments.activated' : 'admin.mentorPayments.approved',
      ));
    } catch (cause) {
      toast.error(t(cause instanceof Error ? cause.message : 'errors.generic'));
    } finally {
      setBusyId(null);
      reload();
    }
  }

  const receipts = data?.receipts ?? [];

  return <>
    <PageHeader title={t('admin.mentorPayments.title')} description={t('admin.mentorPayments.description')} />
    <div role="tablist" className="mb-4 flex gap-1.5">
      {TABS.map((status) => (
        <button
          key={status}
          type="button"
          role="tab"
          aria-selected={tab === status}
          onClick={() => setTab(status)}
          className={tab === status ? 'btn-primary px-3 py-1.5 text-xs' : 'btn-secondary px-3 py-1.5 text-xs'}
        >
          {t(`admin.mentorPayments.tabs.${status}`)}
        </button>
      ))}
    </div>

    {loading && !data ? <TableSkeleton rows={4} cols={4} />
      : error ? <ErrorState message={t(error)} onRetry={reload} />
      : receipts.length === 0 ? <EmptyState title={t('admin.mentorPayments.empty')} />
      : (
        <ul className="space-y-3">
          {receipts.map((receipt) => (
            <li key={receipt.id} className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-fg">
                    {receipt.user ? `${receipt.user.fullName} (@${receipt.user.nickname})` : t('admin.mentorPayments.noAccount')}
                  </span>
                  {receipt.user?.mentorType && (
                    <Badge tone="accent">{receipt.user.mentorType} · {FEE[receipt.user.mentorType]} AZN</Badge>
                  )}
                  {receipt.user?.mentorRegistrationStatus === 'PENDING' && (
                    <Badge tone="warning">{t('admin.mentorPayments.awaitingActivation')}</Badge>
                  )}
                </div>
                <p className="truncate text-xs text-fg-muted">{receipt.fromAddress} · {formatDateTime(receipt.receivedAt)}</p>
                <p className="truncate text-xs text-fg">{receipt.subject}</p>
                {receipt.attachmentNames.length > 0 && (
                  <p className="flex flex-wrap items-center gap-1 text-xs text-fg-muted">
                    <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
                    {receipt.attachmentNames.join(', ')}
                  </p>
                )}
                {receipt.decidedAt && (
                  <p className="text-2xs text-fg-subtle">
                    {t('admin.mentorPayments.decidedAt', { when: formatDateTime(receipt.decidedAt) })}
                  </p>
                )}
              </div>
              {receipt.status === 'PENDING' && (
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
                    disabled={busyId !== null || !receipt.user}
                    onClick={() => void decide(receipt, 'APPROVED')}
                  >
                    <Check className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />{t('admin.mentorPayments.approve')}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-50"
                    disabled={busyId !== null}
                    onClick={() => void decide(receipt, 'INVALID')}
                  >
                    <X className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />{t('admin.mentorPayments.reject')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
  </>;
}
