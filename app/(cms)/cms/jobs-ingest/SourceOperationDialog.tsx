'use client'

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type {
  JobsSourceAction,
  SourceOperationSubmission,
  SourceRow,
  SourceSettings,
} from './types'

interface SourceOperationDialogProps {
  action: JobsSourceAction
  source: SourceRow | null
  busy: boolean
  error: string | null
  bootstrapRepairs?: string[]
  onClose: () => void
  onSubmit: (submission: SourceOperationSubmission) => void
}

const ACTION_COPY: Record<JobsSourceAction, { title: string; submit: string; description: string }> = {
  bootstrap: {
    title: 'Initialize source catalog',
    submit: 'Initialize sources',
    description: 'Prepare exact indexes, seed missing reviewed rows, normalize unsafe policy, invalidate repaired validation, and pause unaudited enabled legacy rows when required. This does not start ingestion.',
  },
  enable: {
    title: 'Enable source',
    submit: 'Enable source',
    description: 'Allow scheduled and manual syncs using the saved cadence and hard request caps.',
  },
  pause: {
    title: 'Pause source',
    submit: 'Pause source',
    description: 'Invalidate queued source generations and stop future writes. Existing job rows remain unchanged.',
  },
  'update-settings': {
    title: 'Update source settings',
    submit: 'Save settings',
    description: 'Saving settings pauses the source if it is active and invalidates earlier validation. Run Validate, review the result, then Enable explicitly.',
  },
  'run-now': {
    title: 'Queue source sync',
    submit: 'Queue sync',
    description: 'Skip the scheduler wait. Success means queued, not completed; the cycle result will appear after the worker finishes.',
  },
  validate: {
    title: 'Validate source',
    submit: 'Queue validation',
    description: 'Run a cold provider check without storing or reopening job content. Validation does not enable the source.',
  },
  revoke: {
    title: 'Revoke source authority',
    submit: 'Revoke source',
    description: 'Disable this source and restrict every canonical row carrying its lineage. Rows are retained, not deleted.',
  },
  restore: {
    title: 'Record legal clearance',
    submit: 'Restore to quarantine',
    description: 'Record clearance and move the source to paused quarantine. Existing jobs remain restricted and cold validation is still required.',
  },
}

const REASON_ACTIONS = new Set<JobsSourceAction>([
  'enable',
  'pause',
  'update-settings',
  'validate',
  'revoke',
  'restore',
])

