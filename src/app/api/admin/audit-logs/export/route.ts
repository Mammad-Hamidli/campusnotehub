import { NextResponse, type NextRequest } from 'next/server';
import ExcelJS from 'exceljs';
import { db } from '@/lib/db';
import { withAdmin, adminAudit } from '@/lib/auth/admin';
import { adminAuditListSchema } from '@/server/validators/admin';
import { auditWhere } from '@/lib/admin/auditQuery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A wide export streams tens of thousands of rows through the workbook writer.
export const maxDuration = 60;

/**
 * GET /api/admin/audit-logs/export - the filtered audit log as .xlsx
 *
 * ---------------------------------------------------------------------------
 * FOUR DECISIONS WORTH KNOWING ABOUT
 * ---------------------------------------------------------------------------
 * 1. IT REUSES auditWhere(). The export applies exactly the filters the
 *    operator had on screen. An export that quietly returns a different set
 *    than the table it was launched from is worse than no export, because it
 *    looks authoritative.
 *
 * 2. EXPORTING IS ITSELF AUDITED. Downloading the full administrative history
 *    is a bulk read of who-did-what-to-whom, which is precisely the sort of
 *    access this table exists to record. The audit row is written BEFORE the
 *    bytes are produced, so a download that fails halfway still leaves the
 *    attempt on record.
 *
 * 3. IT IS CAPPED. Without a ceiling, `?pageSize=` aside, an unfiltered export
 *    would try to materialise the entire table in memory and turn a reporting
 *    feature into an OOM. The cap is generous and the response says when it
 *    was hit, so a truncated file is never mistaken for a complete one.
 *
 * 4. before/after ARE FLATTENED TO JSON TEXT. They are arbitrary JSON, and
 *    spreading them into columns would give every export a different shape.
 *    One readable column each keeps the sheet stable and diffable.
 */

/** Ceiling on rows per export. See decision 3. */
const MAX_EXPORT_ROWS = 50_000;

/**
 * Text destined for a spreadsheet cell.
 *
 * Excel treats a leading =, +, - or @ as the start of a FORMULA, so a stored
 * value like `=cmd|...` becomes executable content when the file is opened -
 * the CSV/spreadsheet injection class. Nothing in this table should contain
 * such a value, but "should" is not a control when the file lands on someone's
 * desktop, so the prefix is neutralised on the way out.
 */
function safeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export async function GET(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async (actor) => {
    const parsed = adminAuditListSchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const where = auditWhere(parsed.data);

    // Written first - see decision 2.
    await adminAudit({
      actorId: actor.id,
      action: 'ADMIN_AUDIT_LOG_EXPORTED',
      entityType: 'audit_log',
      after: { filters: request.nextUrl.search || '(none)' },
      request,
    });

    const rows = await db.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_EXPORT_ROWS + 1,
      select: {
        id: true,
        createdAt: true,
        action: true,
        entityType: true,
        entityId: true,
        result: true,
        ip: true,
        userAgent: true,
        before: true,
        after: true,
        actor: { select: { id: true, nickname: true, role: true } },
      },
    });

    const truncated = rows.length > MAX_EXPORT_ROWS;
    const page = truncated ? rows.slice(0, MAX_EXPORT_ROWS) : rows;

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'UniPath Admin';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Audit log', {
      // Freezing the header keeps the column meanings visible while scrolling
      // fifty thousand rows, which is the only way this file is ever read.
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    sheet.columns = [
      { header: 'Date/time (UTC)', key: 'createdAt', width: 22 },
      { header: 'Admin', key: 'admin', width: 20 },
      { header: 'Admin role', key: 'adminRole', width: 14 },
      { header: 'Action', key: 'action', width: 30 },
      { header: 'Target type', key: 'entityType', width: 18 },
      { header: 'Target ID', key: 'entityId', width: 28 },
      { header: 'Status', key: 'result', width: 12 },
      { header: 'IP address', key: 'ip', width: 18 },
      { header: 'Device / User-Agent', key: 'userAgent', width: 46 },
      { header: 'Before', key: 'before', width: 40 },
      { header: 'After', key: 'after', width: 40 },
      { header: 'Log ID', key: 'id', width: 28 },
    ];

    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDF1F6' } };
    header.alignment = { vertical: 'middle' };

    for (const row of page) {
      sheet.addRow({
        /**
         * A real Date, not a formatted string, so the column sorts and filters
         * chronologically in Excel. Stored in UTC and the header says so - a
         * silently localised timestamp in an audit export is how two operators
         * in different timezones come to disagree about when something
         * happened.
         */
        createdAt: row.createdAt,
        admin: safeCell(row.actor?.nickname ? `@${row.actor.nickname}` : '(system)'),
        adminRole: safeCell(row.actor?.role ?? ''),
        action: safeCell(row.action),
        entityType: safeCell(row.entityType),
        entityId: safeCell(row.entityId),
        // NULL on rows written before this column existed. Left blank rather
        // than defaulted to SUCCESS, which would invent a fact.
        result: safeCell(row.result ?? ''),
        // Blank for non-admin rows by design - see the note in the list route.
        ip: safeCell(row.ip ?? ''),
        userAgent: safeCell(row.userAgent ?? ''),
        before: safeCell(row.before),
        after: safeCell(row.after),
        id: safeCell(row.id),
      });
    }

    sheet.getColumn('createdAt').numFmt = 'yyyy-mm-dd hh:mm:ss';
    sheet.autoFilter = { from: 'A1', to: { row: 1, column: sheet.columns.length } };

    if (truncated) {
      // Stated inside the file, not only in a header, because the header is
      // gone the moment the file is saved and forwarded.
      const notice = sheet.addRow({
        action: `NOTE: export truncated at ${MAX_EXPORT_ROWS} rows. Narrow the date range to export the remainder.`,
      });
      notice.font = { bold: true, color: { argb: 'FFBE2C2C' } };
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const stamp = new Date().toISOString().slice(0, 10);

    return new NextResponse(buffer as ArrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="unipath-audit-log-${stamp}.xlsx"`,
        'Content-Length': String((buffer as ArrayBuffer).byteLength),
        // The file lists real accounts and staff actions. It must not be held
        // by an intermediary or replayed from a browser cache.
        'Cache-Control': 'no-store, private',
        'X-Export-Truncated': truncated ? 'true' : 'false',
      },
    });
  });
}
