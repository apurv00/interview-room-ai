'use client'

import { motion } from 'framer-motion'

export type PathwayPhaseName =
  | 'assessment'
  | 'foundation'
  | 'building'
  | 'intensity'
  | 'mastery'
  | 'review'

const PHASE_LABELS: Record<PathwayPhaseName, { label: string; icon: string; blurb: string }> = {
  assessment: { label: 'Assessment', icon: '📋', blurb: 'Getting a baseline on your strengths' },
  foundation: { label: 'Foundation', icon: '🧱', blurb: 'Building the fundamentals' },
  building:   { label: 'Building',   icon: '🏗️', blurb: 'Layering in harder scenarios' },
  intensity:  { label: 'Intensity',  icon: '🔥', blurb: 'Full-length sessions under pressure' },
  mastery:    { label: 'Mastery',    icon: '🎓', blurb: 'Polishing signature stories' },
  review:     { label: 'Review',     icon: '🏅', blurb: 'Final dress rehearsals' },
}

const PHASE_ORDER: PathwayPhaseName[] = [
  'assessment', 'foundation', 'building', 'intensity', 'mastery', 'review',
]

export interface PhaseStatusProps {
  currentPhase: PathwayPhaseName
  sessionsCompleted: number
  sessionsInPhase: number
  sessionsUntilNextPhase: number
  progressInPhasePct: number
  nextPhase: PathwayPhaseName | null
}

export default function PhaseProgressCard({ phaseStatus }: { phaseStatus: PhaseStatusProps }) {
  const current = PHASE_LABELS[phaseStatus.currentPhase]
  const next = phaseStatus.nextPhase ? PHASE_LABELS[phaseStatus.nextPhase] : null
  const currentIdx = PHASE_ORDER.indexOf(phaseStatus.currentPhase)

  return (
    <motion.section
      className="surface-card-bordered p-5 sm:p-6"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-2xl" aria-hidden>{current.icon}</span>
            <h2 className="text-base font-semibold text-[#0f1419]">
              Phase {currentIdx + 1} of {PHASE_ORDER.length} · {current.label}
            </h2>
          </div>
          <p className="text-sm text-[#71767b]">{current.blurb}</p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-2xl font-bold text-[#0f1419]">{phaseStatus.sessionsCompleted}</div>
          <div className="text-[10px] uppercase tracking-wide text-[#8b98a5]">sessions</div>
        </div>
      </div>

      <div className="relative h-2 bg-[#eff3f4] rounded-full mb-3 overflow-hidden">
        <motion.div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-blue-500 to-emerald-500"
          initial={{ width: 0 }}
          animate={{ width: `${phaseStatus.progressInPhasePct}%` }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
          aria-label={`${phaseStatus.progressInPhasePct}% through ${current.label}`}
        />
      </div>

      <div className="flex items-center justify-between text-xs text-[#8b98a5]">
        <span>{phaseStatus.sessionsInPhase} this phase</span>
        {next && phaseStatus.sessionsUntilNextPhase > 0 && (
          <span>
            {phaseStatus.sessionsUntilNextPhase} more to reach <span className="text-[#536471] font-medium">{next.label}</span>
          </span>
        )}
        {!next && <span className="text-emerald-500 font-medium">Final phase</span>}
      </div>

      {/* Phase row. Wave 5 deferred cleanup — previously each phase
          had a rounded-lg + bg-blue-500/10 fill + extra padding that
          made the current phase look like a tappable button, but the
          row has never been interactive and there's no per-phase
          detail view to navigate to. Stripped the rounded fill +
          padding so it reads as a labelled indicator instead.
          Current phase still gets a visual cue (blue + bold + a small
          underline marker below the label) so the "you are here"
          signal isn't lost. `role="list"` makes the informational
          nature explicit to screen readers. */}
      <ol
        role="list"
        aria-label="Pathway phase progress"
        className="mt-4 flex items-center gap-1 overflow-x-auto list-none p-0"
      >
        {PHASE_ORDER.map((p, i) => {
          const isCurrent = i === currentIdx
          const isPast = i < currentIdx
          return (
            <li
              key={p}
              aria-current={isCurrent ? 'step' : undefined}
              className="flex-1 min-w-[54px] flex flex-col items-center gap-1"
            >
              <span className="text-base leading-none" aria-hidden>{PHASE_LABELS[p].icon}</span>
              <span
                className={`text-[10px] ${
                  isCurrent
                    ? 'text-blue-500 font-medium'
                    : isPast
                      ? 'text-[#8b98a5]'
                      : 'text-[#8b98a5]'
                }`}
              >
                {PHASE_LABELS[p].label}
              </span>
              {/* Reserve a 2px underline slot on every item so the
                  current-phase indicator doesn't shift the row's
                  vertical baseline. Only the current phase paints
                  the marker. */}
              <span
                aria-hidden
                className={`h-0.5 w-6 rounded-full ${isCurrent ? 'bg-blue-500' : 'bg-transparent'}`}
              />
            </li>
          )
        })}
      </ol>
    </motion.section>
  )
}
