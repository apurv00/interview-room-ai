'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import ScoreSummaryHeader from '@feedback/components/ScoreSummaryHeader'
import QuestionHeatmap from '@feedback/components/QuestionHeatmap'
import QuestionBreakdown, {
  type QuestionBreakdownSortOrder,
} from '@feedback/components/QuestionBreakdown'
import type { StoredInterviewData } from '@shared/types'

interface ScoresTabProps {
  data: StoredInterviewData
}

export default function ScoresTab({ data }: ScoresTabProps) {
  const [sortOrder, setSortOrder] = useState<QuestionBreakdownSortOrder>('index')
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Heatmap expects { questionNumber, question, answer, relevance, structure,
  // specificity, ownership, flags } and EXCLUDES failed evals so the grid
  // doesn't show 50/50/50/50 fallback rows. Mirror OverviewTab's evalData
  // shape exactly so the heatmap behaves the same as it did on the old tab.
  const heatmapEvaluations = useMemo(() => {
    return (data.evaluations || [])
      .map((e, i) => {
        const ev = e as unknown as Record<string, unknown>
        return {
          questionNumber: i + 1,
          status: ev.status as string | undefined,
          question: (ev.question as string) || '',
          answer: (ev.answer as string) || '',
          relevance: Number(ev.relevance) || 0,
          structure: Number(ev.structure) || 0,
          specificity: Number(ev.specificity) || 0,
          ownership: Number(ev.ownership) || 0,
          flags: (ev.flags as string[]) || [],
        }
      })
      .filter((row) => row.status !== 'failed')
  }, [data.evaluations])

  const handleHeatmapCellClick = useCallback(
    (questionIndex: number) => {
      // questionIndex from heatmap is the FILTERED-array position, but
      // QuestionBreakdown is keyed off the ORIGINAL evaluation index. Map back
      // by walking the unfiltered evaluations and counting non-failed rows.
      const allEvals = data.evaluations || []
      let filteredCount = 0
      let originalIdx = -1
      for (let i = 0; i < allEvals.length; i++) {
        const status = (allEvals[i] as unknown as { status?: string }).status
        if (status !== 'failed') {
          if (filteredCount === questionIndex) {
            originalIdx = i
            break
          }
          filteredCount++
        }
      }
      if (originalIdx < 0) return

      setExpandedIdx(originalIdx)
      requestAnimationFrame(() => {
        const row = containerRef.current?.querySelector(
          `[data-question-idx="${originalIdx}"]`
        ) as HTMLElement | null
        row?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    },
    [data.evaluations]
  )

  return (
    <div ref={containerRef} className="space-y-5 animate-fade-in">
      <ScoreSummaryHeader evaluations={data.evaluations || []} />

      {heatmapEvaluations.length > 0 && (
        <section className="surface-card-bordered p-4 sm:p-5">
          <h3 className="text-subheading text-[#0f1419] mb-3">Score Heatmap</h3>
          <QuestionHeatmap
            evaluations={heatmapEvaluations}
            transcript={data.transcript}
            onCellClick={handleHeatmapCellClick}
            interviewType={data.config?.interviewType}
          />
        </section>
      )}

      {(data.evaluations?.length ?? 0) > 1 && (
        <div className="flex items-center justify-end gap-2">
          <label htmlFor="scores-sort" className="text-caption text-[#71767b]">
            Sort
          </label>
          <select
            id="scores-sort"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as QuestionBreakdownSortOrder)}
            className="text-sm bg-white border border-[#e1e8ed] rounded-lg px-3 py-1.5 text-[#0f1419] hover:border-[#cfd9de] focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          >
            <option value="index">Question order</option>
            <option value="asc">Lowest score first</option>
            <option value="desc">Highest score first</option>
          </select>
        </div>
      )}

      <QuestionBreakdown
        transcript={data.transcript}
        evaluations={data.evaluations}
        sortOrder={sortOrder}
        expandedIdx={expandedIdx}
        onExpandedChange={setExpandedIdx}
        interviewType={data.config?.interviewType}
      />
    </div>
  )
}
