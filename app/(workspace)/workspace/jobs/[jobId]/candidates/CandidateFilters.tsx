'use client'

import { useEffect, useState, type FormEvent } from 'react'
import Button from '@shared/ui/Button'
import {
  CANDIDATE_SORTS,
  CANDIDATE_STAGE_LABEL,
  CANDIDATE_STAGES,
  SAVED_VIEWS,
  type CandidateSavedView,
  type CandidateSort,
} from './candidateWorkspaceTypes'

export interface CandidateFilterState {
  view: CandidateSavedView
  q: string
  stage: string
  source: string
  appliedFrom: string
  appliedTo: string
  scoreState: string
  scoreMin: string
  scoreMax: string
  humanReview: string
  aiInterview: string
  history: string
  sort: CandidateSort
  direction: 'asc' | 'desc'
}

interface CandidateFiltersProps {
  value: CandidateFilterState
  viewCounts: Record<CandidateSavedView, number> | null
  disabled: boolean
  onChange: (patch: Partial<CandidateFilterState>) => void
  onClear: () => void
}

const SELECT_CLASS = 'h-9 w-full rounded-lg border border-[#dbe4ea] bg-white px-3 text-sm text-[#0f1419] focus:border-[#2563eb] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/20'

interface CsvFilterOption {
  value: string
  label: string
}

const SOURCE_OPTIONS: CsvFilterOption[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'apply_page', label: 'Apply page' },
  { value: 'bulk_upload', label: 'Bulk upload' },
  { value: 'pool', label: 'Talent pool' },
]
const JD_STATE_OPTIONS: CsvFilterOption[] = [
  { value: 'fresh', label: 'Fresh' },
  { value: 'stale', label: 'Needs refresh' },
  { value: 'pending', label: 'Pending' },
  { value: 'unscored', label: 'Unscored' },
]
const HUMAN_REVIEW_OPTIONS: CsvFilterOption[] = [
  { value: 'none', label: 'Not requested' },
  { value: 'pending', label: 'Pending' },
  { value: 'complete', label: 'Complete' },
  { value: 'mixed', label: 'Submitted and pending' },
  { value: 'disagreement', label: 'Reviewers disagree' },
]
const AI_INTERVIEW_OPTIONS: CsvFilterOption[] = [
  { value: 'not_invited', label: 'Not invited' },
  { value: 'invited', label: 'Invited' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'revoked', label: 'Revoked' },
]

