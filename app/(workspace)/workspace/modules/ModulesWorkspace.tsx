'use client'

import { useCallback, useEffect, useState } from 'react'
import Badge from '@shared/ui/Badge'
import StateView from '@shared/ui/StateView'

interface CommercialModuleView {
  id: 'core' | 'screen' | 'decide' | 'operate'
  name: string
  summary: string
  capabilities: string[]
  available: true
  commercialState: 'included' | 'not_selected'
}

interface CommercialWorkspaceView {
  catalogVersion: string
  enforcement: 'shadow'
  source: 'compatibility_default' | 'persisted_account'
  pilotStatus: 'not_requested' | 'requested' | 'active'
  usage: {
    screenAssessmentsCompleted: number
    measurementStartedAt: string | null
    scope: 'shadow_era'
  }
  modules: CommercialModuleView[]
}

function isCommercialWorkspaceView(
  value: unknown,
): value is CommercialWorkspaceView {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CommercialWorkspaceView>
  const measurementStartedAt = candidate.usage?.measurementStartedAt
  return (
    typeof candidate.catalogVersion === 'string' &&
    candidate.enforcement === 'shadow' &&
    ['compatibility_default', 'persisted_account'].includes(
      candidate.source ?? '',
    ) &&
    ['not_requested', 'requested', 'active'].includes(
      candidate.pilotStatus ?? '',
    ) &&
    Boolean(candidate.usage) &&
    Number.isInteger(candidate.usage?.screenAssessmentsCompleted) &&
    (candidate.usage?.screenAssessmentsCompleted ?? -1) >= 0 &&
    (measurementStartedAt === null ||
      (typeof measurementStartedAt === 'string' &&
        Number.isFinite(Date.parse(measurementStartedAt)))) &&
    candidate.usage?.scope === 'shadow_era' &&
    Array.isArray(candidate.modules) &&
    candidate.modules.every(
      (module) =>
        module &&
        ['core', 'screen', 'decide', 'operate'].includes(module.id) &&
        typeof module.name === 'string' &&
        typeof module.summary === 'string' &&
        Array.isArray(module.capabilities) &&
        module.capabilities.every((capability) => typeof capability === 'string') &&
        module.available === true &&
        ['included', 'not_selected'].includes(module.commercialState),
    )
  )
}

export default function ModulesWorkspace() {
  const [view, setView] = useState<CommercialWorkspaceView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const response = await fetch('/api/workspace/modules', {
        cache: 'no-store',
      })
      const data: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(
          response.status === 403
            ? 'Only the workspace administrator can view modules.'
            : 'Could not load the module catalog.',
        )
      }
      if (!isCommercialWorkspaceView(data)) {
        throw new Error('The module catalog response was not valid.')
      }
      setView(data)
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Could not load the module catalog.',
      )
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (error && !view) {
    return <StateView state="error" error={error} onRetry={load} />
  }
  if (!view) return <StateView state="loading" skeletonLayout="grid" />

  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-600">
            Commercial preview
          </p>
          <h1 className="mt-1 text-xl font-bold text-[#0f1419]">Hire modules</h1>
          <p className="mt-1 max-w-2xl text-sm text-[#536471]">
            Review how today&apos;s Hire capabilities map to Core, Screen, Decide,
            and Operate. This preview does not change access or start billing.
          </p>
        </div>
        {view.pilotStatus === 'not_requested' ? (
          <a
            href="mailto:contact@interviewprep.guru?subject=IPG%20Hire%20modules%20pilot"
            className="inline-flex h-10 shrink-0 items-center justify-center rounded-lg bg-[#0f1419] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#272c30] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
          >
            Request pilot
          </a>
        ) : (
          <Badge
            variant={view.pilotStatus === 'active' ? 'success' : 'caution'}
            className="h-auto min-h-8 shrink-0 whitespace-nowrap px-3"
          >
            {view.pilotStatus === 'active' ? 'Pilot active' : 'Pilot requested'}
          </Badge>
        )}
      </header>

      <div className="rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4 text-sm text-indigo-950">
        <p className="font-semibold">Compatibility mode is active</p>
        <p className="mt-1 text-indigo-800">
          All current capabilities remain available. Module selections are
          informational while the pilot is evaluated; there is no checkout.
        </p>
      </div>

      <section
        aria-labelledby="shadow-usage-heading"
        className="rounded-2xl border border-[#e1e8ed] bg-white p-5"
      >
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <h2 id="shadow-usage-heading" className="font-semibold text-[#0f1419]">
              Shadow usage
            </h2>
            <p className="mt-1 text-sm text-[#536471]">
              A measurement preview for pilot planning, not a bill or lifetime
              account total.
            </p>
          </div>
          <dl className="min-w-48 rounded-xl bg-[#f7f9f9] px-4 py-3">
            <dt className="text-xs text-[#71767b]">Screen assessments completed</dt>
            <dd className="mt-1 text-2xl font-bold text-[#0f1419]">
              {view.usage.screenAssessmentsCompleted}
            </dd>
          </dl>
        </div>
        <p className="mt-3 text-xs text-[#71767b]">
          {view.usage.measurementStartedAt
            ? `Measured since ${new Intl.DateTimeFormat(undefined, {
                dateStyle: 'medium',
              }).format(new Date(view.usage.measurementStartedAt))}.`
            : 'No shadow-era completions measured yet; earlier historical activity is not included.'}
        </p>
      </section>

      <section aria-label="Hire module catalog" className="grid gap-4 md:grid-cols-2">
        {view.modules.map((module) => (
          <article
            key={module.id}
            className="rounded-2xl border border-[#e1e8ed] bg-white p-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-[#0f1419]">{module.name}</h2>
                <p className="mt-1 text-sm text-[#536471]">{module.summary}</p>
              </div>
              <Badge
                variant={module.commercialState === 'included' ? 'success' : 'default'}
                className="h-auto min-h-5 shrink-0 whitespace-nowrap"
              >
                {module.commercialState === 'included'
                  ? 'Included today'
                  : 'Available today'}
              </Badge>
            </div>
            <ul className="mt-4 space-y-2 text-sm text-[#536471]">
              {module.capabilities.map((capability) => (
                <li key={capability} className="flex gap-2">
                  <span aria-hidden="true" className="text-emerald-600">
                    ✓
                  </span>
                  <span>{capability}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <p className="text-xs text-[#71767b]">
        Catalog {view.catalogVersion}. Pricing and checkout are intentionally not
        part of this preview.
      </p>
    </div>
  )
}
