import type { Metadata } from 'next';
import { ReviewsConsole } from '@/components/admin/ReviewsConsole';

export const metadata: Metadata = {
  title: 'Reviews',
  robots: { index: false, follow: false },
};

export default function Page() {
  return <ReviewsConsole />;
}