function numberOrUndefined(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function settingsFromSource(source: SourceRow | null): Record<keyof SourceSettings, string | boolean> {
  const settings = source?.settings
  return {
    cadenceMinutes: settings == null ? '' : String(settings.cadenceMinutes),
    minIndiaPostings: settings?.minIndiaPostings == null ? '' : String(settings.minIndiaPostings),
    perRunRequestCap: settings == null ? '' : String(settings.perRunRequestCap),
    dailyRequestCap: settings == null ? '' : String(settings.dailyRequestCap),
    monthlyRequestCap: settings == null ? '' : String(settings.monthlyRequestCap),
    llmVerdictOptOut: settings?.llmVerdictOptOut ?? false,
    notes: settings?.notes ?? '',
  }
}

export function SourceOperationDialog({
  action,
  source,
  busy,
  error,
  bootstrapRepairs = [],
  onClose,
  onSubmit,
}: SourceOperationDialogProps) {
  const [reason, setReason] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [settings, setSettings] = useState(() => settingsFromSource(source))
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const copy = ACTION_COPY[action]
  const needsReason = REASON_ACTIONS.has(action)
  const needsTypedConfirmation = action === 'revoke'
  const settingsWillPause = action === 'update-settings' && source?.enabled === true
  const submitLabel = settingsWillPause ? 'Save settings and pause' : copy.submit

  useEffect(() => {
    setReason('')
    setConfirmation('')
    setSettings(settingsFromSource(source))
    closeButtonRef.current?.focus()
  }, [action, source])

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled])',
    )
    if (!focusable?.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const submission: SourceOperationSubmission = {
      action,
      ...(needsReason ? { reason: reason.trim() } : {}),
      ...(needsTypedConfirmation ? { confirmation } : {}),
    }
    if (action === 'update-settings') {
      submission.settings = {
        cadenceMinutes: numberOrUndefined(String(settings.cadenceMinutes)),
        minIndiaPostings: String(settings.minIndiaPostings).trim() === ''
          ? null
          : numberOrUndefined(String(settings.minIndiaPostings)),
        perRunRequestCap: numberOrUndefined(String(settings.perRunRequestCap)),
        dailyRequestCap: numberOrUndefined(String(settings.dailyRequestCap)),
        monthlyRequestCap: numberOrUndefined(String(settings.monthlyRequestCap)),
        llmVerdictOptOut: Boolean(settings.llmVerdictOptOut),
        notes: String(settings.notes).trim(),
      }
    }
    onSubmit(submission)
  }

  const reasonValid = !needsReason || reason.trim().length >= 8
  const confirmationValid = !needsTypedConfirmation || confirmation === source?.sourceId
  const sourceLabel = source ? `${source.displayName} (${source.sourceId})` : 'reviewed catalog'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-operation-title"
        aria-describedby="source-operation-description"
        onKeyDown={handleDialogKeyDown}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white shadow-2xl"
      >
        <form onSubmit={handleSubmit}>
          <header className="flex items-start justify-between gap-4 border-b border-slate-200 p-6">
            <div>
              <h2 id="source-operation-title" className="text-xl font-semibold text-slate-950">
                {copy.title}
              </h2>
              <p className="mt-1 text-sm text-slate-600">{sourceLabel}</p>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              disabled={busy}
              aria-label={`Close ${copy.title.toLowerCase()} dialog`}
              className="rounded-lg px-3 py-1 text-xl text-slate-500 hover:bg-slate-100 disabled:opacity-50"
            >
              ×
            </button>
          </header>

          <div className="space-y-5 p-6">
            <p id="source-operation-description" className="text-sm leading-6 text-slate-700">
              {copy.description}
            </p>
            {action === 'bootstrap' && bootstrapRepairs.length ? (
              <ul className="mt-2 list-disc pl-5 text-sm leading-6 text-slate-700">
                {bootstrapRepairs.map((repair) => <li key={repair}>{repair}</li>)}
              </ul>
            ) : null}

            {action === 'run-now' && source && source.budget.percent != null && source.budget.percent >= 80 ? (
              <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                This source has used {source.budget.percent}% of its current budget. The hard cap still applies to this run.
              </div>
            ) : null}

            {action === 'update-settings' ? (
              <fieldset className="grid gap-4 sm:grid-cols-2">
                <legend className="mb-3 text-sm font-semibold text-slate-900">Bounded collection settings</legend>
                <NumberField label="Cadence (minutes)" min={source!.limits.cadenceMinutes.min} max={source!.limits.cadenceMinutes.max} value={String(settings.cadenceMinutes)} onChange={(value) => setSettings((current) => ({ ...current, cadenceMinutes: value }))} />
                <NumberField label="Minimum India postings" min={source!.limits.minIndiaPostings.min} max={source!.limits.minIndiaPostings.max} value={String(settings.minIndiaPostings)} onChange={(value) => setSettings((current) => ({ ...current, minIndiaPostings: value }))} optional />
                <NumberField label="Per-run request cap" min={source!.limits.perRunRequestCap.min} max={source!.limits.perRunRequestCap.max} value={String(settings.perRunRequestCap)} onChange={(value) => setSettings((current) => ({ ...current, perRunRequestCap: value }))} />
                <NumberField label="Daily request cap" min={source!.limits.dailyRequestCap.min} max={source!.limits.dailyRequestCap.max} value={String(settings.dailyRequestCap)} onChange={(value) => setSettings((current) => ({ ...current, dailyRequestCap: value }))} />
                <NumberField label="Monthly request cap" min={source!.limits.monthlyRequestCap.min} max={source!.limits.monthlyRequestCap.max} value={String(settings.monthlyRequestCap)} onChange={(value) => setSettings((current) => ({ ...current, monthlyRequestCap: value }))} />
                <label className="flex items-center gap-3 self-end rounded-lg border border-slate-200 p-3 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    checked={Boolean(settings.llmVerdictOptOut)}
                    onChange={(event) => setSettings((current) => ({ ...current, llmVerdictOptOut: event.target.checked }))}
                  />
                  Exclude source content from LLM verdicts
                </label>
                <label className="sm:col-span-2">
                  <span className="mb-1 block text-sm font-medium text-slate-800">Operator notes</span>
                  <textarea
                    maxLength={2000}
                    rows={3}
                    value={String(settings.notes)}
                    onChange={(event) => setSettings((current) => ({ ...current, notes: event.target.value }))}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-100"
                  />
                </label>
              </fieldset>
            ) : null}

            {needsReason ? (
              <div>
                <label htmlFor="source-operation-reason" className="mb-1 block text-sm font-medium text-slate-800">
                  Case reference or operational reason
                </label>
                <textarea
                  id="source-operation-reason"
                  required
                  minLength={8}
                  maxLength={1000}
                  rows={3}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  aria-describedby="source-operation-reason-help"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-100"
                />
                <span id="source-operation-reason-help" className="mt-1 block text-xs text-slate-500">
                  Minimum 8 characters. Use a non-sensitive case reference; do not enter personal or privileged narrative.
                </span>
              </div>
            ) : null}

            {needsTypedConfirmation ? (
              <div>
                <label htmlFor="source-operation-confirmation" className="mb-1 block text-sm font-medium text-red-800">
                  Type {source?.sourceId} to confirm
                </label>
                <input
                  id="source-operation-confirmation"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  className="w-full rounded-lg border border-red-300 px-3 py-2 font-mono text-sm focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-100"
                />
              </div>
            ) : null}

            {error ? (
              <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
                {error}
              </div>
            ) : null}
          </div>

          <footer className="flex flex-wrap justify-end gap-3 border-t border-slate-200 p-6">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !reasonValid || !confirmationValid}
              aria-busy={busy}
              className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 ${
                action === 'revoke' ? 'bg-red-700 hover:bg-red-800' : 'bg-blue-700 hover:bg-blue-800'
              }`}
            >
              {busy ? 'Working…' : submitLabel}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}

interface NumberFieldProps {
  label: string
  min: number
  max: number
  value: string
  optional?: boolean
  onChange: (value: string) => void
}

function NumberField({ label, min, max, value, optional = false, onChange }: NumberFieldProps) {
  return (
    <label>
      <span className="mb-1 block text-sm font-medium text-slate-800">{label}</span>
      <input
        type="number"
        required={!optional}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-100"
      />
    </label>
  )
}
