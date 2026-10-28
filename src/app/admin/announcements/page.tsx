import type { Metadata } from 'next';
import { AnnouncementManager } from '@/components/admin/AnnouncementManager';

export const metadata: Metadata = { title: 'Announcements' };

export default function Page() {
  return <AnnouncementManager />;
}
