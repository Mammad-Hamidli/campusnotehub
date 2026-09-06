import type { Metadata } from 'next';
import { AdminDashboard } from '@/components/admin/Dashboard';

export const metadata: Metadata = { title: 'Dashboard' };

/**
 * Renders no privileged data on the server and passes none as props.
 *
 * Every figure is fetched client-side from /api/admin/stats, which
 * re-authorizes the request independently. That keeps the security boundary in
 * one place - the API - rather than splitting it between a server render and a
 * handler that could drift apart.
 */
export default function Page() {
  return <AdminDashboard />;
}
