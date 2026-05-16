import type { IPathwayPlan, PracticeTask } from '@shared/db/models'

export type PathwayState = 'empty' | 'active' | 'completed' | 'pending' | 'abandoned' | 'returning' | 'failed'

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
}

export interface PathwayActivity {
  generatedFromSessionId: string | null
  generatedAt: string | null
  weaknessesCount: number
}

export interface PathwayViewModel {
  state: PathwayState
  nextAction: PathwayAction
  planItems: PathwayPlanItem[]
  progress: PathwayProgress
  activity: PathwayActivity
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
  now?: Date
}

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
  now = new Date(),
}: BuildPathwayViewModelInput): PathwayViewModel {
  // Bug B fix — if we arrived from feedback AND the upstream session's
  // background regeneration job has terminally failed, surface a 'failed'
  // state with a Retry CTA instead of the perpetual 'pending' banner.
  if (
    fromFeedback &&
    feedbackSessionStatus === 'failed' &&
    isPendingForFeedback(pathway, fromFeedback)
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
      progress: buildProgress(pathway, competencySummary),
      activity: buildActivity(pathway, weaknesses),
    }
  }

  if (isPendingForFeedback(pathway, fromFeedback)) {
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
      progress: buildProgress(pathway, competencySummary),
      activity: buildActivity(pathway, weaknesses),
    }
  }

  if (!pathway) {
    return {
      state: 'empty',
      nextAction: buildBaselineInterviewAction(),
      planItems: [],
      progress: buildProgress(null, competencySummary),
      activity: buildActivity(null, weaknesses),
    }
  }

  const planItems = mapPlanItems(pathway.practiceTasks ?? [])
  const progress = buildProgress(pathway, competencySummary)
  const state = resolveState(pathway, progress, now)

  return {
    state,
    nextAction: resolveNextAction(pathway, state),
    planItems,
    progress,
    activity: buildActivity(pathway, weaknesses),
  }
}

function isPendingForFeedback(pathway: IPathwayPlan | null, fromFeedback?: string | null): boolean {
  if (!fromFeedback) return false
  if (!pathway) return true
  const generatedFrom = pathway.generatedFromSessionId ? String(pathway.generatedFromSessionId) : ''
  return generatedFrom !== fromFeedback
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
): PathwayProgress {
  const tasks = pathway?.practiceTasks ?? []
  const milestones = pathway?.milestones ?? []
  return {
    readinessScore: pathway?.readinessScore ?? 0,
    readinessLevel: pathway?.readinessLevel ?? null,
    completedTasks: tasks.filter((task) => task.completed).length,
    totalTasks: tasks.length,
    achievedMilestones: milestones.filter((milestone) => milestone.achieved).length,
    totalMilestones: milestones.length,
    blockers: pathway?.topBlockingWeaknesses ?? [],
    competencySummary,
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
