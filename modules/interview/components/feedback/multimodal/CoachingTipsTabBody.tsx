'use client'

import { useMemo } from 'react'
import { Lightbulb } from 'lucide-react'
import type { FusionSummary } from '@shared/types/multimodal'
import type { FeedbackData } from '@shared/types'
import { categorizeTip, type TipCategory } from '@interview/utils/categorizeTip'
import { parseQuestionRefs } from '@interview/utils/parseQuestionRefs'
import TextWithQuestionChips from '@interview/components/feedback/TextWithQuestionChips'
import { FONT_MONO } from './tokens'

interface CoachingTipsTabBodyProps {
  fusionSummary?: FusionSummary
  drillRecommendations?: FeedbackData['drill_recommendations']
  onQuestionClick?: (questionIndex: number) => void
  maxQuestionIndex?: number
  onPracticeClick?: (drillIndex: number) => void
}

interface AnnotatedTip {
  text: string
  category: TipCategory
  drillIndex: number | null
}

/**
 * Find a matching drill for a tip. Phase B's structured `targetQuestions`
 * is preferred when present; falls back to regex Q-overlap; falls back to
 * category/skillArea keyword overlap.
 */
function findMatchingDrillIndex(
  tip: string,
  category: TipCategory,
  tipQuestionIndex: number | undefined,
  drills: FeedbackData['drill_recommendations']
): number | null {
  if (!drills || drills.length === 0) return null

  // Strongest signal: structured Q-overlap (Phase B targetQuestions)
  if (tipQuestionIndex != null) {
    for (let i = 0; i < drills.length; i++) {
      const tq = drills[i].targetQuestions || []
      if (tq.includes(tipQuestionIndex)) return i
    }
  }

  // Next strongest: regex Q-overlap (Phase A fallback)
  const tipQs = new Set(parseQuestionRefs(tip))
  if (tipQs.size > 0) {
    const tipQList = Array.from(tipQs)
    for (let i = 0; i < drills.length; i++) {
      const drillQs = new Set([
        ...(drills[i].targetQuestions || []),
        ...parseQuestionRefs(drills[i].description),
      ])
      for (const q of tipQList) {
        if (drillQs.has(q)) return i
      }
    }
  }

  // Weakest: category/skillArea keyword overlap
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

const CATEGORY_STYLES: Record<TipCategory, { bg: string; fg: string }> = {
  Behavior: { bg: 'bg-emerald-50', fg: 'text-emerald-700' },
  Communication: { bg: 'bg-purple-50', fg: 'text-purple-700' },
  Content: { bg: 'bg-blue-50', fg: 'text-blue-700' },
  General: { bg: 'bg-stone-100', fg: 'text-stone-600' },
}

/**
 * Coaching tips list. Prefers Phase B's `coachingTipsRich` (LLM-emitted
 * category + structured questionIndex). Falls back to Phase A's pipeline
 * (`coachingTips: string[]` + heuristic `categorizeTip` + regex Q-ref).
 *
 * Each card: lightbulb + category tag + title (omitted; we use the tip text
 * as the body directly to match the prototype's simpler layout) + body with
 * inline Q-chips + "Practice this →" link when a matching drill exists.
 */
export default function CoachingTipsTabBody({
  fusionSummary,
  drillRecommendations,
  onQuestionClick,
  maxQuestionIndex,
  onPracticeClick,
}: CoachingTipsTabBodyProps) {
  const tips: Array<AnnotatedTip & { questionIndex?: number }> = useMemo(() => {
    const rich = fusionSummary?.coachingTipsRich
    if (rich && rich.length > 0) {
      return rich.map((entry) => ({
        text: entry.text,
        category: entry.category as TipCategory,
        questionIndex: entry.questionIndex,
        drillIndex: findMatchingDrillIndex(
          entry.text,
          entry.category as TipCategory,
          entry.questionIndex,
          drillRecommendations
        ),
      }))
    }
    return (fusionSummary?.coachingTips || []).map((tip) => {
      const category = categorizeTip(tip)
      return {
        text: tip,
        category,
        questionIndex: undefined,
        drillIndex: findMatchingDrillIndex(tip, category, undefined, drillRecommendations),
      }
    })
  }, [fusionSummary?.coachingTips, fusionSummary?.coachingTipsRich, drillRecommendations])

  if (tips.length === 0) {
    return <p className="text-sm text-stone-400 italic p-2">No coaching tips generated.</p>
  }

  return (
    <div className="flex flex-col gap-2.5">
      {tips.map((tip, i) => {
        const catStyle = CATEGORY_STYLES[tip.category]
        return (
          <div
            key={i}
            className="px-3.5 py-3 border border-stone-200 rounded-lg bg-white"
          >
            <div className="flex items-center gap-2 mb-1.5">
              <Lightbulb className="w-3.5 h-3.5 text-blue-600 shrink-0" />
              <span
                className={`text-[10px] font-semibold uppercase tracking-[0.08em] px-1.5 py-0.5 rounded ${catStyle.bg} ${catStyle.fg}`}
                style={{ fontFamily: FONT_MONO }}
              >
                {tip.category}
              </span>
              {tip.questionIndex != null && (
                <span
                  className="text-[10px] text-stone-400 ml-auto"
                  style={{ fontFamily: FONT_MONO }}
                >
                  Q{tip.questionIndex + 1}
                </span>
              )}
            </div>
            <div className="text-[12.5px] text-stone-600 leading-[1.5]">
              <TextWithQuestionChips
                text={tip.text}
                onQuestionClick={onQuestionClick}
                maxQuestionIndex={maxQuestionIndex}
              />
            </div>
            {tip.drillIndex != null && onPracticeClick && (
              <button
                type="button"
                onClick={() => onPracticeClick(tip.drillIndex!)}
                className="text-blue-600 text-xs font-medium cursor-pointer mt-2 hover:underline"
              >
                Practice this →
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
