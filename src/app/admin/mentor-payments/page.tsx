import type { Metadata } from 'next';
import { MentorPaymentQueue } from '@/components/admin/MentorPaymentQueue';

export const metadata: Metadata = { title: 'Mentor payments' };

export default function Page() {
  return <MentorPaymentQueue />;
}
