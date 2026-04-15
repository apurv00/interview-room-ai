/**
 * Work Item G.13 — compact-transcript builder.
 *
 * Unit tests for the pure `compactTranscript` helper. Integration
 * through /api/generate-feedback is covered by the existing
 * feedback test suites (the flag ramp just swaps the transcript
 * block; other behavior unchanged).
 */

import { describe, it, expect } from 'vitest'
import {
  compactTranscript,
  COMPACT_TRANSCRIPT_BUDGET_CHARS,
} from '@interview/services/eval/transcriptCompactor'
import type { TranscriptEntry, AnswerEvaluation } from '@shared/types'

function transcriptOf(n: number, avgWords = 40): TranscriptEntry[] {
  // Each question pair: one interviewer turn + one candidate turn.
  const out: TranscriptEntry[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      speaker: 'interviewer',
      text: `Interviewer question ${i + 1} about topic ${i + 1}.`,
      timestamp: i * 120,
      questionIndex: i,
    })
    out.push({
      speaker: 'candidate',
      text: Array.from({ length: avgWords }, (_, w) => `word${w}`).join(' ') + ` (answer for Q${i + 1})`,
      timestamp: i * 120 + 30,
      questionIndex: i,
    })
  }
  return out
}

function evalsOf(scoresPerQ: number[], status?: Record<number, 'ok' | 'truncated' | 'failed'>): AnswerEvaluation[] {
  return scoresPerQ.map((score, i) => ({
    questionIndex: i,
    question: `Interviewer question ${i + 1} about topic ${i + 1}.`,
    answer: Array.from({ length: 40 }, (_, w) => `word${w}`).join(' '),
    relevance: score, structure: score, specificity: score, ownership: score,
    answerSummary: `Summary for Q${i + 1}: the candidate discussed topic ${i + 1} at length.`,
    probeDecision: { shouldProbe: false },
    ...(status?.[i] && { status: status[i] }),
  }))
}

