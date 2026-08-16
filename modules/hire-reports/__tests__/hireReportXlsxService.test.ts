import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { hireReportWorkbookQa } from './fixtures/reportWorkbookQa'
import {
  generateHireReportXlsx,
  hireReportXlsxFilename,
  neutralizeHireReportSpreadsheetText,
} from '../services/hireReportXlsxService'

async function load(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  return workbook
}

function formulaCells(workbook: ExcelJS.Workbook): string[] {
  const cells: string[] = []
  workbook.worksheets.forEach((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.type === ExcelJS.ValueType.Formula) cells.push(`${sheet.name}!${cell.address}`)
      })
    })
  })
  return cells
}

function cellValues(sheet: ExcelJS.Worksheet | undefined): string[] {
  const values: string[] = []
  sheet?.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => values.push(String(cell.value)))
  })
  return values
}

describe('Hire report XLSX rendering', () => {
  it('creates a parseable, static pipeline workbook with source-separated evidence', async () => {
    const buffer = await generateHireReportXlsx(hireReportWorkbookQa.pipeline)
    const workbook = await load(buffer)
    const sheet = workbook.getWorksheet('Pipeline Status')

    expect(buffer.subarray(0, 2).toString()).toBe('PK')
    expect(sheet).toBeDefined()
    expect(sheet?.getCell('A1').value).toBe('Workspace pipeline status report')
    expect(sheet?.getCell('A4').value).toBe("'=Platform Engineer — Department: Engineering")
    expect(sheet?.getCell('A2').value).toBe('As of')
    expect(cellValues(sheet)).toEqual(expect.arrayContaining([
      'Evidence summary - sources stay separate',
      'AI assessments',
      'Member scorecards',
      'Guest-kit scorecards',
      'External verdicts',
      'Strong yes: 0 | Yes: 2 | No: 0 | Strong no: 0',
    ]))
    expect(formulaCells(workbook)).toEqual([])
  })

  it('creates a parseable closeout workbook with no formulas and formula-neutralized text', async () => {
    const buffer = await generateHireReportXlsx(hireReportWorkbookQa.closeout)
    const workbook = await load(buffer)
    const sheet = workbook.getWorksheet('Job Closeout')

    expect(sheet?.getCell('B2').value).toBe("'=Platform Engineer")
    expect(sheet?.getCell('A1').value).toBe('Job close-out report — Department: Revenue')
    expect(sheet?.getCell('A21').value).toBe("'+Ada Lovelace")
    expect(sheet?.getCell('A23').value).toBe("'@Panel note: independent evidence was reviewed.")
    expect(sheet?.getColumn(1).width).toBe(30)
    expect(formulaCells(workbook)).toEqual([])
  })

  it('uses non-PII static filenames and protects all Excel formula prefixes', () => {
    expect(hireReportXlsxFilename('pipeline_status')).toBe('pipeline-status-report.xlsx')
    expect(hireReportXlsxFilename('job_closeout')).toBe('job-closeout-report.xlsx')
    for (const value of ['=1+1', '+1', '-1', '@cell', 'ordinary text']) {
      const result = neutralizeHireReportSpreadsheetText(value)
      expect(result.startsWith("'")).toBe(value !== 'ordinary text')
    }
  })
})
