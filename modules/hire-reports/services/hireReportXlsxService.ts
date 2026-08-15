import type * as ExcelJS from 'exceljs'
import type {
  HireJobCloseoutReportSnapshot,
  HirePipelineStatusReportSnapshot,
  HireReportEvidenceSummary,
  HireReportKind,
  HireReportRecommendationTally,
  HireReportSnapshot,
} from '../types'
import { formatHireReportBlocker, formatHireReportStage } from './reportSnapshotBuilders'

const FORMULA_PREFIX = /^[=+\-@]/
const HEADER_FILL = '1D9BF0'
const SUBHEADER_FILL = 'E8F2F9'
const MUTED_FONT = '526471'
const REPORT_COLUMN_COUNT = 3

/** Dynamic server-only load keeps the workbook writer out of client bundles. */
function exceljs(): typeof import('exceljs') {
  return require('exceljs') as typeof import('exceljs')
}

/**
 * Every report string is a static shared-string cell. This blocks formula
 * interpretation when a job title, candidate name, or close note begins with
 * an Excel control character.
 */
export function neutralizeHireReportSpreadsheetText(value: string): string {
  return FORMULA_PREFIX.test(value) ? `'${value}` : value
}

function setTitle(sheet: ExcelJS.Worksheet, title: string): void {
  sheet.mergeCells(1, 1, 1, REPORT_COLUMN_COUNT)
  const cell = sheet.getCell('A1')
  cell.value = neutralizeHireReportSpreadsheetText(title)
  cell.font = { bold: true, size: 16, color: { argb: '16202A' } }
  cell.alignment = { vertical: 'middle' }
  sheet.getRow(1).height = 24
}

function setSectionHeading(sheet: ExcelJS.Worksheet, rowNumber: number, label: string): void {
  const cell = sheet.getCell(rowNumber, 1)
  cell.value = neutralizeHireReportSpreadsheetText(label)
  cell.font = { bold: true, color: { argb: '16202A' } }
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUBHEADER_FILL } }
  sheet.mergeCells(rowNumber, 1, rowNumber, REPORT_COLUMN_COUNT)
}

function setTableHeader(sheet: ExcelJS.Worksheet, rowNumber: number, labels: readonly string[]): void {
  labels.forEach((label, index) => {
    const cell = sheet.getCell(rowNumber, index + 1)
    cell.value = neutralizeHireReportSpreadsheetText(label)
    cell.font = { bold: true, color: { argb: 'FFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } }
    cell.alignment = { vertical: 'middle', wrapText: true }
  })
  sheet.getRow(rowNumber).height = 30
}

function setDataCell(cell: ExcelJS.Cell, value: string | number | Date): void {
  cell.value = typeof value === 'string' ? neutralizeHireReportSpreadsheetText(value) : value
  cell.alignment = { vertical: 'top', wrapText: true }
  if (value instanceof Date) cell.numFmt = 'yyyy-mm-dd'
}

function setColumnWidths(sheet: ExcelJS.Worksheet, widths: readonly number[]): void {
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width
  })
}

function recommendationText(recommendations: HireReportRecommendationTally): string {
  return [
    `Strong yes: ${recommendations.strong_yes}`,
    `Yes: ${recommendations.yes}`,
    `No: ${recommendations.no}`,
    `Strong no: ${recommendations.strong_no}`,
  ].join(' | ')
}

function writeEvidence(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  evidence: HireReportEvidenceSummary,
): number {
  setSectionHeading(sheet, startRow, 'Evidence summary - sources stay separate')
  setTableHeader(sheet, startRow + 1, ['Source', 'Submitted / completed', 'Source-specific recommendations'])
  const rows = [
    ['AI assessments', evidence.aiAssessments.completedCount, 'Not applicable'],
    [
      'Member scorecards',
      evidence.humanScorecards.member.submittedCount,
      recommendationText(evidence.humanScorecards.member.recommendations),
    ],
    [
      'Guest-kit scorecards',
      evidence.humanScorecards.kit.submittedCount,
      recommendationText(evidence.humanScorecards.kit.recommendations),
    ],
    [
      'External verdicts',
      evidence.externalVerdicts.submittedCount,
      recommendationText(evidence.externalVerdicts.recommendations),
    ],
  ] as const
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => setDataCell(sheet.getCell(startRow + 2 + rowIndex, columnIndex + 1), value))
  })
  return startRow + 2 + rows.length
}

