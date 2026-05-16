'use client'

import { useMemo, type MouseEvent } from 'react'
import type { AnswerEvaluation } from '@shared/types'
import type { ProsodySegment, FacialSegment } from '@shared/types/multimodal'
import { FONT_MONO } from './tokens'
import {
  buildExclusionFootnote,
  buildMatrixData,
  QUADRANT_LABEL,
  type Quadrant,
} from './deliveryMatrix'

interface QuestionMarker {
  label: string
  offsetSeconds: number
}

interface DeliveryContentMatrixProps {
  /** Per-question evaluation rows (filtered to non-failed by the caller). */
  evaluations?: AnswerEvaluation[]
  /** Per-Q prosody segments — provides confidenceMarker for delivery score. */
  prosodySegments?: ProsodySegment[]
  /** Per-Q facial segments — provides eye contact + head stability. */
  facialSegments?: FacialSegment[]
  /** Question markers, aligned by index with evaluations/prosody/facial. */
  questions: QuestionMarker[]
  /** Click a dot → seek video to that Q's lede position (offsetSeconds + 8s,
   *  mirroring the QuestionChapterRow contract). Optional — when absent the
   *  dots are read-only. */
  onSeek?: (sec: number) => void
}

/**
 * Quadrant accents. Stones for the muted axes, with the "nailed it"
 * quadrant getting a slight emerald wash and the "off on both" quadrant
 * a soft rose wash — pre-attentive coding so the eye lands first on
 * the two extreme states without needing to read the labels.
 */
const QUADRANT_FILL: Record<Quadrant, string> = {
  'nailed-it': 'rgba(16, 185, 129, 0.06)',    // emerald-500 @ 6%
  'bluffed-confidently': 'transparent',
  'knew-but-mumbled': 'transparent',
  'off-on-both': 'rgba(244, 63, 94, 0.05)',   // rose-500 @ 5%
}

const QUADRANT_DOT_FILL: Record<Quadrant, string> = {
  'nailed-it': '#059669',           // emerald-600
  'bluffed-confidently': '#d97706', // amber-600
  'knew-but-mumbled': '#7c3aed',    // violet-600
  'off-on-both': '#dc2626',         // red-600
}

/**
 * Plot geometry. Inset accounts for axis labels.
 *
 * We use a single SVG (300×300 internal viewBox) and let CSS scale it
 * to the container. Internal coordinates make math easy; nothing else
 * in the multimodal panel uses SVG so cohesion isn't a concern.
 */
const PLOT_SIZE = 300
const PLOT_PAD_X = 28 // room for Y-axis label band
const PLOT_PAD_Y = 28 // room for X-axis label band
const PLOT_PAD_RIGHT = 8
const PLOT_PAD_TOP = 8

function plotX(contentScore: number): number {
  // contentScore 0..100 → PLOT_PAD_X..(PLOT_SIZE - PLOT_PAD_RIGHT)
  const innerWidth = PLOT_SIZE - PLOT_PAD_X - PLOT_PAD_RIGHT
  return PLOT_PAD_X + (contentScore / 100) * innerWidth
}

function plotY(deliveryScore: number): number {
  // deliveryScore 0..100 → (PLOT_SIZE - PLOT_PAD_Y) downto PLOT_PAD_TOP
  // SVG y grows downward, so high delivery = small y.
  const innerHeight = PLOT_SIZE - PLOT_PAD_TOP - PLOT_PAD_Y
  return PLOT_SIZE - PLOT_PAD_Y - (deliveryScore / 100) * innerHeight
}

/**
 * Delivery × Content matrix — the headline insight of the Multimodal
 * tab. 2×2 quadrant scatter of per-question content score (X) against
 * composite delivery score (Y), with the four quadrants named for
 * their behavior pattern.
 *
 * Round 5d feature #1.
 *
 * Click contract: dots are non-interactive `<circle>`s. A single
 * delegated click on the SVG reads `data-q` off the clicked target via
 * `closest()` and seeks. This matches the EngagementHeatmap pattern
 * we landed in Round 5c fix-ups (Codex P2 — avoid N tab stops in the
 * SR rotor for N dots).
 */
