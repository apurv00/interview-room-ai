import type { IPathwayPlan, PracticeTask } from '@shared/db/models'

export type PathwayState = 'empty' | 'active' | 'completed' | 'pending' | 'abandoned' | 'returning' | 'failed'

/**
 * Pathway P2 Wave 3 (feature #9) — UI projection of a Milestone.
 * The model carries Date objects; this is the serialised, UI-safe shape.
 */
export interface MilestoneSummary {
  name: string
  description: string
  currentScore: number
  targetScore: number
  achieved: boolean
  achievedAt: string | null
}

/**
 * Pathway P2 Wave 3 — per-blocker insights, computed outside the
 * stored blocker shape so we don't need to mutate `IPathwayPlan`.
 *
 *   - recurrenceCount (#8): how many of the user's prior pathway plans
 *     listed the same competency as a blocker. Surfaces "is this a
 *     repeating pattern or a one-off?" — answers a question the
 *     current per-plan blocker UI can't.
 *
 *   - momentum (#2): the last N (score, timestamp) points from
 *     `UserCompetencyState.scoreHistory` for this competency. Lets
 *     the UI render a tiny sparkline so the user sees whether their
 *     score on a blocker competency is trending up or down across
 *     recent sessions.
 *
 * Keyed by competency name so the panel can look up insights for a
 * blocker without coupling to array index ordering (the underlying
 * stored blockers array order is not stable).
 */
export interface BlockerInsight {
  recurrenceCount: number
  momentum: Array<{ score: number; at: string }>
}

export interface PathwayAction {
  id: string
  type: 'interview' | 'drill' | 'task' | 'review'
  title: string
  description: string
  ctaLabel: string
  href?: string
  taskId?: string
  metadata?: Record<string, string | string[]>
}

export interface PathwayPlanItem {
  id: string
  type: PracticeTask['type']
  title: string
  description: string
  status: 'todo' | 'done'
  targetCompetency: string
  difficulty: PracticeTask['difficulty']
  estimatedMinutes: number
  href?: string
}

export interface PathwayProgress {
  readinessScore: number
  readinessLevel: IPathwayPlan['readinessLevel'] | null
  completedTasks: number
  totalTasks: number
  achievedMilestones: number
  totalMilestones: number
  blockers: IPathwayPlan['topBlockingWeaknesses']
  competencySummary: unknown
  /** Pathway P2 Wave 3 #9 — UI projection of the underlying milestones array. */
  milestones: MilestoneSummary[]
  /** Pathway P2 Wave 3 #2 + #8 — keyed by competency name. Empty object when
   *  no priors / competency states are available. Components must treat a
   *  missing key as "no insight" rather than an error. */
  blockerInsights: Record<string, BlockerInsight>
}

export interface PathwayActivity {
  generatedFromSessionId: string | null
  generatedAt: string | null
  weaknessesCount: number
}

/**
 * Pathway P2 Wave 4 (feature C — decay context) — the user's
 * interview-cadence profile, derived from the most-recent completed
 * session timestamp. UI uses `decayProfile` to render the
 * DecayContextCard with the right tone and copy.
 *
 * Diagnostic-coach framing: this is OBSERVATION, not nag. The card
 * surfaces a fact (days since last interview) + a coach insight (what
 * tends to fade first at that range). It does NOT impose urgency or
 * a curriculum cadence — that was the killed "SR urgency banner"
 * pattern from Round 5 ideation.
 *
 * Thresholds (chosen to match the editorial copy on each band):
 *   - 'fresh'  : 0-2 days  → card is hidden; nothing to observe yet
 *   - 'warmup' : 3-7 days  → speech pace + fillers tend to slip first
 *   - 'rusty'  : 8-21 days → communication + structural recall fade
 *   - 'cold'   : 22+ days  → structure + recall need targeted refresh
 *
 * `null` is reserved for users who have never completed a session;
 * the empty-state action covers them.
 */
export type DecayProfile = 'fresh' | 'warmup' | 'rusty' | 'cold'

export interface ActivityRhythm {
  lastSessionAt: string | null
  daysSinceLastSession: number | null
  decayProfile: DecayProfile | null
}

export interface PathwayViewModel {
  state: PathwayState
  nextAction: PathwayAction
  planItems: PathwayPlanItem[]
  progress: PathwayProgress
  activity: PathwayActivity
  /** Pathway P2 Wave 4 — present even when the card won't render
   *  (lastSessionAt may be null, decayProfile may be 'fresh'). The
   *  component decides whether to render based on the profile. */
  activityRhythm: ActivityRhythm
}

