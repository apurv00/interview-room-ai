'use client'

import { useMemo } from 'react'
import { Eye, Mic, Brain, Lightbulb, Play } from 'lucide-react'
import type { TimelineEvent, FusionSummary } from '@shared/types/multimodal'
import type { FeedbackData } from '@shared/types'
import { categorizeTip, type TipCategory } from '@interview/utils/categorizeTip'
import { parseQuestionRefs } from '@interview/utils/parseQuestionRefs'
import TextWithQuestionChips from '@interview/components/feedback/TextWithQuestionChips'

interface CoachingPanelProps {
  fusionSummary: FusionSummary
  timeline: TimelineEvent[]
  onSeek: (seconds: number) => void
  hideMoments?: boolean
  /** Optional: drill recommendations for the "Practice this →" cross-link. */
  drillRecommendations?: FeedbackData['drill_recommendations']
  /** Click handler for Q-chips parsed out of tip text. */
  onQuestionClick?: (questionIndex: number) => void
  /** Highest valid question index for chip range validation. */
  maxQuestionIndex?: number
  /** Click handler for "Practice this →" links — receives the matched drill index. */
  onPracticeClick?: (drillIndex: number) => void
}

const SIGNAL_ICONS: Record<string, React.ReactNode> = {
  audio: <Mic className="w-4 h-4" />,
  facial: <Eye className="w-4 h-4" />,
  content: <Brain className="w-4 h-4" />,
  fused: <Lightbulb className="w-4 h-4" />,
}

const SIGNAL_COLORS: Record<string, string> = {
  audio: 'text-purple-600',
  facial: 'text-emerald-600',
  content: 'text-blue-600',
  fused: 'text-amber-600',
}

const CATEGORY_BADGE_STYLES: Record<TipCategory, string> = {
  Behavior: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700',
  Communication: 'bg-purple-500/10 border-purple-500/30 text-purple-700',
  Content: 'bg-blue-500/10 border-blue-500/30 text-blue-700',
  General: 'bg-[#f1f5f9] border-[#e1e8ed] text-[#536471]',
}

/**
 * Phase A heuristic: a tip is "for" a drill when the parsed Q-refs from the tip
 * intersect with Q-refs parsed from the drill description, OR when the tip's
 * category aligns with the drill's skillArea via keyword match. Phase B
 * replaces the keyword side with a structured `targetQuestions` field on
 * drill_recommendations and a `category` field on coaching tips.
 */
function findMatchingDrillIndex(
  tip: string,
  category: TipCategory,
  drills: FeedbackData['drill_recommendations']
): number | null {
  if (!drills || drills.length === 0) return null
  const tipQs = new Set(parseQuestionRefs(tip))

  // First pass: question-overlap match (strongest signal).
  if (tipQs.size > 0) {
    const tipQList = Array.from(tipQs)
    for (let i = 0; i < drills.length; i++) {
      const drillQs = new Set(parseQuestionRefs(drills[i].description))
      for (const q of tipQList) {
        if (drillQs.has(q)) return i
      }
    }
  }

  // Second pass: skillArea keyword overlap.
  const lcCategory = category.toLowerCase()
  for (let i = 0; i < drills.length; i++) {
    const skill = drills[i].skillArea?.toLowerCase() || ''
    if (
      (category === 'Behavior' && /(eye|body|gesture|posture|expression)/i.test(skill)) ||
      (category === 'Communication' && /(pace|filler|pause|delivery|speak|tone)/i.test(skill)) ||
      (category === 'Content' && /(star|structure|specific|ownership|story|answer)/i.test(skill)) ||
      (lcCategory !== 'general' && skill.includes(lcCategory))
    ) {
      return i
    }
  }
  return null
}

interface AnnotatedTip {
  text: string
  category: TipCategory
  drillIndex: number | null
}

