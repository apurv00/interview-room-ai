/**
 * Per-competency task templates for pathway practice tasks.
 *
 * Wave 2 / UAT-016: the hardcoded `Focus drill: Prepare 3 stories…`
 * copy at pathwayPlanner.ts:344 was identical for every blocker, every
 * domain, every user. This pool gives 3 variants per core competency
 * plus deterministic rotation so a candidate doesn't see the same
 * sentence twice when two of their blockers map to the same dimension.
 *
 * Also serves as the fallback well for UAT-023 — when an LLM-generated
 * task is rejected by the learnerCopySanitizer, we substitute a
 * curated task from this pool keyed by `targetCompetency`.
 *
 * Templates are intentionally candidate-voice and concrete (no
 * "prompt", "template", "scenario count" jargon — see
 * learnerCopySanitizer.ts).
 */

export interface TaskTemplate {
  title: string
  description: string
  difficulty: 'easy' | 'medium' | 'hard'
  estimatedMinutes: number
}

type CompetencyKey = string

const POOLS: Record<CompetencyKey, TaskTemplate[]> = {
  relevance: [
    {
      title: 'Tighten your answer to the question asked',
      description: 'Pick 3 questions from your last 2 sessions where you drifted off-topic. Rewrite each answer in 3 sentences max, leading with one sentence that directly answers the question.',
      difficulty: 'medium',
      estimatedMinutes: 15,
    },
    {
      title: 'Practice the direct opener',
      description: 'For 3 behavioral questions you struggle with, write the first sentence of your answer so it directly answers the question — no setup, no preamble.',
      difficulty: 'easy',
      estimatedMinutes: 10,
    },
    {
      title: 'Cut tangents from a past answer',
      description: 'Re-read one weak answer from your last session and remove every sentence that doesn\'t support what was asked. Aim to halve the length without losing substance.',
      difficulty: 'medium',
      estimatedMinutes: 15,
    },
  ],

  structure: [
    {
      title: 'Build 3 STAR answers from real projects',
      description: 'Pick 3 past projects. For each, write Situation, Task, Action, Result in one sentence each. Read them back — every section should be clearly distinct.',
      difficulty: 'medium',
      estimatedMinutes: 20,
    },
    {
      title: 'Record a 1-minute STAR opener',
      description: 'Practice answering "Tell me about a project you led" in exactly 60 seconds, hitting all four STAR beats. Re-record until each beat is unmistakable.',
      difficulty: 'medium',
      estimatedMinutes: 15,
    },
    {
      title: 'Diagnose a rambling answer',
      description: 'Take your longest answer from the last session. Mark the Situation, Task, Action, and Result. Note which beats are missing or compressed — that\'s the next thing to drill.',
      difficulty: 'easy',
      estimatedMinutes: 10,
    },
  ],

  specificity: [
    {
      title: 'Add a number to 5 past answers',
      description: 'Take 5 of your recent answers and add at least one measurable outcome to each — percent, dollar amount, time saved, team size, anything quantifiable.',
      difficulty: 'medium',
      estimatedMinutes: 15,
    },
    {
      title: 'Lead with the metric, not the narrative',
      description: 'For 3 of your strongest wins, write a one-line headline metric (e.g. "Shipped X reducing Y by 40%") and place it first. The story follows the number.',
      difficulty: 'medium',
      estimatedMinutes: 15,
    },
    {
      title: 'Replace 3 vague claims with proof',
      description: 'Find 3 sentences in past answers like "improved performance" or "drove growth". Rewrite each with the actual metric, baseline, and timeframe.',
      difficulty: 'easy',
      estimatedMinutes: 10,
    },
  ],

  ownership: [
    {
      title: 'Rewrite 3 "we" answers in the first person',
      description: 'Find 3 past answers where you said "we" or "the team". Rewrite each so your specific contribution is unmistakable — what you decided, built, or owned.',
      difficulty: 'medium',
      estimatedMinutes: 15,
    },
    {
      title: 'Name your call in 3 past projects',
      description: 'For 3 recent projects, write one decision you personally made and one you\'d remake differently. Bring these to your next interview as ready-to-tell stories.',
      difficulty: 'medium',
      estimatedMinutes: 20,
    },
    {
      title: 'Surface a hard tradeoff you owned',
      description: 'Pick one project where you chose between two real options. Write 3 sentences: the options, your decision, and the result. No team-level framing.',
      difficulty: 'medium',
      estimatedMinutes: 15,
    },
  ],

  communication: [
    {
      title: 'Cut filler words in 3 practice answers',
      description: 'Record yourself answering 3 questions out loud. Count the "um", "uh", "like", "you know" instances. Re-record until under 5% of total words.',
      difficulty: 'easy',
      estimatedMinutes: 20,
    },
    {
      title: 'Slow your delivery on the opener',
      description: 'Practice the first 20 seconds of three answers at a deliberate, unhurried pace. The goal is zero rushed phrases — clarity over speed.',
      difficulty: 'easy',
      estimatedMinutes: 15,
    },
    {
      title: 'Shorten your average answer',
      description: 'Take your three longest past answers. Cut each by a third without losing the key beat. Read the shorter version aloud and check it still lands.',
      difficulty: 'medium',
      estimatedMinutes: 15,
    },
  ],

  self_awareness: [
    {
      title: 'Note 3 takeaways from your last session',
      description: 'Re-read your most recent feedback. Pick 3 specific things you\'d change next time — one sentence each, written down where you\'ll see them.',
      difficulty: 'easy',
      estimatedMinutes: 10,
    },
    {
      title: 'Identify your repeating weakness',
      description: 'Look at your last 3 sessions. Which competency dropped lowest most often? Write one sentence on why you think it keeps showing up.',
      difficulty: 'easy',
      estimatedMinutes: 10,
    },
  ],
}

const GENERIC_POOL: TaskTemplate[] = [
  {
    title: 'Practice 3 stories from your recent work',
    description: 'Pick 3 wins from the last 6 months. Write each as a 2-sentence answer with one specific outcome. Read them aloud and tighten the weakest.',
    difficulty: 'medium',
    estimatedMinutes: 15,
  },
  {
    title: 'Review your last session feedback',
    description: 'Re-read your most recent feedback. Pick the lowest-scoring dimension and write one concrete change you\'ll make in the next interview.',
    difficulty: 'easy',
    estimatedMinutes: 10,
  },
]

/**
 * Stable string hash → returns a non-negative integer.
 * Not cryptographic; used only for deterministic rotation within a
 * small pool (size <= 10).
 */
function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/**
 * Pick a task template for the given competency, deterministically
 * rotating across the pool based on `rotationKey`.
 *
 * @param competency — weak-dimension slug (relevance, structure, etc.)
 *                     Falls back to a generic pool when unknown.
 * @param rotationKey — any stable string that varies the picked variant
 *                      across callers (e.g. blocker index, user+session
 *                      identifier). Same key + same competency =>
 *                      same template, every time.
 */
export function pickTaskTemplate(
  competency: string | null | undefined,
  rotationKey: string,
): TaskTemplate {
  const key = (competency || '').toLowerCase().trim().replace(/[-\s]/g, '_')
  const pool = POOLS[key] || GENERIC_POOL
  const idx = hashString(`${key}|${rotationKey}`) % pool.length
  return pool[idx]
}

/**
 * Exported for testing — lets us assert that every shipped template
 * passes the learner-copy sanitizer.
 */
export function _allTemplates(): TaskTemplate[] {
  return [...Object.values(POOLS).flat(), ...GENERIC_POOL]
}