/**
 * Pathway P2 Wave 3 — minimal shapes the builder needs. We accept
 * these instead of the full Mongoose `IPathwayPlan` / `IUserCompetencyState`
 * documents so tests can construct fixtures without leaning on the ODM
 * and the route handler can ship tight `.lean()` projections.
 */
export interface PriorPlanForRecurrence {
  topBlockingWeaknesses: Array<{ competency: string }>
}
export interface CompetencyStateForMomentum {
  competencyName: string
  scoreHistory: Array<{ score: number; timestamp: Date | string }>
}

interface BuildPathwayViewModelInput {
  pathway: IPathwayPlan | null
  competencySummary: unknown
  weaknesses: unknown[]
  fromFeedback?: string | null
  /** Bug B fix (2026-05-16) — when the caller arrives from feedback, we
   *  read the upstream session's `pathwayGenerationStatus` so the view
   *  model can distinguish "still running" (pending banner) from
   *  "failed after retries" (retry CTA). null/undefined means we either
   *  weren't called from feedback or the session had no recorded
   *  attempt — both fall through to the existing pending behavior. */
  feedbackSessionStatus?: string | null
  feedbackSessionError?: string | null
  /** Pathway P2 Wave 3 #8 — prior pathway plans (excluding the current
   *  one) used to compute per-blocker recurrenceCount. Pass the last N
   *  plans sorted by generatedAt desc; the builder counts unique plans
   *  where this competency appeared in topBlockingWeaknesses. */
  priorPlans?: PriorPlanForRecurrence[]
  /** Pathway P2 Wave 3 #2 — UserCompetencyState rows used to populate
   *  per-blocker momentum sparklines. Only rows whose competencyName
   *  matches a current blocker are needed. */
  competencyStates?: CompetencyStateForMomentum[]
  /** Pathway P2 Wave 3 #2 — cap on momentum points per competency to
   *  keep the sparkline visually meaningful and the payload small.
   *  Defaults to 6 (matches the visual width of the SVG). */
  momentumWindow?: number
  /** Pathway P2 Wave 4 — timestamp of the user's most-recent
   *  COMPLETED session (status: 'completed', completedAt set). Used to
   *  derive ActivityRhythm.decayProfile. null means the user has never
   *  completed a session — DecayContextCard renders nothing in that
   *  case (the empty-state action card covers them). */
  lastSessionAt?: Date | string | null
  /** 2026-05-20 — sessionId of the most-recent completed session.
   *  Paired with `lastSessionAt`. When the user has sessions but no
   *  PathwayPlan (LLM failure on generate-feedback, etc.) the empty
   *  state uses this to link back to the actual interview's feedback
   *  page instead of pretending no interviews exist.
   *  null means no completed session. */
  lastSessionId?: string | null
  /** 2026-05-20 — `pathwayGenerationStatus` from the most-recent
   *  completed session. Lets the empty-state distinguish
   *  "pathway gen failed and can be retried" from "no attempt was
   *  ever recorded" so the CTA points to the right recovery action. */
  lastSessionPathwayStatus?: string | null
  now?: Date
}

const DEFAULT_MOMENTUM_WINDOW = 6

const RETURN_TO_PATHWAY = '/learn/pathway'
const RETURNING_AFTER_DAYS = 2
const ABANDONED_AFTER_DAYS = 7