export default function DeliveryContentMatrix({
  evaluations,
  prosodySegments,
  facialSegments,
  questions,
  onSeek,
}: DeliveryContentMatrixProps) {
  const data = useMemo(
    () =>
      buildMatrixData({
        evaluations,
        prosodySegments,
        facialSegments,
        questions,
      }),
    [evaluations, prosodySegments, facialSegments, questions],
  )

  // Group by quadrant so a small per-quadrant population summary can sit
  // under the chart — gives users an at-a-glance read of the dominant
  // pattern without forcing them to count dots.
  const quadrantCounts = useMemo(() => {
    const c: Record<Quadrant, number> = {
      'nailed-it': 0,
      'bluffed-confidently': 0,
      'knew-but-mumbled': 0,
      'off-on-both': 0,
    }
    for (const p of data.points) c[p.quadrant] += 1
    return c
  }, [data.points])

  // Delegated click — closest `[data-q]` ancestor of the click target.
  const onSvgClick = (e: MouseEvent<SVGSVGElement>) => {
    if (!onSeek) return
    const target = (e.target as Element).closest('[data-q]') as HTMLElement | null
    if (!target) return
    const qIdx = Number(target.getAttribute('data-q'))
    if (!Number.isFinite(qIdx)) return
    const q = questions[qIdx]
    if (!q) return
    // Same +8s lede skip as QuestionChapterRow / ExpressionStrip.
    onSeek(q.offsetSeconds + 8)
  }

  if (questions.length === 0) {
    return (
      <p className="text-sm text-stone-400 italic p-2">
        No questions in this session — matrix unavailable.
      </p>
    )
  }
  if (data.points.length === 0) {
    return (
      <div className="space-y-2 p-2">
        <p className="text-sm text-stone-400 italic">
          Not enough data to plot the matrix.
        </p>
        {data.excluded.length > 0 && (
          <p className="text-[11px] text-stone-400" data-testid="matrix-footnote">
            {buildExclusionFootnote(data.excluded)}
          </p>
        )}
      </div>
    )
  }

  const midX = plotX(50)
  const midY = plotY(50)

  return (
    <div className="flex flex-col gap-3" data-testid="delivery-content-matrix">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[13px] font-semibold text-stone-900 -tracking-[0.01em]">
          Delivery × Content
        </h3>
        <span
          className="text-[10px] uppercase tracking-[0.06em] text-stone-400"
          style={{ fontFamily: FONT_MONO }}
        >
          per question
        </span>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${PLOT_SIZE} ${PLOT_SIZE}`}
          width="100%"
          className={onSeek ? 'cursor-pointer' : undefined}
          onClick={onSvgClick}
          role="img"
          aria-label="Delivery vs Content scatter — each question plotted by its content score (x) and composite delivery score (y)"
        >
          {/* Quadrant fills — emerald wash top-right (nailed it), rose wash
              bottom-left (off on both). The other two stay transparent so
              the chart doesn't feel like a heatmap. */}
          <rect x={midX} y={PLOT_PAD_TOP} width={PLOT_SIZE - PLOT_PAD_RIGHT - midX} height={midY - PLOT_PAD_TOP} fill={QUADRANT_FILL['nailed-it']} />
          <rect x={PLOT_PAD_X} y={PLOT_PAD_TOP} width={midX - PLOT_PAD_X} height={midY - PLOT_PAD_TOP} fill={QUADRANT_FILL['bluffed-confidently']} />
          <rect x={midX} y={midY} width={PLOT_SIZE - PLOT_PAD_RIGHT - midX} height={PLOT_SIZE - PLOT_PAD_Y - midY} fill={QUADRANT_FILL['knew-but-mumbled']} />
          <rect x={PLOT_PAD_X} y={midY} width={midX - PLOT_PAD_X} height={PLOT_SIZE - PLOT_PAD_Y - midY} fill={QUADRANT_FILL['off-on-both']} />

          {/* Plot border */}
          <rect
            x={PLOT_PAD_X}
            y={PLOT_PAD_TOP}
            width={PLOT_SIZE - PLOT_PAD_X - PLOT_PAD_RIGHT}
            height={PLOT_SIZE - PLOT_PAD_TOP - PLOT_PAD_Y}
            fill="none"
            stroke="#e7e5e4"
            strokeWidth="1"
          />

          {/* Mid-line crosshairs */}
          <line x1={midX} x2={midX} y1={PLOT_PAD_TOP} y2={PLOT_SIZE - PLOT_PAD_Y} stroke="#d6d3d1" strokeDasharray="2,3" strokeWidth="1" />
          <line x1={PLOT_PAD_X} x2={PLOT_SIZE - PLOT_PAD_RIGHT} y1={midY} y2={midY} stroke="#d6d3d1" strokeDasharray="2,3" strokeWidth="1" />

          {/* Quadrant labels — small, in stone-500, anchored to the corners. */}
          <text x={PLOT_SIZE - PLOT_PAD_RIGHT - 4} y={PLOT_PAD_TOP + 12} textAnchor="end" fontSize="9" fill="#78716c" fontFamily={FONT_MONO} data-testid="quadrant-label-nailed-it">
            {QUADRANT_LABEL['nailed-it']}
          </text>
          <text x={PLOT_PAD_X + 4} y={PLOT_PAD_TOP + 12} textAnchor="start" fontSize="9" fill="#78716c" fontFamily={FONT_MONO} data-testid="quadrant-label-bluffed-confidently">
            {QUADRANT_LABEL['bluffed-confidently']}
          </text>
          <text x={PLOT_SIZE - PLOT_PAD_RIGHT - 4} y={PLOT_SIZE - PLOT_PAD_Y - 4} textAnchor="end" fontSize="9" fill="#78716c" fontFamily={FONT_MONO} data-testid="quadrant-label-knew-but-mumbled">
            {QUADRANT_LABEL['knew-but-mumbled']}
          </text>
          <text x={PLOT_PAD_X + 4} y={PLOT_SIZE - PLOT_PAD_Y - 4} textAnchor="start" fontSize="9" fill="#78716c" fontFamily={FONT_MONO} data-testid="quadrant-label-off-on-both">
            {QUADRANT_LABEL['off-on-both']}
          </text>

          {/* Axis labels */}
          <text
            x={PLOT_SIZE / 2}
            y={PLOT_SIZE - 4}
            textAnchor="middle"
            fontSize="10"
            fill="#57534e"
            fontFamily={FONT_MONO}
          >
            Content score →
          </text>
          <text
            x={10}
            y={PLOT_SIZE / 2}
            textAnchor="middle"
            fontSize="10"
            fill="#57534e"
            fontFamily={FONT_MONO}
            transform={`rotate(-90 10 ${PLOT_SIZE / 2})`}
          >
            Delivery score →
          </text>

          {/* Dots — non-interactive; the parent <svg> owns the click via
              delegation. data-q carries the question index. */}
          {data.points.map((p) => {
            const cx = plotX(p.contentScore)
            const cy = plotY(p.deliveryScore)
            const fill = QUADRANT_DOT_FILL[p.quadrant]
            return (
              <g
                key={p.questionIndex}
                data-q={p.questionIndex}
                data-quadrant={p.quadrant}
                data-testid={`matrix-dot-${p.questionLabel}`}
              >
                <circle
                  cx={cx}
                  cy={cy}
                  r={10}
                  fill={fill}
                  fillOpacity="0.18"
                />
                <circle
                  cx={cx}
                  cy={cy}
                  r={5}
                  fill={fill}
                />
                <text
                  x={cx}
                  y={cy + 2.5}
                  textAnchor="middle"
                  fontSize="7"
                  fontWeight="700"
                  fill="white"
                  fontFamily={FONT_MONO}
                  style={{ pointerEvents: 'none' }}
                >
                  {p.questionLabel.replace(/^Q/i, '')}
                </text>
                <title>
                  {`${p.questionLabel} · ${QUADRANT_LABEL[p.quadrant]} · content ${Math.round(p.contentScore)} / delivery ${Math.round(p.deliveryScore)}`}
                </title>
              </g>
            )
          })}
        </svg>
      </div>

      {/* Per-quadrant population summary — quick read of the dominant
          pattern without forcing the user to count dots. Only quadrants
          with ≥1 hit are listed. */}
      <div
        className="flex flex-wrap gap-x-3 gap-y-1 text-[10px]"
        style={{ fontFamily: FONT_MONO }}
        data-testid="matrix-quadrant-summary"
      >
        {(Object.keys(quadrantCounts) as Quadrant[])
          .filter((q) => quadrantCounts[q] > 0)
          .map((q) => (
            <span key={q} className="inline-flex items-center gap-1.5 text-stone-500">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: QUADRANT_DOT_FILL[q] }}
                aria-hidden="true"
              />
              {quadrantCounts[q]} {QUADRANT_LABEL[q]}
            </span>
          ))}
      </div>

      {data.excluded.length > 0 && (
        <p
          className="text-[11px] italic text-stone-400"
          data-testid="matrix-footnote"
        >
          {buildExclusionFootnote(data.excluded)}
        </p>
      )}
    </div>
  )
}
