/**
 * Compact-transcript builder (Work Item G.13).
 *
 * Problem: app/api/generate-feedback/route.ts:275-286 (pre-G.13) kept
 * only the first 2500 + last 2500 characters of the interview
 * transcript when the total exceeded 6000 chars. Middle questions
 * vanished entirely — Claude saw the opening and closing but had no
 * evidence for Qs 3-7 of a 10-question session. `ideal_answers` for
 * those middle questions were synthesized with zero transcript
 * grounding, which produces generic coaching copy users described as
 * "scores are fine but the feedback feels shallow."
 *
 * Fix: replace head/tail slicing with a per-question summary format:
 *   - Every Q emits a one-line summary: "Qn: {interviewer-text-80-chars}
 *      | candidate summary (from evaluate-answer.answerSummary) | k words"
 *   - The 2 weakest questions (by per-Q average score) ALSO get the
 *     full candidate answer verbatim — these are the questions Claude
 *     will generate ideal_answers for, so it needs the actual text.
 *   - Hard char budget prevents unbounded growth on long interviews.
 *
 * Pure and deterministic. Caller flag-gates via scoring_v2_compact_
 * transcript; the compactor itself always produces the same output
 * for the same input.
 */

import type { TranscriptEntry, AnswerEvaluation } from '@shared/types'

/** Max chars the compact-transcript output can occupy. 8k ≈ 2k tokens
 *  — leaves plenty of headroom for the rest of the feedback prompt
 *  (system rules + profile context + JD + resume ≈ 3-4k more). */
export const COMPACT_TRANSCRIPT_BUDGET_CHARS = 8000

/** Per-question summary line cap. Keeps each line readable and bounded. */
const PER_Q_LINE_CHAR_CAP = 220

/** Number of weakest questions to include verbatim for ideal_answers. */
const FULL_DETAIL_WEAKEST_COUNT = 2

export interface CompactTranscriptInput {
  transcript: TranscriptEntry[]
  evaluations: AnswerEvaluation[]
  budgetChars?: number
}

export interface CompactTranscriptResult {
  /** Text block ready to be dropped into the user prompt. */
  text: string
  /** 0-based indices of the questions included in full-detail form. */
  fullDetailIndices: number[]
  /** Count of questions summarized (vs included verbatim). */
  summarizedCount: number
  /** True if any content had to be dropped/elided to fit the budget. */
  budgetHit: boolean
}

/**
 * Produce the compact-transcript block. Always deterministic.
 *
 * Shape:
 *   === Per-question summary (N questions) ===
 *   Q1 [ok, avg 72]: <topic> | <answerSummary> | 118 words
 *   Q2 [ok, avg 58]: ...
 *   ...
 *
 *   === Full detail for the 2 weakest answers ===
 *   Q5 (avg 41):
 *     Interviewer: <full text>
 *     Candidate: <full text>
 *
 * Empty input returns an empty string with `budgetHit=false`.
 */
