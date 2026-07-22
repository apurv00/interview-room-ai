'use client'

import { useRef, useState, type FormEvent } from 'react'

export type InterviewDateRequest =
  | { choice: 'tomorrow' | 'this-week' | 'next-week' | 'not-sure' }
  | { date: string }
export type InterviewDateCaptureResult =
  | void
  | 'state-conflict-refreshed'
  | 'state-conflict-refresh-failed'

const DATE_CHOICES = [
  ['tomorrow', 'Tomorrow'],
  ['this-week', 'This week — preference'],
  ['next-week', 'Next week — preference'],
  ['not-sure', 'Not sure yet'],
] as const

export default function InterviewDateControls({
  onCapture,
  disabled = false,
}: {
  onCapture: (request: InterviewDateRequest) => Promise<InterviewDateCaptureResult>
  disabled?: boolean
}) {
  const [exactDate, setExactDate] = useState('')
  const [saveState, setSaveState] = useState<
    'idle' | 'saving' | 'error' | 'conflict-refreshed' | 'conflict-refresh-failed'
  >('idle')
  const savingRef = useRef(false)
  const captureDisabled = disabled || saveState === 'saving'

  async function capture(request: InterviewDateRequest) {
    if (disabled || savingRef.current) return
    savingRef.current = true
    setSaveState('saving')
    try {
      const result = await onCapture(request)
      if (result === 'state-conflict-refreshed') {
        setSaveState('conflict-refreshed')
        return
      }
      if (result === 'state-conflict-refresh-failed') {
        setSaveState('conflict-refresh-failed')
        return
      }
      setSaveState('idle')
      setExactDate('')
    } catch {
      setSaveState('error')
    } finally {
      savingRef.current = false
    }
  }

  function submitExactDate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (exactDate) void capture({ date: exactDate })
  }

  return (
    <div className="mt-2" aria-busy={saveState === 'saving'}>
      <p className="text-xs text-slate-600">When is it?</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {DATE_CHOICES.map(([choice, label]) => (
          <button
            key={choice}
            type="button"
            onClick={() => void capture({ choice })}
            disabled={captureDisabled}
            className="rounded-full border border-slate-200 px-2.5 py-1 text-xs hover:bg-white disabled:cursor-wait disabled:opacity-50"
          >
            {label}
          </button>
        ))}
      </div>
      <form onSubmit={submitExactDate} className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">
          Exact interview date
          <input
            type="date"
            disabled={captureDisabled}
            value={exactDate}
            onChange={(event) => setExactDate(event.target.value)}
            className="mt-1 block rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900"
          />
        </label>
        <button
          type="submit"
          disabled={captureDisabled || !exactDate}
          className="rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          Save exact date
        </button>
      </form>
      {saveState === 'saving' && <p role="status" className="mt-1 text-xs text-slate-500">Saving interview timing…</p>}
      {saveState === 'error' && <p role="alert" className="mt-1 text-xs text-red-700">Couldn&apos;t save interview timing. Try again.</p>}
      {saveState === 'conflict-refreshed' && (
        <p role="alert" className="mt-1 text-xs text-amber-700">
          The interview changed elsewhere. Review the refreshed round, then save its timing.
        </p>
      )}
      {saveState === 'conflict-refresh-failed' && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          The interview changed elsewhere. Refresh this page before saving timing again.
        </p>
      )}
    </div>
  )
}
