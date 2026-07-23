'use client'

import { useCallback, useEffect, useState } from 'react'

type JobsEmailStream = 'e0' | 'e1' | 'e2' | 'e4'

interface JobsEmailEnabled {
  e0: boolean
  e1: boolean
  e2: boolean
  e4: boolean
}

interface JobsEmailPreferencesPayload {
  enabled: JobsEmailEnabled
  quietHours: {
    label: string
    timezone: string
  }
}

const OPTIONS: Array<{
  stream: JobsEmailStream
  label: string
  description: string
}> = [
  {
    stream: 'e0',
    label: 'Requested practice links',
    description: 'Email a practice link only when you explicitly request one.',
  },
  {
    stream: 'e1',
    label: '14-day application check-ins',
    description: 'Ask for a tracker update 14 days after you mark an application as applied.',
  },
  {
    stream: 'e2',
    label: 'Exact interview reminders',
    description: 'Remind you before an interview only when you saved an exact interview date.',
  },
  {
    stream: 'e4',
    label: 'Deferred-practice reminders',
    description: 'Remind you 3–14 days after you click Apply or mark a job applied, if you have not practised for it.',
  },
]

function isPreferencesPayload(value: unknown): value is JobsEmailPreferencesPayload {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<JobsEmailPreferencesPayload>
  const enabled = candidate.enabled as Partial<JobsEmailEnabled> | undefined
  return !!enabled &&
    typeof enabled.e0 === 'boolean' &&
    typeof enabled.e1 === 'boolean' &&
    typeof enabled.e2 === 'boolean' &&
    typeof enabled.e4 === 'boolean' &&
    typeof candidate.quietHours?.label === 'string' &&
    typeof candidate.quietHours?.timezone === 'string'
}

async function failureMessage(response: Response, fallback: string): Promise<string> {
  let code: string | undefined
  try {
    const body = await response.json() as { code?: string }
    code = body.code
  } catch {
    // The status code still provides useful recovery copy.
  }
  if (response.status === 401 && code === 'ACCOUNT_UNAVAILABLE') {
    return 'Job email preferences are unavailable for this account.'
  }
  if (response.status === 401) {
    return 'Your session expired. Sign in again and reload this page.'
  }
  return fallback
}

function everyStream(enabled: boolean): JobsEmailEnabled {
  return { e0: enabled, e1: enabled, e2: enabled, e4: enabled }
}