function writePipelineStatusSheet(
  workbook: ExcelJS.Workbook,
  snapshot: HirePipelineStatusReportSnapshot,
): void {
  const sheet = workbook.addWorksheet('Pipeline Status', { views: [{ state: 'frozen', ySplit: 3 }] })
  setTitle(sheet, snapshot.scope === 'job' ? 'Job pipeline status report' : 'Workspace pipeline status report')
  setDataCell(sheet.getCell('A2'), 'As of')
  setDataCell(sheet.getCell('B2'), snapshot.asOf)
  setDataCell(sheet.getCell('C2'), 'Scope')
  setDataCell(sheet.getCell('D2'), snapshot.scope)
  let row = 4

  for (const job of snapshot.jobs) {
    setSectionHeading(sheet, row, job.jobTitle)
    setDataCell(sheet.getCell(row + 1, 1), 'Status')
    setDataCell(sheet.getCell(row + 1, 2), job.jobStatus)
    setDataCell(sheet.getCell(row + 2, 1), 'Opened')
    setDataCell(sheet.getCell(row + 2, 2), job.openedAt)

    let tableRow = row + 4
    const aggregateTables: Array<{
      label: string
      entries: Array<{ label: string; count: number }>
    }> = [
      {
        label: 'Stage',
        entries: job.stageCounts.map((entry) => ({
          label: formatHireReportStage(entry.stage),
          count: entry.count,
        })),
      },
      {
        label: 'Aging bucket',
        entries: job.aging.map((entry) => ({
          label: entry.bucket.replace(/_/g, ' '),
          count: entry.count,
        })),
      },
      {
        label: 'Blocker',
        entries: job.blockers.map((entry) => ({
          label: formatHireReportBlocker(entry.kind),
          count: entry.count,
        })),
      },
    ]
    aggregateTables.forEach((table) => {
      setTableHeader(sheet, tableRow, [table.label, 'Candidates'])
      table.entries.forEach((entry, index) => {
        setDataCell(sheet.getCell(tableRow + 1 + index, 1), entry.label)
        setDataCell(sheet.getCell(tableRow + 1 + index, 2), entry.count)
      })
      tableRow += table.entries.length + 2
    })
    row = writeEvidence(sheet, tableRow, job.evidence) + 2
  }
  sheet.addRow([])
  const note = sheet.addRow(['This static report presents evidence by source. It does not calculate a composite score or a hiring action.'])
  note.getCell(1).font = { italic: true, color: { argb: MUTED_FONT } }
  sheet.mergeCells(note.number, 1, note.number, REPORT_COLUMN_COUNT)
  setColumnWidths(sheet, [28, 20, 44])
}

function writeCloseoutSheet(
  workbook: ExcelJS.Workbook,
  snapshot: HireJobCloseoutReportSnapshot,
): void {
  const sheet = workbook.addWorksheet('Job Closeout', { views: [{ state: 'frozen', ySplit: 3 }] })
  setTitle(sheet, 'Job close-out report')
  const facts: Array<[string, string | number | Date]> = [
    ['Job', snapshot.jobTitle],
    ['Opened', snapshot.openedAt],
    ['Closed', snapshot.closedAt],
    ['Hours to close', snapshot.timeToCloseHours],
    ['Snapshot as of', snapshot.asOf],
  ]
  facts.forEach(([label, value], index) => {
    setDataCell(sheet.getCell(index + 2, 1), label)
    setDataCell(sheet.getCell(index + 2, 2), value)
  })

  let row = 8
  setSectionHeading(sheet, row, 'Funnel')
  setTableHeader(sheet, row + 1, ['Stage', 'Candidates'])
  snapshot.stageCounts.forEach((entry, index) => {
    setDataCell(sheet.getCell(row + 2 + index, 1), formatHireReportStage(entry.stage))
    setDataCell(sheet.getCell(row + 2 + index, 2), entry.count)
  })
  row += snapshot.stageCounts.length + 3

  setSectionHeading(sheet, row, 'Hired candidates')
  setTableHeader(sheet, row + 1, ['Candidate', 'Hired at'])
  if (snapshot.hiredCandidates.length === 0) {
    setDataCell(sheet.getCell(row + 2, 1), 'No candidate was recorded as hired when this job closed.')
    row += 3
  } else {
    snapshot.hiredCandidates.forEach((candidate, index) => {
      setDataCell(sheet.getCell(row + 2 + index, 1), candidate.candidateName)
      setDataCell(sheet.getCell(row + 2 + index, 2), candidate.hiredAt)
    })
    row += snapshot.hiredCandidates.length + 2
  }

  setSectionHeading(sheet, row, 'Decision note')
  setDataCell(sheet.getCell(row + 1, 1), snapshot.decisionNote)
  sheet.mergeCells(row + 1, 1, row + 1, 4)
  sheet.getRow(row + 1).height = Math.max(30, Math.min(120, Math.ceil(snapshot.decisionNote.length / 60) * 15))
  row = writeEvidence(sheet, row + 3, snapshot.evidence) + 2
  const note = sheet.addRow(['This static report presents evidence by source. It does not calculate a composite score or revise a pipeline decision.'])
  note.getCell(1).font = { italic: true, color: { argb: MUTED_FONT } }
  sheet.mergeCells(note.number, 1, note.number, REPORT_COLUMN_COUNT)
  setColumnWidths(sheet, [30, 20, 42])
}

/**
 * Generate a static report workbook. It uses no formulas, external links, or
 * live data connections; all values originate from the frozen report snapshot.
 */
export async function generateHireReportXlsx(snapshot: HireReportSnapshot): Promise<Buffer> {
  const workbook = new (exceljs().Workbook)()
  workbook.creator = 'IPG Hire'
  workbook.created = new Date()
  workbook.modified = new Date()
  workbook.calcProperties.fullCalcOnLoad = false
  if (snapshot.kind === 'pipeline_status') {
    writePipelineStatusSheet(workbook, snapshot)
  } else {
    writeCloseoutSheet(workbook, snapshot)
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

/** Avoid candidate names, workspace names, and user-controlled text in filenames. */
export function hireReportXlsxFilename(kind: HireReportKind): string {
  return kind === 'pipeline_status' ? 'pipeline-status-report.xlsx' : 'job-closeout-report.xlsx'
}