export function buildPathwayViewModel({
  pathway,
  competencySummary,
  weaknesses,
  fromFeedback,
  feedbackSessionStatus,
  feedbackSessionError,
  priorPlans = [],
  competencyStates = [],
  momentumWindow = DEFAULT_MOMENTUM_WINDOW,
  lastSessionAt,
  lastSessionId,
  lastSessionPathwayStatus,
  now = new Date(),
}: BuildPathwayViewModelInput): PathwayViewModel {
  // Wave 4 — compute once, attach to every return path. Cheap.
  const activityRhythm = buildActivityRhythm(lastSessionAt, now)
  // Bug B fix — if we arrived from feedback AND the upstream session's
  // background regeneration job has terminally failed, surface a 'failed'
  // state with a Retry CTA instead of the perpetual 'pending' banner.
  if (
    fromFeedback &&
    feedbackSessionStatus === 'failed' &&
    isPendingForFeedback(pathway, fromFeedback, feedbackSessionStatus)
  ) {
    const errorSuffix = feedbackSessionError ? ` (${feedbackSessionError})` : ''
    return {
      state: 'failed',
      nextAction: {
        id: 'retry-pathway',
        type: 'review',
        title: 'Pathway update failed',
        description: `We couldn't regenerate your plan from this interview after 3 attempts${errorSuffix}. Retry to enqueue another attempt, or head back to feedback.`,
        ctaLabel: 'Retry pathway update',
        metadata: { fromFeedback, sessionId: fromFeedback },
      },
      planItems: pathway ? mapPlanItems(pathway.practiceTasks ?? []) : [],
      progress: buildProgress(pathway, competencySummary, priorPlans, competencyStates, momentumWindow),
      activity: buildActivity(pathway, weaknesses),
      activityRhythm,
    }
  }

  if (isPendingForFeedback(pathway, fromFeedback, feedbackSessionStatus)) {
    return {
      state: 'pending',
      nextAction: {
        id: 'pending-feedback',
        type: 'review',
        title: 'Your pathway update is catching up',
        description: 'The interview feedback is ready. The pathway will switch to the new plan as soon as generation finishes.',
        ctaLabel: 'Back to feedback',
        href: fromFeedback ? `/feedback/${encodeURIComponent(fromFeedback)}` : undefined,
      },
      planItems: pathway ? mapPlanItems(pathway.practiceTasks ?? []) : [],
      progress: buildProgress(pathway, competencySummary, priorPlans, competencyStates, momentumWindow),
      activity: buildActivity(pathway, weaknesses),
      activityRhythm,
    }
  }

  // Codex/Vercel P2 on PR #398 — direct nav to /learn/pathway (no
  // ?fromFeedback=) while the latest session's pathway job is still
  // pending/running must show the catching-up banner, not "didn't
  // generate" retry copy.
  if (
    !pathway &&
    lastSessionId &&
    (lastSessionPathwayStatus === 'pending' || lastSessionPathwayStatus === 'running')
  ) {
    return {
      state: 'pending',
      nextAction: {
        id: 'pending-last-session',
        type: 'review',
        title: 'Your pathway update is catching up',
        description:
          'Your last interview feedback is ready. Your pathway will update as soon as generation finishes.',
        ctaLabel: 'Open last interview feedback',
        href: `/feedback/${encodeURIComponent(lastSessionId)}`,
      },
      planItems: [],
      progress: buildProgress(null, competencySummary, priorPlans, competencyStates, momentumWindow),
      activity: buildActivity(null, weaknesses),
      activityRhythm,
    }
  }

  if (!pathway) {
    // 2026-05-20 user-reported regression: this branch used to always
    // ship a "Take your first interview" CTA, even when the user had
    // multiple completed sessions but no PathwayPlan got generated
    // (LLM failures on /api/generate-feedback's pathway-enqueue side
    // effect). Now we tailor the action based on whether sessions
    // exist:
    //   - No completed session at all → baseline-interview CTA (unchanged)
    //   - Completed session(s) exist → contextual CTA pointing back to
    //     the latest interview's feedback page where the user can retry
    //     feedback generation (which in turn re-enqueues the pathway
    //     Inngest job).
    const hasCompletedSession = !!lastSessionAt && !!lastSessionId
    const nextAction: PathwayAction = hasCompletedSession
      ? {
          id: 'retry-pathway-from-last-session',
          type: 'review',
          title: 'Your pathway didn’t generate from your last interview',
          description:
            lastSessionPathwayStatus === 'failed'
              ? 'The background pathway-generation job failed on your most recent interview. Open the feedback page and use the Retry button there — that will re-trigger the pathway generation.'
              : lastSessionPathwayStatus === 'skipped'
                ? 'Pathway generation was disabled when you completed this interview. Run another interview to create a plan — if the feature is available, it will generate on your next session.'
                : 'We have your interview but a pathway plan never landed. Open the feedback page for your most recent interview to retry — or run another interview if you want a fresh baseline.',
          ctaLabel: 'Open last interview feedback',
          href: `/feedback/${encodeURIComponent(lastSessionId)}?retryPathway=1`,
        }
      : buildBaselineInterviewAction()

    return {
      state: 'empty',
      nextAction,
      planItems: [],
      progress: buildProgress(null, competencySummary, priorPlans, competencyStates, momentumWindow),
      activity: buildActivity(null, weaknesses),
      activityRhythm,
    }
  }

  const planItems = mapPlanItems(pathway.practiceTasks ?? [])
  const progress = buildProgress(pathway, competencySummary, priorPlans, competencyStates, momentumWindow)
  const state = resolveState(pathway, progress, now)

  return {
    state,
    nextAction: resolveNextAction(pathway, state),
    planItems,
    progress,
    activity: buildActivity(pathway, weaknesses),
    activityRhythm,
  }
}

