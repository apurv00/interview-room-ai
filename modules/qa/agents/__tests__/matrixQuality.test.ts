import { describe, it, expect } from 'vitest'
// @ts-expect-error — .mjs module without types
import { computeMatrixQuality, matrixQualityToFindings } from '../matrixQuality.mjs'

/** Build a minimal matrix-report.json shape with the given runs. */
function report(runs: unknown[]) {
  return { mode: 'smoke', runs }
}

function run(matrixKey: string, questions: string[]) {
  return {
    matrixKey,
    runId: matrixKey,
    pass: true,
    questions: questions.map((q) => ({ question: q })),
  }
}

describe('matrixQuality — academics favourite-subject opener guard', () => {
  it('flags an academics cell whose generated question re-asks the opener', () => {
    const q = computeMatrixQuality(
      report([run('backend/academics/strong', [
        'Which subject are you strongest in, and why?', // <- the duplication bug
        'Walk me through how a hash table degrades to O(n).',
      ])]),
    )
    expect(q.academicOpenerCount).toBe(1)
    expect(q.academicOpenerCells[0].matrixKey).toBe('backend/academics/strong')

    const findings = matrixQualityToFindings(q)
    const f = findings.find((x: { id: string }) => x.id === 'AUTO-ACAD-001')
    expect(f).toBeTruthy()
    expect(f.classification).toBe('product-bug')
  })

  it('catches the exact spoken-intro phrasing rephrased as a generated question', () => {
    const q = computeMatrixQuality(
      report([run('mechanical/academics/weak', [
        'To start, which academic subject are you strongest in, or enjoy the most?',
      ])]),
    )
    expect(q.academicOpenerCount).toBe(1)
  })

  it('does NOT flag a clean academics Q1 roadmap warm-up', () => {
    const q = computeMatrixQuality(
      report([run('marketing/academics/strong', [
        'You named marketing analytics — give me a quick map of the main topics within it you have studied.',
        'Derive the customer lifetime value formula and tell me what each term assumes.',
      ])]),
    )
    expect(q.academicOpenerCount).toBe(0)
    expect(matrixQualityToFindings(q).find((x: { id: string }) => x.id === 'AUTO-ACAD-001')).toBeUndefined()
  })

  it('does NOT flag legitimate references to the already-named subject', () => {
    const q = computeMatrixQuality(
      report([run('backend/academics/strong', [
        'Within your strongest subject, derive the time complexity of a B+-tree range scan.',
        'Of the core subjects, which two feel most connected to you?', // breadth probe, not the opener
      ])]),
    )
    expect(q.academicOpenerCount).toBe(0)
  })

  it('only applies the guard to academics cells (depth-gated)', () => {
    const q = computeMatrixQuality(
      report([run('backend/technical/strong', [
        'Which subject are you strongest in?', // implausible for technical, but must not be academics-flagged
      ])]),
    )
    expect(q.academicOpenerCount).toBe(0)
  })
})
