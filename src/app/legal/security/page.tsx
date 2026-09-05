import type { Metadata } from 'next';
import { StubPage } from '@/components/ui/UnderConstruction';

export const metadata: Metadata = { title: 'Security' };

/**
 * Stub route. Returns 200 with an honest "not built yet" state.
 *
 * Every link in the navigation resolves to a real page, so a 404 in the logs
 * is always a genuine bug rather than a known gap. See
 * src/components/ui/UnderConstruction.tsx for the reasoning.
 */
export default function Page() {
  return <StubPage titleKey="landing.footer.security" />;
}
