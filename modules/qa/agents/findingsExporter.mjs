/**
 * Export findings register to CSV (Linear/Jira import).
 */
import { writeFileSync } from 'node:fs'

function csvEscape(val) {
  return `"${String(val ?? '').replace(/"/g, '""')}"`
}

/**
 * @param {object[]} findings
 * @param {string} outPath
 */
export function exportFindingsCsv(findings, outPath) {
  const header = 'id,severity,stage,title,status,classification,impact,evidence,nextSteps,activityLinks'
  const lines = findings.map((f) =>
    [
      f.id,
      f.severity,
      f.stage,
      csvEscape(f.title),
      f.status,
      f.classification ?? '',
      csvEscape(f.impact),
      csvEscape((f.evidence ?? []).join(' | ')),
      csvEscape((f.nextSteps ?? []).join(' | ')),
      csvEscape((f.activityLinks ?? []).join(' | ')),
    ].join(','),
  )
  writeFileSync(outPath, [header, ...lines].join('\n'), 'utf-8')
  return outPath
}