/**
 * Decide whether to render the "pathway update is catching up" banner.
 *
 * The banner exists to bridge the moment between "feedback page links
 * to /learn/pathway?fromFeedback=X" and "the Inngest pathway/regenerate
 * job finishes and updates the plan to match session X". It must NOT
 * appear in terminal states where regen has already completed (or was
 * deliberately skipped) — otherwise the banner sticks forever in two
 * legitimate scenarios that surfaced in production:
 *
 *   1. User navigates from an OLDER feedback page. The pathway HAS
 *      since been regenerated, but for a NEWER session, so
 *      `generatedFromSessionId !== fromFeedback`. Pre-fix logic
 *      misread this as "still catching up" — the regen for THIS
 *      session was actually done long ago.
 *
 *   2. Pathway flag was off at feedback time. The Inngest job ran,
 *      hit the flag check, and marked status='skipped' without
 *      touching the plan. `generatedFromSessionId` doesn't match the
 *      session id, so pre-fix logic showed the banner forever.
 *
 * Fix: short-circuit to "not pending" when the session's terminal
 * status records that regen already completed or was skipped. Status
 * 'failed' is handled separately upstream (renders the failed banner
 * with retry CTA), so this function still returns true for that case
 * — the caller checks `feedbackSessionStatus === 'failed'` first.
 *
 * Status undefined / null preserves the legacy behavior (show
 * banner if mismatch), which covers sessions that pre-date Bug B's
 * pathwayGenerationStatus tracking.
 */
function isPendingForFeedback(
  pathway: IPathwayPlan | null,
  fromFeedback?: string | null,
  feedbackSessionStatus?: string | null,
): boolean {
  if (!fromFeedback) return false
  if (!pathway) return true
  const generatedFrom = pathway.generatedFromSessionId ? String(pathway.generatedFromSessionId) : ''
  if (generatedFrom === fromFeedback) return false
  // Terminal status ⇒ regen already happened (or was deliberately
  // skipped). The mismatch on `generatedFromSessionId` just means
  // the plan has since moved on to a newer session, or the flag
  // skipped this session — neither is a "catching up" state.
  if (feedbackSessionStatus === 'succeeded' || feedbackSessionStatus === 'skipped') {
    return false
  }
  return true
}

function resolveState(pathway: IPathwayPlan, progress: PathwayProgress, now: Date): PathwayState {
  const completedPlan =
    progress.totalTasks > 0 &&
    progress.completedTasks === progress.totalTasks &&
    (progress.blockers.length === 0 || progress.readinessScore >= 85)
  if (completedPlan) return 'completed'

  const ageDays = getPlanAgeDays(pathway.generatedAt, now)
  if (ageDays >= ABANDONED_AFTER_DAYS) return 'abandoned'
  if (ageDays >= RETURNING_AFTER_DAYS) return 'returning'
  return 'active'
}

function resolveNextAction(pathway: IPathwayPlan, state: PathwayState): PathwayAction {
  if (state === 'completed') return buildChallengeInterviewAction(pathway)

  const firstOpenTask = (pathway.practiceTasks ?? []).find((task) => !task.completed)
  if (firstOpenTask) return buildTaskAction(firstOpenTask)

  return buildRecommendedInterviewAction(pathway, 'next-interview')
}

function buildProgress(
  pathway: IPathwayPlan | null,
  competencySummary: unknown,
  priorPlans: PriorPlanForRecurrence[] = [],
  competencyStates: CompetencyStateForMomentum[] = [],
  momentumWindow: number = DEFAULT_MOMENTUM_WINDOW,
): PathwayProgress {
  const tasks = pathway?.practiceTasks ?? []
  const milestones = pathway?.milestones ?? []
  const blockers = pathway?.topBlockingWeaknesses ?? []
  return {
    readinessScore: pathway?.readinessScore ?? 0,
    readinessLevel: pathway?.readinessLevel ?? null,
    completedTasks: tasks.filter((task) => task.completed).length,
    totalTasks: tasks.length,
    achievedMilestones: milestones.filter((milestone) => milestone.achieved).length,
    totalMilestones: milestones.length,
    blockers,
    competencySummary,
    // #9
    milestones: milestones.map((m) => ({
      name: m.name,
      description: m.description ?? '',
      currentScore: m.currentScore,
      targetScore: m.targetScore,
      achieved: !!m.achieved,
      achievedAt: m.achievedAt ? new Date(m.achievedAt).toISOString() : null,
    })),
    // #2 + #8
    blockerInsights: buildBlockerInsights(blockers, priorPlans, competencyStates, momentumWindow),
  }
}

