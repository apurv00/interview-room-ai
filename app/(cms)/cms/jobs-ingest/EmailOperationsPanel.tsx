'use client'

import { useCallback, useEffect, useState } from 'react'

const endpoint = '/api/cms/jobs-ingest/email'

const STREAMS = [
  {
    id: 'e0',
    key: 'e0Enabled',
    label: 'E0 — Requested practice link',
    detail: 'Transactional and exempt from the weekly solicitation cap.',
  },
  {
    id: 'e1',
    key: 'e1Enabled',
    label: 'E1 — Response nudge',
    detail: 'Solicitation; the weekly cap applies.',
  },
  {
    id: 'e2',
    key: 'e2Enabled',
    label: 'E2 — Interview reminder',
    detail: 'Transactional and exempt from the weekly solicitation cap.',
  },
  {
    id: 'e4',
    key: 'e4Enabled',
    label: 'E4 — Deferred practice',
    detail: 'Solicitation; the weekly cap applies.',
  },
] as const

interface EmailConfig {
  e0Enabled: boolean
  e1Enabled: boolean
  e2Enabled: boolean
  e4Enabled: boolean
  globalWeeklyCap: number
}

interface EmailConfigDraft {
  e0Enabled: boolean
  e1Enabled: boolean
  e2Enabled: boolean
  e4Enabled: boolean
  globalWeeklyCap: string
}

function draftOf(config: EmailConfig): EmailConfigDraft {
  return {
    e0Enabled: config.e0Enabled,
    e1Enabled: config.e1Enabled,
    e2Enabled: config.e2Enabled,
    e4Enabled: config.e4Enabled,
    globalWeeklyCap: String(config.globalWeeklyCap),
  }
}

function messageFrom(response: Response): Promise<string> {
  return response.json()
    .then((body: { error?: string }) => body.error || `Request failed with HTTP ${response.status}`)
    .catch(() => `Request failed with HTTP ${response.status}`)
}

export function EmailOperationsPanel() {
  const [config, setConfig] = useState<EmailConfig | null>(null)
  const [draft, setDraft] = useState<EmailConfigDraft | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null)
    const response = await fetch(endpoint, { cache: 'no-store', signal })
    if (!response.ok) {
      if (response.status === 401) throw new Error('Your admin session expired. Sign in again and reload this page.')
      if (response.status === 403) throw new Error('Your current account no longer has platform-admin access.')
      throw new Error(await messageFrom(response))
    }
    const payload = await response.json() as { config: EmailConfig }
    setConfig(payload.config)
    setDraft(draftOf(payload.config))
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : 'Failed to load email controls.')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [load])

  async function save() {
    if (!config || !draft || saving) return
    const cap = Number(draft.globalWeeklyCap)
    if (!Number.isInteger(cap) || cap < 0 || cap > 20) return

    const patch: Partial<EmailConfig> = {}
    for (const { key } of STREAMS) {
      if (draft[key] !== config[key]) patch[key] = draft[key]
    }
    if (cap !== config.globalWeeklyCap) patch.globalWeeklyCap = cap
    if (!Object.keys(patch).length) return

    setSaving(true)
    setError(null)
    setStatus(null)
    try {
      const response = await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!response.ok) {
        if (response.status === 401) throw new Error('Your admin session expired. Sign in again before saving.')
        if (response.status === 403) throw new Error('Your current role no longer authorizes this change.')
        throw new Error(await messageFrom(response))
      }
      const payload = await response.json() as { config?: EmailConfig }
      const committed = payload.config ?? { ...config, ...patch }
      setConfig(committed)
      setDraft(draftOf(committed))
      setStatus('Email controls saved. No email was sent or replayed.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to save email controls.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <section
        aria-labelledby="email-operations-heading"
        aria-busy="true"
        className="rounded-2xl border border-slate-200 bg-white p-6"
      >
        <h2 id="email-operations-heading" className="text-xl font-semibold text-slate-950">Jobs email controls</h2>
        <p className="mt-2 text-sm text-slate-600">Loading stream switches and solicitation cap…</p>
      </section>
    )
  }

  if (!config || !draft) {
    return (
      <section aria-labelledby="email-operations-heading" className="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 id="email-operations-heading" className="text-xl font-semibold text-slate-950">Jobs email controls</h2>
        <div role="alert" className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error ?? 'The email-control response was empty.'}
        </div>
        <button
          type="button"
          onClick={() => {
            setLoading(true)
            void load()
              .catch((caught) => setError(caught instanceof Error ? caught.message : 'Failed to load email controls.'))
              .finally(() => setLoading(false))
          }}
          className="mt-3 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-blue-400 hover:text-blue-800"
        >
          Retry
        </button>
      </section>
    )
  }

  const cap = Number(draft.globalWeeklyCap)
  const capValid = draft.globalWeeklyCap.trim() !== '' && Number.isInteger(cap) && cap >= 0 && cap <= 20
  const changed = STREAMS.some(({ key }) => draft[key] !== config[key]) ||
    (capValid && cap !== config.globalWeeklyCap)

  return (
    <section
      aria-labelledby="email-operations-heading"
      aria-busy={saving}
      className="rounded-2xl border border-slate-200 bg-white p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="email-operations-heading" className="text-xl font-semibold text-slate-950">Jobs email controls</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Every stream defaults off. Saving changes only future eligibility; it does not send or replay email.
          </p>
        </div>
        <button
          type="button"
          disabled={!changed || !capValid || saving}
          onClick={() => void save()}
          className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save email controls'}
        </button>
      </div>

      <div aria-live="polite" aria-atomic="true">
        {status ? <div role="status" className="mt-4 rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-800">{status}</div> : null}
      </div>
      {error ? <div role="alert" className="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}

      <fieldset disabled={saving} className="mt-5 grid gap-3 md:grid-cols-2">
        <legend className="sr-only">Jobs email stream switches</legend>
        {STREAMS.map((stream) => (
          <label key={stream.id} className="flex items-start gap-3 rounded-xl border border-slate-200 p-4">
            <input
              type="checkbox"
              checked={draft[stream.key]}
              onChange={(event) => {
                const checked = event.target.checked
                setDraft((current) => current ? { ...current, [stream.key]: checked } : current)
                setStatus(null)
              }}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-semibold text-slate-950">{stream.label}</span>
              <span className="mt-1 block text-xs leading-5 text-slate-600">{stream.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="mt-5 max-w-sm">
        <label htmlFor="jobs-email-weekly-cap" className="block text-sm font-semibold text-slate-900">
          Weekly solicitation cap per user
        </label>
        <input
          id="jobs-email-weekly-cap"
          type="number"
          min={0}
          max={20}
          step={1}
          value={draft.globalWeeklyCap}
          disabled={saving}
          aria-invalid={!capValid}
          aria-describedby="jobs-email-weekly-cap-help"
          onChange={(event) => {
            setDraft((current) => current ? { ...current, globalWeeklyCap: event.target.value } : current)
            setStatus(null)
          }}
          className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:opacity-60"
        />
        <p id="jobs-email-weekly-cap-help" className={`mt-1 text-xs ${capValid ? 'text-slate-500' : 'text-red-700'}`}>
          {capValid
            ? 'Integer from 0 to 20. Applies to E1 and E4; E0 and E2 remain cap-exempt.'
            : 'Enter a whole number from 0 to 20.'}
        </p>
      </div>
    </section>
  )
}
