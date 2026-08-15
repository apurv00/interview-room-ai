import type { HireReportExportMemberView } from '@/modules/hire-reports/services/hireReportExportService'

/**
 * Explicit response allowlist for every member-facing report route. Do not
 * spread service results here: the durable row also carries private snapshots,
 * object coordinates, cleanup metadata, and worker diagnostics.
 */
export function serializeHireReportExport(view: HireReportExportMemberView) {
  return {
    id: view.id,
    reportKind: view.reportKind,
    format: view.format,
    status: view.status,
    requestedAt: view.requestedAt,
    expiresAt: view.expiresAt,
    readyAt: view.readyAt,
  }
}