describe('compactTranscript (G.13)', () => {
  describe('happy path', () => {
    it('produces a per-question summary line for each answered question', () => {
      const transcript = transcriptOf(5)
      const evaluations = evalsOf([70, 65, 55, 80, 60])
      const r = compactTranscript({ transcript, evaluations })

      expect(r.summarizedCount).toBe(5)
      expect(r.text).toContain('=== Per-question summary (5 questions) ===')
      // Every question has a Q<n> line.
      for (let i = 1; i <= 5; i++) {
        expect(r.text).toContain(`Q${i}`)
      }
    })

    it('includes the answerSummary string on each line', () => {
      const transcript = transcriptOf(3)
      const evaluations = evalsOf([60, 70, 55])
      const r = compactTranscript({ transcript, evaluations })

      expect(r.text).toContain('Summary for Q1')
      expect(r.text).toContain('Summary for Q2')
      expect(r.text).toContain('Summary for Q3')
    })

    it('includes the word count on each line', () => {
      const transcript = transcriptOf(2, 50) // 50 "wordN" tokens per candidate answer
      const evaluations = evalsOf([70, 70])
      const r = compactTranscript({ transcript, evaluations })

      // The candidate answer is "word0 word1 ... word49 (answer for Q1)" →
      // 50 generated tokens + "(answer", "for", "Q1)" = 53 words after
      // /\s+/ split with empty-string filtering.
      expect(r.text).toMatch(/53 words/)
    })

    it('tags the avg score next to each Q', () => {
      const transcript = transcriptOf(2)
      const evaluations = evalsOf([72, 48])
      const r = compactTranscript({ transcript, evaluations })

      expect(r.text).toContain('Q1 [avg 72]')
      expect(r.text).toContain('Q2 [avg 48]')
    })
  })

  describe('full-detail block for weakest answers', () => {
    it('picks the 2 weakest (lowest-avg) questions for full detail', () => {
      const transcript = transcriptOf(5)
      const evaluations = evalsOf([80, 40, 75, 35, 70]) // weakest: Q4 (35), Q2 (40)
      const r = compactTranscript({ transcript, evaluations })

      expect(r.fullDetailIndices).toEqual([1, 3]) // 0-based, sorted
      expect(r.text).toContain('=== Full detail for the 2 weakest answers')
      expect(r.text).toContain('Q2 (avg 40)')
      expect(r.text).toContain('Q4 (avg 35)')
      // Should not include detail for the stronger Qs
      expect(r.text).not.toContain('Q1 (avg 80)')
      expect(r.text).not.toContain('Q3 (avg 75)')
      expect(r.text).not.toContain('Q5 (avg 70)')
    })

    it('includes the full interviewer + candidate text in the detail block', () => {
      const transcript = transcriptOf(3)
      const evaluations = evalsOf([80, 40, 75])
      const r = compactTranscript({ transcript, evaluations })

      // Q2 (weakest) full detail should have both turns verbatim
      expect(r.text).toContain('Interviewer: Interviewer question 2 about topic 2.')
      expect(r.text).toMatch(/Candidate: word0 word1/)
    })

    it('falls back to <2 when fewer than 2 answered questions exist', () => {
      const transcript = transcriptOf(1)
      const evaluations = evalsOf([50])
      const r = compactTranscript({ transcript, evaluations })

      expect(r.fullDetailIndices).toEqual([0])
      expect(r.text).toContain('=== Full detail for the 1 weakest answer')
    })

    it('excludes status="failed" rows from the weakest-candidate pool', () => {
      const transcript = transcriptOf(4)
      // Q1=failed (placeholder 57.5), Q2=real-weakest 40, Q3=60, Q4=50
      const evaluations = evalsOf(
        [60, 40, 70, 50],
        { 0: 'failed' },
      )
      const r = compactTranscript({ transcript, evaluations })

      // Failed row (Q1) should NOT be selected as weakest despite low placeholder score
      expect(r.fullDetailIndices).not.toContain(0)
      // Real weakest: Q2 (40), Q4 (50)
      expect(r.fullDetailIndices).toEqual([1, 3])
    })

    it('tags truncated rows in the summary line', () => {
      const transcript = transcriptOf(2)
      const evaluations = evalsOf([70, 60], { 1: 'truncated' })
      const r = compactTranscript({ transcript, evaluations })

      expect(r.text).toContain('Q2 [truncated, avg 60]')
    })

    it('tags failed rows in the summary line', () => {
      const transcript = transcriptOf(2)
      const evaluations = evalsOf([70, 60], { 0: 'failed' })
      const r = compactTranscript({ transcript, evaluations })

      expect(r.text).toContain('Q1 [failed]')
    })
  })

  describe('budget enforcement', () => {
    it('stays under the budget for a reasonable input', () => {
      const transcript = transcriptOf(10, 50)
      const evaluations = evalsOf(Array.from({ length: 10 }, (_, i) => 50 + i))
      const r = compactTranscript({ transcript, evaluations })

      expect(r.text.length).toBeLessThanOrEqual(COMPACT_TRANSCRIPT_BUDGET_CHARS)
      expect(r.budgetHit).toBe(false)
    })

    it('hits budget and elides detail for very long interviews', () => {
      // 20 questions with 200-word candidate answers → full detail will
      // push past 8k budget.
      const transcript = transcriptOf(20, 200)
      const evaluations = evalsOf(Array.from({ length: 20 }, (_, i) => 50 + i))
      const r = compactTranscript({ transcript, evaluations, budgetChars: 3000 })

      expect(r.budgetHit).toBe(true)
      expect(r.text.length).toBeLessThanOrEqual(3000)
      // Should still contain the summary section header
      expect(r.text).toContain('=== Per-question summary')
    })

    it('respects a caller-supplied custom budget', () => {
      const transcript = transcriptOf(5)
      const evaluations = evalsOf([70, 65, 55, 80, 60])
      const r = compactTranscript({
        transcript, evaluations, budgetChars: 500,
      })

      expect(r.text.length).toBeLessThanOrEqual(500)
    })
  })

  describe('edge inputs', () => {
    it('returns empty result on empty transcript', () => {
      const r = compactTranscript({ transcript: [], evaluations: evalsOf([70]) })
      expect(r.text).toBe('')
      expect(r.summarizedCount).toBe(0)
      expect(r.fullDetailIndices).toEqual([])
    })

    it('returns empty result on empty evaluations', () => {
      const r = compactTranscript({ transcript: transcriptOf(3), evaluations: [] })
      expect(r.text).toBe('')
      expect(r.summarizedCount).toBe(0)
    })

    it('handles evaluations without matching transcript turns (legacy data)', () => {
      // Evals exist but transcript was lost — use ev.answer as fallback
      const evaluations = evalsOf([70, 60])
      const r = compactTranscript({ transcript: [], evaluations })
      // Empty transcript short-circuits; but if we synthesize transcript
      // from ev.question / ev.answer path, still produces output.
      expect(r.text).toBe('')
    })

    it('normalizes multi-line interviewer questions to single lines in the SUMMARY block', () => {
      const transcript: TranscriptEntry[] = [
        { speaker: 'interviewer', text: 'What\nis\nyour greatest\nstrength?', timestamp: 0, questionIndex: 0 },
        { speaker: 'candidate', text: 'I persist under pressure.', timestamp: 10, questionIndex: 0 },
      ]
      const evaluations = evalsOf([75])
      const r = compactTranscript({ transcript, evaluations })

      // The summary-block Q1 line must be single-line with the bracketed
      // score tag. (The full-detail header also starts with "Q1" but uses
      // parentheses form "Q1 (avg 75):" — distinct from "Q1 [avg 75]:").
      const summaryLines = r.text.split('\n').filter((l) => /^Q1 \[/.test(l))
      expect(summaryLines.length).toBe(1)
      expect(summaryLines[0]).toMatch(/What is your greatest strength/)
    })
  })

  describe('determinism', () => {
    it('produces identical output for identical input', () => {
      const transcript = transcriptOf(4)
      const evaluations = evalsOf([70, 55, 80, 65])
      const a = compactTranscript({ transcript, evaluations })
      const b = compactTranscript({ transcript, evaluations })
      expect(a.text).toBe(b.text)
      expect(a.fullDetailIndices).toEqual(b.fullDetailIndices)
    })

    it('tie-breaks weakest selection by questionIndex (ascending)', () => {
      const transcript = transcriptOf(4)
      // Q1 and Q3 both score 50 — the tie should prefer the earlier index.
      const evaluations = evalsOf([50, 70, 50, 80])
      const r = compactTranscript({ transcript, evaluations })
      expect(r.fullDetailIndices).toEqual([0, 2])
    })
  })
})