/**
 * Pathway P2 Wave 3 — derive recurrence + momentum for each current
 * blocker. Skips silently when priors/states are empty (the panel
 * treats missing insights as "no extra context").
 */
function buildBlockerInsights(
  blockers: IPathwayPlan['topBlockingWeaknesses'],
  priorPlans: PriorPlanForRecurrence[],
  competencyStates: CompetencyStateForMomentum[],
  momentumWindow: number,
): Record<string, BlockerInsight> {
  if (blockers.length === 0) return {}

  // Build a competency → recurrence count map once, then look up per blocker.
  // Counts UNIQUE prior plans (not duplicate listings within a single plan).
  const recurrenceByCompetency = new Map<string, number>()
  for (const plan of priorPlans) {
    const seen = new Set<string>()
    for (const w of plan.topBlockingWeaknesses ?? []) {
      if (w.competency && !seen.has(w.competency)) {
        seen.add(w.competency)
        recurrenceByCompetency.set(w.competency, (recurrenceByCompetency.get(w.competency) ?? 0) + 1)
      }
    }
  }

  // Build a competency → most recent N momentum points lookup.
  // Sort timestamps ascending so the sparkline reads left-to-right
  // oldest-to-newest. Cap to the most recent `momentumWindow` points.
  const momentumByCompetency = new Map<string, BlockerInsight['momentum']>()
  for (const state of competencyStates) {
    const history = Array.isArray(state.scoreHistory) ? state.scoreHistory : []
    const points = history
      .map((h) => ({ score: h.score, at: new Date(h.timestamp).toISOString() }))
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-momentumWindow)
    momentumByCompetency.set(state.competencyName, points)
  }

  const out: Record<string, BlockerInsight> = {}
  for (const b of blockers) {
    out[b.competency] = {
      recurrenceCount: recurrenceByCompetency.get(b.competency) ?? 0,
      momentum: momentumByCompetency.get(b.competency) ?? [],
    }
  }
  return out
}

/**
 * Pathway P2 Wave 4 — derive ActivityRhythm.
 *
 * Threshold rationale:
 *   - 0-2 days ('fresh'): too recent for decay observation; the user
 *     probably just took an interview yesterday. Hiding the card
 *     keeps the page calm on the active-user happy path.
 *   - 3-7 days ('warmup'): a short break — speech rhythm and filler
 *     control are the first to slip per the speech-metrics literature
 *     this app's coaching already uses.
 *   - 8-21 days ('rusty'): communication patterns and structural
 *     recall start to fade noticeably.
 *   - 22+ days ('cold'): a long break — deeper skills (story recall,
 *     STAR structure) need targeted refresh.
 *
 * Returns nulls when the user has never completed a session — the
 * empty-state action card covers that flow, so showing a decay card
 * would be misleading.
 */
function buildActivityRhythm(
  lastSessionAt: Date | string | null | undefined,
  now: Date,
): ActivityRhythm {
  if (!lastSessionAt) {
    return { lastSessionAt: null, daysSinceLastSession: null, decayProfile: null }
  }
  const ts = new Date(lastSessionAt).getTime()
  if (!Number.isFinite(ts)) {
    return { lastSessionAt: null, daysSinceLastSession: null, decayProfile: null }
  }
  const days = Math.floor((now.getTime() - ts) / (24 * 60 * 60 * 1000))
  const decayProfile: DecayProfile =
    days <= 2 ? 'fresh' : days <= 7 ? 'warmup' : days <= 21 ? 'rusty' : 'cold'
  return {
    lastSessionAt: new Date(lastSessionAt).toISOString(),
    daysSinceLastSession: Math.max(0, days),
    decayProfile,
  }
}

function buildActivity(pathway: IPathwayPlan | null, weaknesses: unknown[]): PathwayActivity {
  return {
    generatedFromSessionId: pathway?.generatedFromSessionId ? String(pathway.generatedFromSessionId) : null,
    generatedAt: pathway?.generatedAt ? new Date(pathway.generatedAt).toISOString() : null,
    weaknessesCount: weaknesses.length,
  }
}