export default function JobsEmailPreferences() {
  const [preferences, setPreferences] = useState<JobsEmailPreferencesPayload | null>(null)
  const [savedEnabled, setSavedEnabled] = useState<JobsEmailEnabled | null>(null)
  const [pendingEnabled, setPendingEnabled] = useState<Partial<JobsEmailEnabled>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveMessage, setSaveMessage] = useState<
    { kind: 'success' | 'error'; text: string } | null
  >(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setLoadError(null)
    try {
      const response = await fetch('/api/settings/jobs-email', {
        cache: 'no-store',
        signal,
      })
      if (!response.ok) {
        throw new Error(await failureMessage(
          response,
          'Could not load job email preferences. Please try again.',
        ))
      }
      const payload: unknown = await response.json()
      if (!isPreferencesPayload(payload)) {
        throw new Error('Could not load job email preferences. Please try again.')
      }
      if (!signal?.aborted) {
        setPreferences(payload)
        setSavedEnabled(payload.enabled)
        setPendingEnabled({})
      }
    } catch (error) {
      if (!signal?.aborted) {
        setLoadError(error instanceof Error
          ? error.message
          : 'Could not load job email preferences. Please try again.')
      }
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const setStream = (stream: JobsEmailStream, enabled: boolean) => {
    setPreferences((current) => current
      ? { ...current, enabled: { ...current.enabled, [stream]: enabled } }
      : current)
    setPendingEnabled((current) => {
      const next = { ...current }
      if (savedEnabled?.[stream] === enabled) delete next[stream]
      else next[stream] = enabled
      return next
    })
    setSaveMessage(null)
  }

  const setEveryStream = (enabled: boolean) => {
    setPreferences((current) => current
      ? { ...current, enabled: everyStream(enabled) }
      : current)
    // A global action is explicit for every stream, including values that
    // happened to match this tab's stale baseline.
    setPendingEnabled(everyStream(enabled))
    setSaveMessage(null)
  }

  const hasChanges = Object.keys(pendingEnabled).length > 0

  const save = async () => {
    if (!preferences || !hasChanges || saving) return
    setSaving(true)
    setSaveMessage(null)
    try {
      const response = await fetch('/api/settings/jobs-email', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: pendingEnabled }),
      })
      if (!response.ok) {
        throw new Error(await failureMessage(
          response,
          'Could not save job email preferences. Please try again.',
        ))
      }
      const payload: unknown = await response.json()
      if (!isPreferencesPayload(payload)) {
        throw new Error('Could not save job email preferences. Please try again.')
      }
      setPreferences(payload)
      setSavedEnabled(payload.enabled)
      setPendingEnabled({})
      setSaveMessage({ kind: 'success', text: 'Job email preferences saved.' })
    } catch (error) {
      setSaveMessage({
        kind: 'error',
        text: error instanceof Error
          ? error.message
          : 'Could not save job email preferences. Please try again.',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="bg-white border border-[#e1e8ed] rounded-2xl p-6 animate-fade-in">
      <h2 className="text-sm font-semibold text-[#536471] uppercase tracking-widest">
        Job email notifications
      </h2>
      <p className="text-sm text-[#536471] mt-2">
        Choose which job emails you allow. Messages are sent only when their trigger
        and operational checks pass.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-[#536471]" role="status">
          <span className="w-4 h-4 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
          Loading job email preferences…
        </div>
      ) : loadError || !preferences || !savedEnabled ? (
        <div className="mt-4">
          <p className="text-sm text-red-700" role="alert">
            {loadError ?? 'Could not load job email preferences. Please try again.'}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 rounded-lg border border-[#cfd9de] px-3 py-2 text-sm font-medium text-[#0f1419] hover:border-[#2563eb]"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setEveryStream(true)}
              disabled={saving || OPTIONS.every(({ stream }) => preferences.enabled[stream])}
              className="rounded-lg border border-[#cfd9de] px-3 py-2 text-sm font-medium text-[#0f1419] hover:border-[#2563eb] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Turn on all job emails
            </button>
            <button
              type="button"
              onClick={() => setEveryStream(false)}
              disabled={saving || OPTIONS.every(({ stream }) => !preferences.enabled[stream])}
              className="rounded-lg border border-[#cfd9de] px-3 py-2 text-sm font-medium text-[#0f1419] hover:border-[#2563eb] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Turn off all job emails
            </button>
          </div>

          <fieldset className="mt-3 divide-y divide-[#eff3f4]">
            <legend className="sr-only">Job email types</legend>
            {OPTIONS.map((option) => (
              <div
                key={option.stream}
                className="flex items-start justify-between gap-4 py-4"
              >
                <span>
                  <label
                    id={`jobs-email-${option.stream}-label`}
                    htmlFor={`jobs-email-${option.stream}`}
                    className="block text-sm font-medium text-[#0f1419] cursor-pointer"
                  >
                    {option.label}
                  </label>
                  <span
                    id={`jobs-email-${option.stream}-description`}
                    className="block text-xs text-[#536471] mt-1"
                  >
                    {option.description}
                  </span>
                </span>
                <input
                  id={`jobs-email-${option.stream}`}
                  type="checkbox"
                  aria-labelledby={`jobs-email-${option.stream}-label`}
                  aria-describedby={`jobs-email-${option.stream}-description`}
                  checked={preferences.enabled[option.stream]}
                  disabled={saving}
                  onChange={(event) => setStream(option.stream, event.target.checked)}
                  className="mt-1 h-5 w-5 rounded border-[#cfd9de] text-[#2563eb] focus:ring-[#2563eb]"
                />
              </div>
            ))}
          </fieldset>

          <div className="mt-4 rounded-xl bg-[#f8fafc] border border-[#e1e8ed] px-4 py-3">
            <p className="text-sm font-medium text-[#0f1419]">
              Send window: {preferences.quietHours.label}
            </p>
            <p className="text-xs text-[#536471] mt-1">
              Send attempts use {preferences.quietHours.timezone} and do not follow
              your device timezone.
            </p>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={saving || !hasChanges}
              className="px-4 py-2 rounded-lg bg-[#2563eb] text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition"
            >
              {saving ? 'Saving…' : 'Save job email preferences'}
            </button>
            {saveMessage && (
              <p
                className={`text-sm ${
                  saveMessage.kind === 'success' ? 'text-emerald-700' : 'text-red-700'
                }`}
                role={saveMessage.kind === 'error' ? 'alert' : 'status'}
              >
                {saveMessage.text}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  )
}
