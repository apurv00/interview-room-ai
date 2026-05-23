/**
 * Format the score badge for a history row.
 *
 * Tri-state output the UI needs to distinguish:
 *   - scored:         render the numeric overall_score (0 included, not swallowed)
 *   - completed-pending: row is `completed` but feedback hasn't landed yet
 *                        (e.g. background Inngest job still running) — show
 *                        a "scoring" affordance instead of `--`
 *   - unavailable:    not-yet-completed / abandoned / in_progress — `--`
 *
 * UAT-011: prior code used `feedback?.overall_score || '--'` which collapsed
 * a legitimate 0 to `--` AND showed `--` for completed-but-still-scoring
 * sessions, making them look broken in the list.
 */

export interface ScoreSource {
  status: string
  feedback?: { overall_score?: number | null } | null
}

export interface ScoreDisplay {
  value: string
  title?: string
}

export function getScoreDisplay(s: ScoreSource): ScoreDisplay {
  const score = s.feedback?.overall_score
  if (score != null) {
    return { value: String(score) }
  }
  if (s.status === 'completed') {
    return { value: '…', title: 'Scoring in progress' }
  }
  return { value: '--' }
}