function CheckboxFilterGroup({
  legend,
  description,
  value,
  options,
  disabled,
  onChange,
}: {
  legend: string
  description?: string
  value: string
  options: CsvFilterOption[]
  disabled: boolean
  onChange: (value: string) => void
}) {
  const selected = new Set(value.split(',').filter(Boolean))

  function toggle(optionValue: string, checked: boolean) {
    const next = new Set(selected)
    if (checked) next.add(optionValue)
    else next.delete(optionValue)
    onChange(options.filter((option) => next.has(option.value)).map((option) => option.value).join(','))
  }

  return (
    <fieldset className="rounded-xl border border-[#e6ecf0] p-3">
      <legend className="px-1 text-xs font-semibold text-[#536471]">{legend}</legend>
      {description ? <p className="mb-2 text-xs leading-5 text-[#71767b]">{description}</p> : null}
      <div className="mt-1 space-y-2">
        {options.map((option) => (
          <label key={option.value} className="flex items-start gap-2 text-sm text-[#0f1419]">
            <input
              type="checkbox"
              checked={selected.has(option.value)}
              disabled={disabled}
              onChange={(event) => toggle(option.value, event.target.checked)}
              className="mt-0.5"
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {selected.size === 0 ? <p className="mt-2 text-xs text-[#71767b]">All values included</p> : null}
    </fieldset>
  )
}

export default function CandidateFilters({ value, viewCounts, disabled, onChange, onClear }: CandidateFiltersProps) {
  const [query, setQuery] = useState(value.q)
  const directionLocked = value.sort === 'newest' || value.sort === 'oldest'

  useEffect(() => setQuery(value.q), [value.q])

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onChange({ q: query.trim() })
  }

  const hasAdvancedFilters = Boolean(
    value.stage || value.source || value.appliedFrom || value.appliedTo || value.scoreState ||
    value.scoreMin || value.scoreMax || value.humanReview || value.aiInterview || value.history,
  )

  return (
    <div className="space-y-4">
      <nav aria-label="Candidate saved views" className="-mx-1 overflow-x-auto px-1 pb-1">
        <ul className="flex min-w-max gap-2">
          {SAVED_VIEWS.map((view) => {
            const current = value.view === view.id
            return (
              <li key={view.id}>
                <button
                  type="button"
                  aria-pressed={current}
                  disabled={disabled}
                  onClick={() => onChange({ view: view.id })}
                  className={`rounded-full border px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-60 ${
                    current
                      ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
                      : 'border-[#dbe4ea] bg-white text-[#536471] hover:text-[#0f1419]'
                  }`}
                >
                  {view.label}{' '}
                  <span className="font-normal">{viewCounts ? `${viewCounts[view.id].toLocaleString()} job total` : '— job total'}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="flex flex-col gap-3 rounded-2xl border border-[#dbe4ea] bg-white p-4 xl:flex-row xl:items-end">
        <form className="flex min-w-0 flex-1 gap-2" role="search" onSubmit={search}>
          <div className="min-w-0 flex-1">
            <label htmlFor="job-candidate-search" className="sr-only">Search candidates by name or email</label>
            <input
              id="job-candidate-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name or email"
              maxLength={120}
              className={SELECT_CLASS}
            />
          </div>
          <Button type="submit" variant="secondary" disabled={disabled}>Search</Button>
        </form>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[180px_150px_auto]">
          <div>
            <label htmlFor="candidate-sort" className="mb-1 block text-xs font-medium text-[#536471]">Sort by</label>
            <select id="candidate-sort" value={value.sort} onChange={(event) => onChange({ sort: event.target.value as CandidateSort })} className={SELECT_CLASS} disabled={disabled}>
              {CANDIDATE_SORTS.map((sort) => <option key={sort.id} value={sort.id}>{sort.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="candidate-sort-order" className="mb-1 block text-xs font-medium text-[#536471]">Direction</label>
            <select
              id="candidate-sort-order"
              value={value.direction}
              onChange={(event) => onChange({ direction: event.target.value === 'asc' ? 'asc' : 'desc' })}
              className={SELECT_CLASS}
              disabled={disabled || directionLocked}
              aria-describedby={directionLocked ? 'candidate-sort-order-help' : undefined}
            >
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>
            {directionLocked ? <p id="candidate-sort-order-help" className="mt-1 text-xs text-[#71767b]">Fixed by the applied-date order.</p> : null}
          </div>
          <details className="relative self-end">
            <summary className={`flex h-9 cursor-pointer list-none items-center justify-center rounded-lg border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${hasAdvancedFilters ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-[#dbe4ea] bg-white text-[#0f1419]'}`}>
              Filters{hasAdvancedFilters ? ' · active' : ''}
            </summary>
            <div className="absolute right-0 z-30 mt-2 max-h-[min(75vh,720px)] w-[min(92vw,640px)] overflow-y-auto rounded-2xl border border-[#dbe4ea] bg-white p-4 shadow-xl">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <CheckboxFilterGroup
                  legend="Stage"
                  value={value.stage}
                  options={CANDIDATE_STAGES.map((stage) => ({ value: stage, label: CANDIDATE_STAGE_LABEL[stage] }))}
                  disabled={disabled}
                  onChange={(stage) => onChange({ stage })}
                />
                <CheckboxFilterGroup
                  legend="Candidate sources"
                  description="How this person entered the workspace over time, not only this job."
                  value={value.source}
                  options={SOURCE_OPTIONS}
                  disabled={disabled}
                  onChange={(source) => onChange({ source })}
                />
                <CheckboxFilterGroup legend="JD score state" value={value.scoreState} options={JD_STATE_OPTIONS} disabled={disabled} onChange={(scoreState) => onChange({ scoreState })} />
                <label className="text-xs font-medium text-[#536471]">Minimum JD score
                  <input type="number" inputMode="numeric" min={0} max={100} value={value.scoreMin} onChange={(event) => onChange({ scoreMin: event.target.value })} className={`mt-1 ${SELECT_CLASS}`} />
                </label>
                <label className="text-xs font-medium text-[#536471]">Maximum JD score
                  <input type="number" inputMode="numeric" min={0} max={100} value={value.scoreMax} onChange={(event) => onChange({ scoreMax: event.target.value })} className={`mt-1 ${SELECT_CLASS}`} />
                </label>
                <CheckboxFilterGroup legend="Human review" value={value.humanReview} options={HUMAN_REVIEW_OPTIONS} disabled={disabled} onChange={(humanReview) => onChange({ humanReview })} />
                <CheckboxFilterGroup legend="AI interview" value={value.aiInterview} options={AI_INTERVIEW_OPTIONS} disabled={disabled} onChange={(aiInterview) => onChange({ aiInterview })} />
                <label className="text-xs font-medium text-[#536471]">Workspace history
                  <select value={value.history} onChange={(event) => onChange({ history: event.target.value })} className={`mt-1 ${SELECT_CLASS}`}>
                    <option value="">All candidates</option><option value="returning">Previously seen</option><option value="first_time">First seen in this job</option>
                  </select>
                </label>
                <label className="text-xs font-medium text-[#536471]">Applied from
                  <input type="date" value={value.appliedFrom} onChange={(event) => onChange({ appliedFrom: event.target.value })} className={`mt-1 ${SELECT_CLASS}`} />
                </label>
                <label className="text-xs font-medium text-[#536471]">Applied through
                  <input type="date" value={value.appliedTo} onChange={(event) => onChange({ appliedTo: event.target.value })} className={`mt-1 ${SELECT_CLASS}`} />
                </label>
              </div>
              <div className="mt-4 flex justify-end">
                <Button type="button" variant="secondary" onClick={onClear} disabled={!hasAdvancedFilters}>Clear filters</Button>
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>
  )
}
