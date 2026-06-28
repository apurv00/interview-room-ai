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

  it('catches the "what subject are you strongest in" wording too (Codex #473 P2)', () => {
    const variants = [
      'What subject are you strongest in?',
      'What academic subject are you strongest in or enjoy most?',
      'So, what subject do you feel most confident in?',
    ]
    for (const text of variants) {
      const q = computeMatrixQuality(report([run('backend/academics/strong', [text])]))
      expect(q.academicOpenerCount, text).toBe(1)
    }
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

describe('matrixQuality — deterministic fixture depths (Codex #474 P1)', () => {
  const SAME_DESIGN_Q = 'Design a URL shortening service like bit.ly with high read throughput.'
  it('does NOT flag the static design problem repeated across personas', () => {
    const q = computeMatrixQuality(
      report([
        run('backend/system-design/strong', [SAME_DESIGN_Q]),
        run('backend/system-design/weak', [SAME_DESIGN_Q]),
      ]),
    )
    expect(q.duplicateCount).toBe(0)
    expect(matrixQualityToFindings(q).find((x: { id: string }) => x.id === 'AUTO-DUP-001')).toBeUndefined()
  })

  it('still flags a genuinely repeated generated question for non-fixture depths', () => {
    const SAME = 'Tell me about a time you led a cross-functional launch and the metrics you owned.'
    const q = computeMatrixQuality(
      report([
        run('backend/behavioral/strong', [SAME]),
        run('backend/behavioral/weak', [SAME]),
      ]),
    )
    expect(q.duplicateCount).toBe(1)
    expect(matrixQualityToFindings(q).find((x: { id: string }) => x.id === 'AUTO-DUP-001')).toBeTruthy()
  })
})

describe('matrixQuality — 429 check scoped to question generation (Codex #474 P2)', () => {
  function reportWith(telemetry: unknown[]) {
    return { mode: 'full', runs: [], telemetry }
  }
  it('does NOT count generate-problem-observe 429s as generate-question rate limiting', () => {
    const q = computeMatrixQuality(
      reportWith([
        { stage: 'interview', step: 'generate-problem-observe', matrixKey: 'backend/coding/strong', apiResult: { status: 429 } },
      ]),
    )
    expect(q.genQ429Count).toBe(0)
    expect(matrixQualityToFindings(q).find((x: { id: string }) => x.id === 'AUTO-GEN-002')).toBeUndefined()
  })

  it('still counts real generate-question 429s (and retries)', () => {
    const q = computeMatrixQuality(
      reportWith([
        { stage: 'interview', step: 'generate-question', matrixKey: 'backend/technical/strong', apiResult: { status: 429 } },
        { stage: 'interview', step: 'generate-question-retry', matrixKey: 'pm/case-study/weak', apiResult: { status: 429 } },
      ]),
    )
    expect(q.genQ429Count).toBe(2)
    expect(matrixQualityToFindings(q).find((x: { id: string }) => x.id === 'AUTO-GEN-002')).toBeTruthy()
  })
})
