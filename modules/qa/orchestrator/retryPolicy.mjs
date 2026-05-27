export const DEFAULT_CELL_RETRY = 1
export const QUOTA_HTTP_STATUSES = [402, 403]

/**
 * @param {number | null | undefined} status
 */
export function isQuotaExceeded(status) {
  return status != null && QUOTA_HTTP_STATUSES.includes(status)
}

/**
 * @param {number} attempt 0-based attempt index for the current cell
 * @param {number} [maxRetries] extra attempts after the first (default 1 → 2 total tries)
 */
export function shouldRetryCell(attempt, maxRetries = DEFAULT_CELL_RETRY) {
  return attempt < maxRetries
}

/**
 * Merge prior matrix partial report with a continuation run.
 * Later entries win when runId collides.
 * @param {object | null | undefined} prior
 * @param {object} next
 */
export function mergeMatrixReports(prior, next) {
  if (!prior?.runs?.length) return next

  const byRunId = new Map()
  for (const run of prior.runs) {
    byRunId.set(run.runId, run)
  }
  for (const run of next.runs ?? []) {
    byRunId.set(run.runId, run)
  }

  const runs = [...byRunId.values()]
  const passedRuns = runs.filter((r) => r.pass).length
  const telemetry = [...(prior.telemetry ?? []), ...(next.telemetry ?? [])]
  const evaluationRows = [...(prior.evaluationRows ?? []), ...(next.evaluationRows ?? [])]

  return {
    ...next,
    reportId: prior.reportId ?? next.reportId,
    runs,
    totalRuns: runs.length,
    passedRuns,
    passRate: runs.length ? passedRuns / runs.length : 0,
    telemetry,
    evaluationRows,
    resumedFrom: prior.reportId ?? null,
    mergedAt: new Date().toISOString(),
  }
}

/**
 * @param {object | null | undefined} priorReport
 * @param {object | null | undefined} manifest
 */
export function computeResumeOffset(priorReport, manifest) {
  if (priorReport?.runs?.length) return priorReport.runs.length
  const completed = manifest?.resume?.completedCells
  if (Array.isArray(completed) && completed.length) return completed.length
  return manifest?.resume?.offset ?? 0
}

/**
 * @param {object} report matrix-report.json shape
 */
export function summarizeCompletedCells(report) {
  return (report?.runs ?? []).map((r) => r.runId).filter(Boolean)
}