function mapPlanItems(tasks: PracticeTask[]): PathwayPlanItem[] {
  return tasks.map((task) => ({
    id: task.taskId,
    type: task.type,
    title: task.title,
    description: task.description,
    status: task.completed ? 'done' : 'todo',
    targetCompetency: task.targetCompetency,
    difficulty: task.difficulty,
    estimatedMinutes: task.estimatedMinutes,
    href: task.type === 'drill'
      ? buildDrillHref(task.targetCompetency, task.taskId)
      : undefined,
  }))
}

function buildTaskAction(task: PracticeTask): PathwayAction {
  if (task.type === 'drill') {
    return {
      id: task.taskId,
      type: 'drill',
      title: task.title,
      description: task.description,
      ctaLabel: 'Start drill',
      href: buildDrillHref(task.targetCompetency, task.taskId),
      taskId: task.taskId,
      metadata: {
        focus: task.targetCompetency,
        difficulty: task.difficulty,
      },
    }
  }

  return {
    id: task.taskId,
    type: 'task',
    title: task.title,
    description: task.description,
    ctaLabel: 'Mark complete',
    taskId: task.taskId,
    metadata: {
      focus: task.targetCompetency,
      difficulty: task.difficulty,
    },
  }
}

function buildBaselineInterviewAction(): PathwayAction {
  return {
    id: 'baseline-interview',
    type: 'interview',
    title: 'Run a baseline interview',
    description: 'Complete one interview so Pathway can build a focused plan from your actual answers.',
    ctaLabel: 'Start baseline interview',
    href: buildInterviewSetupHref({ actionId: 'baseline' }),
  }
}

function buildChallengeInterviewAction(pathway: IPathwayPlan): PathwayAction {
  return buildRecommendedInterviewAction(pathway, 'challenge', {
    title: 'Start a final rehearsal',
    description: 'Your current tasks are complete. Run a tougher session to validate the improvement loop.',
    ctaLabel: 'Start final rehearsal',
    difficulty: 'hard',
  })
}

function buildRecommendedInterviewAction(
  pathway: IPathwayPlan,
  actionId: string,
  overrides: Partial<Pick<PathwayAction, 'title' | 'description' | 'ctaLabel'>> & { difficulty?: string } = {},
): PathwayAction {
  const recommendation = pathway.nextSessionRecommendation
  const focus = recommendation?.focusCompetencies ?? []
  return {
    id: actionId,
    type: 'interview',
    title: overrides.title ?? 'Run the next recommended interview',
    description: overrides.description ?? recommendation?.reason ?? 'Practice against the next round that best matches your current gaps.',
    ctaLabel: overrides.ctaLabel ?? 'Start recommended interview',
    href: buildInterviewSetupHref({
      actionId,
      domain: recommendation?.domain || pathway.targetRole,
      interviewType: recommendation?.interviewType,
      difficulty: overrides.difficulty ?? recommendation?.difficulty,
      focus,
    }),
    metadata: {
      domain: recommendation?.domain || pathway.targetRole,
      interviewType: recommendation?.interviewType || '',
      difficulty: overrides.difficulty ?? recommendation?.difficulty ?? '',
      focus,
    },
  }
}

function buildInterviewSetupHref(params: {
  actionId: string
  domain?: string
  interviewType?: string
  difficulty?: string
  focus?: string[]
}): string {
  const query = new URLSearchParams({
    source: 'pathway',
    actionId: params.actionId,
    returnTo: RETURN_TO_PATHWAY,
  })
  if (params.domain) query.set('domain', params.domain)
  if (params.interviewType) query.set('interviewType', params.interviewType)
  if (params.difficulty) query.set('difficulty', params.difficulty)
  if (params.focus?.length) query.set('focus', params.focus.join(','))
  return `/interview/setup?${query.toString()}`
}

function buildDrillHref(competency: string, actionId: string): string {
  const query = new URLSearchParams({
    source: 'pathway',
    actionId,
    returnTo: RETURN_TO_PATHWAY,
  })
  if (competency) query.set('competency', competency)
  return `/practice/drill?${query.toString()}`
}

function getPlanAgeDays(generatedAt: Date | string | undefined, now: Date): number {
  if (!generatedAt) return 0
  const generatedTime = new Date(generatedAt).getTime()
  if (!Number.isFinite(generatedTime)) return 0
  return Math.floor((now.getTime() - generatedTime) / (24 * 60 * 60 * 1000))
}
