'use client'

import { Clock, AlertCircle, Snowflake } from 'lucide-react'
import type { ActivityRhythm } from '@learn/services/pathwayViewModel'

/**
 * DecayContextCard — gap-aware coach observation on the Pathway page.
 *
 * Pathway P2 Wave 4 (feature C): when the user has been away from
 * interviews for a few days, surface a coach observation about WHAT
 * tends to fade first at that distance. This is the gap-aware
 * companion to the action-anchored cards from Waves 1 & 2.
 *
 * Diagnostic-coach tone — OBSERVATION, not nag. Replaces the killed
 * "SR urgency banner" pattern from Round 5 ideation. The card:
 *
 *   - States the fact (X days since last interview)
 *   - Names what tends to slip at that distance (coach insight)
 *   - Does NOT add urgency, a "PRACTICE NOW" CTA, or curriculum
 *     framing — the TodayActionCard above it already drives action.
 *
 * Renders nothing when:
 *   - The user has never completed a session (decayProfile === null)
 *   - The gap is <3 days (decayProfile === 'fresh') — too recent
 *     for decay to be a real observation
 *
 * Three rendered bands, escalating in tone but never alarmist:
 *   - warmup (3-7d)  — neutral/blue
 *   - rusty  (8-21d) — amber
 *   - cold   (22+d)  — slate (calm cold tone, deliberately NOT red)
 */
export default function DecayContextCard({ rhythm }: { rhythm: ActivityRhythm | null }) {
  if (!rhythm?.decayProfile || rhythm.decayProfile === 'fresh' || rhythm.daysSinceLastSession === null) {
    return null
  }

  const days = rhythm.daysSinceLastSession
  const profile = rhythm.decayProfile

  const config = COPY[profile]
  const Icon = config.icon

  return (
    <section
      data-testid={`decay-context-card-${profile}`}
      aria-label="Coach observation about your recent interview cadence"
      className={`surface-card-bordered p-4 sm:p-5 ${config.tone}`}
    >
      <div className="flex items-start gap-3">
        <span className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${config.iconWrap}`}>
          <Icon className="w-4 h-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[#0f1419]">{config.heading(days)}</p>
          <p className="text-xs text-[#536471] leading-relaxed mt-1">{config.body}</p>
        </div>
      </div>
    </section>
  )
}

const COPY = {
  warmup: {
    icon: Clock,
    tone: 'bg-blue-50/40 border-blue-100',
    iconWrap: 'bg-blue-100 text-blue-700',
    heading: (days: number) => `${days} days since your last interview`,
    body:
      'A short break — speech pace and filler-word control are typically the first to slip. A 10-minute round usually re-anchors both.',
  },
  rusty: {
    icon: AlertCircle,
    tone: 'bg-amber-50/40 border-amber-100',
    iconWrap: 'bg-amber-100 text-amber-700',
    heading: (days: number) => `${days} days since your last interview`,
    body:
      'At this distance, communication patterns and structural recall begin to fade. Practising the dimensions flagged in your last feedback is the highest-leverage refresh.',
  },
  cold: {
    icon: Snowflake,
    tone: 'bg-slate-50 border-slate-200',
    iconWrap: 'bg-slate-200 text-slate-700',
    heading: (days: number) => `${days}+ days since your last interview`,
    body:
      'A long gap — story recall and STAR structure usually need a deliberate warm-up before a higher-stakes round. The next recommended interview above is calibrated to your current plan.',
  },
} as const
