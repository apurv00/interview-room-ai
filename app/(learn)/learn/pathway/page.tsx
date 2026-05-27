'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import SignedOutEmptyState from '@shared/ui/SignedOutEmptyState'
import PathwayEmptyState from '@learn/components/pathway/PathwayEmptyState'
import TodayActionCard from '@learn/components/pathway/TodayActionCard'
import PathwayPlanQueue from '@learn/components/pathway/PathwayPlanQueue'
import PathwayProgressPanel from '@learn/components/pathway/PathwayProgressPanel'
import PathwayActivityPanel from '@learn/components/pathway/PathwayActivityPanel'
import PathwayPendingBanner from '@learn/components/pathway/PathwayPendingBanner'
import PathwayFailedBanner from '@learn/components/pathway/PathwayFailedBanner'
import PathwayUnchangedBanner from '@learn/components/pathway/PathwayUnchangedBanner'
import { usePathwayGenerationPoll } from '@learn/hooks/usePathwayGenerationPoll'
import UniversalPathwayView from '@learn/components/pathway/UniversalPathwayView'
import DecayContextCard from '@learn/components/pathway/DecayContextCard'
import type { PathwayViewModel } from '@learn/services/pathwayViewModel'

interface PathwayApiResponse extends PathwayViewModel {
  pathway: {
    targetRole?: string
    nextSessionRecommendation?: {
      domain?: string
      interviewType?: string
    } | null
  } | null
  competencySummary: unknown
  weaknesses: unknown[]
}

const BASELINE_HREF = '/interview/setup?source=pathway&actionId=baseline&returnTo=%2Flearn%2Fpathway'

export default function PathwayPage() {
  return (
    <Suspense fallback={<PathwayLoading />}>
      <PathwayPageInner />
    </Suspense>
  )
}

function PathwayPageInner() {
  const { status: authStatus } = useSession()
  const searchParams = useSearchParams()
  const fromFeedback = searchParams.get('fromFeedback')
  const [data, setData] = useState<PathwayApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null)

  const loadPathway = useCallback(async () => {
    // UAT-012: keep the page in the loading state while NextAuth resolves
    // the session — turning loading off on 'loading' flashes the
    // signed-out empty state for ~1s during hydration.
    if (authStatus === 'loading') return
    if (authStatus === 'unauthenticated') {
      setLoading(false)
      return
    }

    setLoading(true)
    const params = new URLSearchParams()
    if (fromFeedback) params.set('fromFeedback', fromFeedback)

    try {
      const suffix = params.toString() ? `?${params.toString()}` : ''
      const res = await fetch(`/api/learn/pathway${suffix}`)
      setData(res.ok ? await res.json() : null)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [authStatus, fromFeedback])

  useEffect(() => {
    void loadPathway()
  }, [loadPathway])

  const shouldPoll = Boolean(
    fromFeedback && data?.pathwayUpdate?.poll && data.state === 'pending',
  )
  const { pollExhausted } = usePathwayGenerationPoll({
    sessionId: fromFeedback,
    enabled: shouldPoll,
    onRefresh: loadPathway,
  })

  const completeTask = async (taskId: string) => {
    setCompletingTaskId(taskId)
    try {
      const res = await fetch('/api/learn/pathway', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete_task', taskId }),
      })
      if (res.ok) await loadPathway()
    } catch {
      // best-effort UI action
    } finally {
      setCompletingTaskId(null)
    }
  }

  if (authStatus === 'unauthenticated') {
    return (
      <main className="max-w-4xl mx-auto px-4 py-8">
        <SignedOutEmptyState
          reason="view_progress"
          headline="Build your interview pathway"
          description="Sign in and run a baseline interview. Pathway will turn the feedback into your next actions."
          primaryHref={BASELINE_HREF}
          primaryLabel="Start baseline interview"
        />
      </main>
    )
  }

  if (loading) {
    return <PathwayLoading />
  }

  const viewModel = data
  const pathway = data?.pathway ?? null

  if (!viewModel || viewModel.state === 'empty') {
    const action = viewModel?.nextAction ?? {
      id: 'baseline-interview',
      type: 'interview' as const,
      title: 'Run a baseline interview',
      description: 'Complete one interview so Pathway can build a focused plan from your actual answers.',
      ctaLabel: 'Start baseline interview',
      href: BASELINE_HREF,
    }

    return (
      <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        <PathwayHeader />
        <PathwayEmptyState action={action} />
      </main>
    )
  }

  const supportDomain =
    pathway?.nextSessionRecommendation?.domain ||
    pathway?.targetRole ||
    'general'
  const supportDepth =
    pathway?.nextSessionRecommendation?.interviewType ||
    'behavioral'

  return (
    <main className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <PathwayHeader />

      {viewModel.state === 'unchanged' && (
        <PathwayUnchangedBanner action={viewModel.nextAction} />
      )}

      {viewModel.state === 'pending' && (
        <PathwayPendingBanner
          action={{
            ...viewModel.nextAction,
            metadata: {
              ...viewModel.nextAction.metadata,
              sessionId: fromFeedback ?? viewModel.nextAction.metadata?.sessionId,
            },
          }}
          pollExhausted={pollExhausted}
          onRetried={() => void loadPathway()}
        />
      )}

      {viewModel.state === 'failed' && (
        <PathwayFailedBanner
          action={viewModel.nextAction}
          onRetried={() => void loadPathway()}
        />
      )}

      <TodayActionCard
        action={viewModel.nextAction}
        state={viewModel.state}
        completing={!!completingTaskId && completingTaskId === viewModel.nextAction.taskId}
        onCompleteTask={completeTask}
      />

      {/* Pathway P2 Wave 4 — gap-aware coach observation. Self-hides
          when the gap is <3 days or there's no completed-session
          history. Sits between the action card (which drives action)
          and the panels (which review progress) so it contextualises
          the next move without becoming a nag. */}
      <DecayContextCard rhythm={viewModel.activityRhythm ?? null} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.85fr)]">
        <div className="space-y-6 min-w-0">
          <PathwayPlanQueue
            items={viewModel.planItems}
            completingTaskId={completingTaskId}
            onCompleteTask={completeTask}
          />
          <UniversalPathwayView
            domain={supportDomain}
            depth={supportDepth}
            mode="support"
            showEmptyState={false}
          />
        </div>
        <div className="space-y-6 min-w-0">
          <PathwayProgressPanel progress={viewModel.progress} />
          <PathwayActivityPanel />
        </div>
      </div>
    </main>
  )
}

function PathwayLoading() {
  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="animate-pulse space-y-6">
        <div className="h-8 bg-[#eff3f4] rounded w-48" />
        <div className="h-32 bg-[#eff3f4] rounded-xl" />
        <div className="h-56 bg-[#eff3f4] rounded-xl" />
      </div>
    </main>
  )
}

function PathwayHeader() {
  return (
    <motion.header
      className="space-y-1"
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <h1 className="text-2xl font-bold text-[#0f1419]">Learning Pathway</h1>
      <p className="text-sm text-[#71767b]">
        Your interview-derived improvement loop: next action, plan, progress, and recent activity.
      </p>
    </motion.header>
  )
}
