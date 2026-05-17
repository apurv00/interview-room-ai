'use client'

/**
 * MomentumSparkline — tiny inline-SVG line chart showing a competency's
 * score trajectory across recent sessions.
 *
 * Pathway P2 Wave 3 (feature #2): renders under each blocker in
 * PathwayProgressPanel so the user can tell "this score is trending
 * up so my practice is paying off" vs "this score is flat or down
 * — current approach isn't working" without leaving the page.
 *
 * Why inline SVG (not a chart lib):
 *   - Adds zero bundle weight (charts are already on heavier surfaces
 *     like the Feedback page; the Pathway page should stay lean)
 *   - Lets the panel render N sparklines (one per blocker) without
 *     N chart-instance overhead
 *   - Keeps the data contract trivial (array of {score, at})
 *
 * Renders nothing when there are fewer than 2 points — a single dot
 * isn't a trend signal, and an empty plot would be visual noise.
 */
export default function MomentumSparkline({
  points,
  width = 84,
  height = 24,
  targetScore,
}: {
  points: Array<{ score: number; at: string }>
  width?: number
  height?: number
  /** Optional reference line drawn at this y-value (0-100 scale).
   *  Lets the panel show "you crossed the 70 target" visually. */
  targetScore?: number
}) {
  if (!points || points.length < 2) return null

  // Domain: y always normalized 0-100 so sparklines for different
  // competencies are visually comparable. x: equal-spaced over count
  // (we already sorted by timestamp in the view model).
  const pad = 2
  const innerW = width - pad * 2
  const innerH = height - pad * 2

  const xAt = (i: number) =>
    pad + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW)
  const yAt = (score: number) => pad + (1 - Math.max(0, Math.min(100, score)) / 100) * innerH

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yAt(p.score).toFixed(1)}`)
    .join(' ')

  const first = points[0].score
  const last = points[points.length - 1].score
  const trend: 'up' | 'down' | 'flat' = last - first > 2 ? 'up' : last - first < -2 ? 'down' : 'flat'
  const stroke =
    trend === 'up' ? '#059669' /* emerald-600 */ : trend === 'down' ? '#dc2626' /* red-600 */ : '#71717a' /* zinc-500 */

  return (
    <svg
      role="img"
      aria-label={`Recent scores: ${points.map((p) => p.score).join(', ')}. Trend ${trend}.`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0"
    >
      {typeof targetScore === 'number' && (
        <line
          x1={pad}
          x2={width - pad}
          y1={yAt(targetScore)}
          y2={yAt(targetScore)}
          stroke="#cbd5e1"
          strokeWidth={1}
          strokeDasharray="2 2"
        />
      )}
      <path d={pathD} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      {/* Last-point dot — provides a focal point and an obvious "current" marker */}
      <circle cx={xAt(points.length - 1)} cy={yAt(last)} r={2} fill={stroke} />
    </svg>
  )
}