export default function CoachingPanel({
  fusionSummary,
  timeline,
  onSeek,
  hideMoments,
  drillRecommendations,
  onQuestionClick,
  maxQuestionIndex,
  onPracticeClick,
}: CoachingPanelProps) {
  const coachingEvents = timeline.filter((e) => e.type === 'coaching_tip')
  const improvementEvents = fusionSummary.improvementMoments || []

  const tips: AnnotatedTip[] = useMemo(() => {
    // Phase B (2026-05-16): prefer the structured `coachingTipsRich` field
    // (LLM-emitted category + 0-based questionIndex per tip). Falls back to
    // Phase A's heuristic categorization (categorizeTip) + regex Q-ref
    // parsing for old DB rows that pre-date Phase B.
    const rich = fusionSummary.coachingTipsRich
    if (rich && rich.length > 0) {
      return rich.map((entry) => ({
        text: entry.text,
        category: entry.category as TipCategory,
        // findMatchingDrillIndex still uses the (text, category) signal — the
        // structured `questionIndex` improves chip-rendering accuracy via
        // TextWithQuestionChips, but the drill-match heuristic stays the same.
        drillIndex: findMatchingDrillIndex(entry.text, entry.category as TipCategory, drillRecommendations),
      }))
    }
    return (fusionSummary.coachingTips || []).map((tip) => {
      const category = categorizeTip(tip)
      return {
        text: tip,
        category,
        drillIndex: findMatchingDrillIndex(tip, category, drillRecommendations),
      }
    })
  }, [fusionSummary.coachingTips, fusionSummary.coachingTipsRich, drillRecommendations])

  return (
    <div className="space-y-6">
      {/* Actionable coaching tips */}
      <div className="surface-card-bordered p-4 sm:p-5">
        <h4 className="text-subheading text-[#0f1419] mb-3">Coaching Tips</h4>
        <div className="space-y-2">
          {tips.map((tip, i) => (
            <div
              key={i}
              className="p-3 rounded-lg bg-blue-500/8 border border-blue-500/15 space-y-2"
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 text-blue-600 shrink-0">
                  <Lightbulb className="w-4 h-4" />
                </span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`text-[10px] uppercase tracking-wide font-bold px-2 py-0.5 rounded-md border ${CATEGORY_BADGE_STYLES[tip.category]}`}
                    >
                      {tip.category}
                    </span>
                  </div>
                  <p className="text-body text-[#0f1419] leading-relaxed">
                    <TextWithQuestionChips
                      text={tip.text}
                      onQuestionClick={onQuestionClick}
                      maxQuestionIndex={maxQuestionIndex}
                    />
                  </p>
                  {tip.drillIndex != null && onPracticeClick && (
                    <button
                      type="button"
                      onClick={() => onPracticeClick(tip.drillIndex!)}
                      className="text-xs font-medium text-brand-500 hover:underline inline-flex items-center gap-1"
                    >
                      Practice this →
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Improvement moments with "watch" buttons */}
      {!hideMoments && improvementEvents.length > 0 && (
        <div className="surface-card-bordered p-4 sm:p-5">
          <h4 className="text-subheading text-[#0f1419] mb-3">Key Moments to Review</h4>
          <div className="space-y-2">
            {improvementEvents.map((event, i) => (
              <div
                key={i}
                className="flex items-start gap-3 p-3 rounded-lg bg-[#f8fafc] border border-[#e1e8ed]"
              >
                <span className={SIGNAL_COLORS[event.signal] || 'text-[#71767b]'}>
                  {SIGNAL_ICONS[event.signal] || <Lightbulb className="w-4 h-4" />}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[#0f1419]">{event.title}</p>
                  <p className="text-caption text-[#71767b] mt-0.5">{event.description}</p>
                </div>
                <button
                  onClick={() => onSeek(event.startSec)}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-[#eff3f4] hover:bg-[#e1e8ed] text-[#536471] transition-colors shrink-0"
                  title={`Jump to ${formatTime(event.startSec)}`}
                >
                  <Play className="w-3 h-3" />
                  {formatTime(event.startSec)}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Timeline coaching tip events */}
      {!hideMoments && coachingEvents.length > 0 && (
        <div className="surface-card-bordered p-4 sm:p-5">
          <h4 className="text-subheading text-[#0f1419] mb-3">Coaching Moments</h4>
          <div className="space-y-2">
            {coachingEvents.map((event, i) => (
              <div
                key={i}
                className="flex items-start gap-3 p-3 rounded-lg bg-[#f8fafc] border border-[#eff3f4]"
              >
                <span className={SIGNAL_COLORS[event.signal] || 'text-[#71767b]'}>
                  {SIGNAL_ICONS[event.signal] || <Lightbulb className="w-4 h-4" />}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[#0f1419]">{event.title}</p>
                  <p className="text-caption text-[#8b98a5] mt-0.5">{event.description}</p>
                </div>
                <button
                  onClick={() => onSeek(event.startSec)}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-[#eff3f4] hover:bg-[#e1e8ed] text-[#536471] transition-colors shrink-0"
                >
                  <Play className="w-3 h-3" />
                  {formatTime(event.startSec)}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
