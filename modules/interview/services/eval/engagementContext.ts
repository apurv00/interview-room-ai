import type { AnswerEvaluation } from '@shared/types'

/**
 * Engagement context builder for the post-interview feedback prompt.
 *
 * Extracted from `app/api/generate-feedback/route.ts` on 2026-04-24
 * because Next.js App Router route files (`route.ts` under `app/api/*`)
 * only permit HTTP method handlers (`GET`, `POST`, etc.) and a fixed
 * list of route-config exports (`runtime`, `dynamic`, `revalidate`,
 * `fetchCache`, `preferredRegion`, `maxDuration`). Adding a named
 * helper export triggers a Next.js build-time type error
 * (`"computeEngagementContext" is not a valid Route export field`).
 * `tsc --noEmit` does NOT catch this — the validator runs only inside
 * `next build`. Codex P0 on PR #319.
 *
 * Moving the helper here preserves the testability win (targeted unit
 * tests can import it directly) without polluting the route file's
 * export surface.
 *
 * Audit P2 (2026-04-24) — null-through speech metrics:
 *
 * Before this fix the helper used `Number(m.wpm) || 0` for each metric,
 * which silently turned `undefined` / `null` / `NaN` into `0`. The
 * prompt then rendered "WPM=0" as if the candidate had spoken at zero
 * words per minute, and Claude scored Communication against that
 * fabricated baseline. The same `|| 0` in the half-average reducers
 * biased the first-half → second-half trend line to `0` whenever any
 * half had all-missing data, producing misleading "0.0% → 5.0%"
 * improvement claims when the truth was no first-half data.
 *
 * Fix: `coerceMetric` returns `null` for missing/non-finite inputs;
 * `averageDefined` skips nulls from both numerator and denominator.
 * Per-Q lines render "not available" instead of "0" for missing
 * fields; trend lines render "n/a" for empty halves.
 */

/**
 * Runtime coercion of a speech metric to `number | null`.
 *
 * `null` means "we don't know" — callers MUST render it as "not
 * available", NOT "0". `SpeechMetrics` in shared/types.ts types each
 * field as strict `number`, but the route's param widens to
 * `Record<string, unknown>[]` to tolerate older clients / partial
 * rows, and silently-zero coercion was biasing the feedback prompt.
 */
export function coerceMetric(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return n
}

/**
 * Average across defined values only. Excludes `null` entries from
 * BOTH the numerator and denominator. Returns `null` when every
 * entry is null (all-missing half) so the caller emits "not
 * available" instead of a biased 0.
 */
export function averageDefined(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null)
  if (nums.length === 0) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

export function computeEngagementContext(
  speechMetrics: Record<string, unknown>[],
  evaluations: AnswerEvaluation[],
  pressureIdx: number,
): { perQSummary: string; pressureContext: string } {
  if (!speechMetrics.length) {
    return { perQSummary: 'No per-question speech metrics available.', pressureContext: '' }
  }

  const perQ = speechMetrics.map((m, i) => {
    const wpm = coerceMetric(m.wpm)
    const fillerRate = coerceMetric(m.fillerRate)
    const totalWords = coerceMetric(m.totalWords)
    const durationMinutes = coerceMetric(m.durationMinutes)
    // Missing fields render as "not available" — NOT "0". The prompt
    // is fed to Claude as ground-truth evidence; a fake "0 WPM" used
    // to drag the Communication score down on a candidate whose
    // audio pipeline just hadn't reported metrics.
    const wpmStr = wpm === null ? 'not available' : String(Math.round(wpm))
    const fillerStr = fillerRate === null ? 'not available' : `${(fillerRate * 100).toFixed(1)}%`
    const wordsStr = totalWords === null ? 'not available' : String(Math.round(totalWords))
    const durationStr = durationMinutes === null ? 'not available' : `${durationMinutes.toFixed(1)}min`
    return `  Q${i + 1}: WPM=${wpmStr}, filler_rate=${fillerStr}, words=${wordsStr}, duration=${durationStr}`
  })

  const halfIdx = Math.ceil(speechMetrics.length / 2)
  const firstHalf = speechMetrics.slice(0, halfIdx)
  const secondHalf = speechMetrics.slice(halfIdx)

  // Half-averages also skip missing entries from both numerator and
  // denominator. `averageDefined` returns `null` when every entry is
  // missing for that half, which propagates into the trend string
  // below as "n/a".
  const avgFillerFirst = averageDefined(firstHalf.map((m) => coerceMetric(m.fillerRate)))
  const avgFillerSecond = averageDefined(secondHalf.map((m) => coerceMetric(m.fillerRate)))
  const avgWordsFirst = averageDefined(firstHalf.map((m) => coerceMetric(m.totalWords)))
  const avgWordsSecond = averageDefined(secondHalf.map((m) => coerceMetric(m.totalWords)))

  const fmtFiller = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`)
  const fmtWords = (v: number | null) => (v === null ? 'n/a' : v.toFixed(0))
  const fillerTrend = `${fmtFiller(avgFillerFirst)} → ${fmtFiller(avgFillerSecond)}`
  const wordsTrend = `${fmtWords(avgWordsFirst)} → ${fmtWords(avgWordsSecond)}`

  let pressureContext = ''
  if (pressureIdx < evaluations.length) {
    const pEval = evaluations[pressureIdx]
    const pMetrics = speechMetrics[pressureIdx]
    if (pEval && pMetrics) {
      // G.5: skip status='failed' rows in the normal-avg denominator
      // so the pressure-vs-normal delta isn't diluted by fabricated
      // 60/55/55/60 placeholders. Mirrors the G.4 aggregation policy.
      const normalRows = evaluations.filter(
        (e, i) => i !== pressureIdx && e.status !== 'failed',
      )
      const avgNormalScore = normalRows.length > 0
        ? normalRows.reduce((s, e) => {
            const rel = Number(e.relevance) ?? 0
            const str = Number(e.structure) ?? 0
            const spc = Number(e.specificity) ?? 0
            const own = Number(e.ownership) ?? 0
            return s + (rel + str + spc + own) / 4
          }, 0) / normalRows.length
        : 0
      // Don't report a pressure score for a failed pressure row — the
      // number would be the placeholder, not the candidate's actual
      // pressure performance. Drop the context instead.
      if (pEval.status === 'failed') {
        pressureContext = `\nPressure question (Q${pressureIdx + 1}) could not be scored — AI evaluation failed on that answer.`
      } else {
        const pressureScore = ((Number(pEval.relevance) ?? 0) + (Number(pEval.structure) ?? 0) + (Number(pEval.specificity) ?? 0) + (Number(pEval.ownership) ?? 0)) / 4
        pressureContext = `\nPressure question (Q${pressureIdx + 1}) avg score: ${pressureScore.toFixed(0)} vs normal avg: ${avgNormalScore.toFixed(0)}`
      }
    }
  }

  return {
    perQSummary: `Per-question speech patterns:\n${perQ.join('\n')}\n\nTrends (first-half → second-half):\n  Filler rate: ${fillerTrend}\n  Avg answer length: ${wordsTrend} words`,
    pressureContext,
  }
}
