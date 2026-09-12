import { NextResponse } from 'next/server';
import { listUniversities } from '@/lib/firebase/repositories/reference';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/universities
 *
 * The active universities, straight from Firestore. Public reference data -
 * the feed's filter chips and the mentor directory's filter read it.
 *
 * Deliberately `no-store`: an administrator adding or deactivating a
 * university must show up on the next page load, not an hour later.
 */
export async function GET() {
  const rows = await listUniversities();

  return NextResponse.json(
    {
      universities: rows
        .map((u) => ({ id: u.id, code: u.code, nameAz: u.nameAz, nameEn: u.nameEn, nameRu: u.nameRu }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