export function compactTranscript(input: CompactTranscriptInput): CompactTranscriptResult {
  const budget = input.budgetChars ?? COMPACT_TRANSCRIPT_BUDGET_CHARS
  const { transcript, evaluations } = input

  if (!transcript.length || !evaluations.length) {
    return { text: '', fullDetailIndices: [], summarizedCount: 0, budgetHit: false }
  }

  // Pair interviewer + candidate turns by questionIndex. The transcript
  // array has sequential entries; we use evaluations[i].questionIndex
  // as the index of each pair and match by finding the interviewer/
  // candidate turns in the transcript.
  const qaPairs = evaluations.map((ev) => {
    const interviewerTurn = transcript.find(
      (t) => t.speaker === 'interviewer' && t.questionIndex === ev.questionIndex,
    )
    const candidateTurn = transcript.find(
      (t) => t.speaker === 'candidate' && t.questionIndex === ev.questionIndex,
    )
    const perQAvg = Math.round(
      ((Number(ev.relevance) || 0) +
        (Number(ev.structure) || 0) +
        (Number(ev.specificity) || 0) +
        (Number(ev.ownership) || 0)) / 4,
    )
    const candidateText = candidateTurn?.text ?? ev.answer ?? ''
    const wordCount = candidateText.trim().split(/\s+/).filter(Boolean).length
    return {
      questionIndex: ev.questionIndex,
      perQAvg,
      interviewerText: interviewerTurn?.text ?? ev.question ?? '',
      candidateText,
      answerSummary: ev.answerSummary ?? '',
      wordCount,
      status: ev.status ?? 'ok',
    }
  })

  // Identify the N weakest answered questions (status != 'failed', so
  // we don't hand Claude a fabricated placeholder as "weakest"). Tie-
  // broken by questionIndex so output is deterministic.
  const weakestCandidates = qaPairs
    .filter((p) => p.status !== 'failed')
    .sort((a, b) => a.perQAvg - b.perQAvg || a.questionIndex - b.questionIndex)
    .slice(0, FULL_DETAIL_WEAKEST_COUNT)
  const fullDetailIndices = weakestCandidates.map((p) => p.questionIndex).sort((a, b) => a - b)
  const fullDetailSet = new Set(fullDetailIndices)

  // Per-question summary block.
  const summaryLines: string[] = []
  summaryLines.push(`=== Per-question summary (${qaPairs.length} question${qaPairs.length === 1 ? '' : 's'}) ===`)
  for (const p of qaPairs) {
    // Topic = first 80 chars of the interviewer question, whitespace-normalized.
    const topic = p.interviewerText.trim().replace(/\s+/g, ' ').slice(0, 80)
    const sum = p.answerSummary.trim().replace(/\s+/g, ' ')
    const scoreTag = p.status === 'failed'
      ? 'failed'
      : p.status === 'truncated'
        ? `truncated, avg ${p.perQAvg}`
        : `avg ${p.perQAvg}`
    const line = `Q${p.questionIndex + 1} [${scoreTag}]: ${topic}${sum ? ` | ${sum}` : ''} | ${p.wordCount} words`
    summaryLines.push(line.length > PER_Q_LINE_CHAR_CAP ? `${line.slice(0, PER_Q_LINE_CHAR_CAP - 3)}...` : line)
  }
  const summaryBlock = summaryLines.join('\n')

  // Full-detail block for weakest answers.
  const detailLines: string[] = []
  if (weakestCandidates.length > 0) {
    detailLines.push('')
    detailLines.push(`=== Full detail for the ${weakestCandidates.length} weakest answer${weakestCandidates.length === 1 ? '' : 's'} (for ideal_answers) ===`)
    for (const p of weakestCandidates) {
      detailLines.push('')
      detailLines.push(`Q${p.questionIndex + 1} (avg ${p.perQAvg}):`)
      detailLines.push(`  Interviewer: ${p.interviewerText.trim()}`)
      detailLines.push(`  Candidate: ${p.candidateText.trim()}`)
    }
  }
  const detailBlock = detailLines.join('\n')

  // Assemble + enforce budget. If over budget, truncate the DETAIL block
  // first (summary block is the load-bearing content — it's what gives
  // Claude coverage of all questions). If still over, elide the summary
  // block tail with a marker.
  let assembled = summaryBlock + detailBlock
  let budgetHit = false
  if (assembled.length > budget) {
    budgetHit = true
    // Try dropping full-detail block first.
    if (summaryBlock.length <= budget) {
      assembled = `${summaryBlock}\n\n[...full detail omitted for brevity (${detailBlock.length - 40} chars over budget)...]`
      if (assembled.length > budget) {
        assembled = summaryBlock.slice(0, budget - 40) + '\n[...truncated...]'
      }
    } else {
      // Pathological case — summary alone exceeds budget. Elide the tail.
      assembled = summaryBlock.slice(0, budget - 40) + '\n[...summary truncated...]'
      fullDetailIndices.length = 0
    }
  }

  return {
    text: assembled,
    fullDetailIndices,
    summarizedCount: qaPairs.length,
    budgetHit,
  }
}
