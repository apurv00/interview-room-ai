'use client'

import { useEffect, useState, type FormEvent } from 'react'
import {
  type FeedExperience,
  type FeedSort,
  type PublicFeedQuery,
} from '../config/feedDiscovery'

interface JobsDiscoveryControlsProps {
  value: PublicFeedQuery
  disabled?: boolean
  onApply: (query: PublicFeedQuery) => void
}

interface DraftValues {
  search: string
  experience: '' | FeedExperience
  sort: FeedSort
}

type RemovableFilter = 'domain' | 'search' | 'experience' | 'sort'

const EXPERIENCE_LABELS: Record<FeedExperience, string> = {
  entry: 'Entry level',
  mid: 'Mid level',
  senior: 'Senior or lead',
}

function initialDraft(value: PublicFeedQuery): DraftValues {
  return {
    search: value.search ?? '',
    experience: value.experience ?? '',
    sort: value.sort ?? 'best',
  }
}

function cleaned(value: string): string | undefined {
  return value.trim().replace(/\s+/g, ' ') || undefined
}

function chipEntries(value: PublicFeedQuery): Array<{ key: RemovableFilter; label: string }> {
  const entries: Array<{ key: RemovableFilter; label: string }> = []
  if (value.search) entries.push({ key: 'search', label: `Search: ${value.search}` })
  if (value.experience) entries.push({ key: 'experience', label: `Experience preference: ${EXPERIENCE_LABELS[value.experience]}` })
  if (value.domain) entries.push({ key: 'domain', label: `Domain: ${value.domain}` })
  if (value.sort === 'newest') entries.push({ key: 'sort', label: 'Sort: Newest' })
  return entries
}

export function JobsDiscoveryControls({ value, disabled = false, onApply }: JobsDiscoveryControlsProps) {
  const [draft, setDraft] = useState<DraftValues>(() => initialDraft(value))
  const [showFilters, setShowFilters] = useState(false)
  const chips = chipEntries(value)
  const secondaryFilterCount = Number(!!value.experience) + Number(value.sort === 'newest')

  // URL state is authoritative. Browser Back/Forward and chip removal must
  // also update the editable controls instead of resurrecting stale drafts.
  useEffect(() => {
    setDraft(initialDraft(value))
  }, [value])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onApply({
      domain: value.domain,
      search: cleaned(draft.search),
      experience: draft.experience || undefined,
      sort: draft.sort === 'best' ? undefined : draft.sort,
    })
  }

  function removeFilter(key: RemovableFilter) {
    onApply({ ...value, [key]: undefined, cursor: undefined, direction: undefined })
  }

  return (
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" aria-label="Find jobs">
      <form role="search" onSubmit={submit}>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <label className="block text-sm font-medium text-slate-700" htmlFor="jobs-search">
            Search jobs
            <input
              id="jobs-search"
              type="search"
              value={draft.search}
              maxLength={80}
              onChange={(event) => setDraft((current) => ({ ...current, search: event.target.value }))}
              placeholder="Role or title"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
          </label>
          <button
            type="submit"
            disabled={disabled}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-wait disabled:opacity-60 md:w-auto"
          >
            Search
          </button>
        </div>

        <button
          type="button"
          className="mt-3 text-sm font-medium text-blue-700 md:hidden"
          aria-expanded={showFilters}
          aria-controls="jobs-secondary-filters"
          onClick={() => setShowFilters((visible) => !visible)}
        >
          {showFilters ? 'Hide filters' : `Filters${secondaryFilterCount ? ` (${secondaryFilterCount})` : ''}`}
        </button>

        <div
          id="jobs-secondary-filters"
          className={`${showFilters ? 'grid' : 'hidden'} mt-4 gap-3 sm:grid-cols-2 md:grid md:max-w-2xl md:grid-cols-2`}
        >
          <label className="text-xs font-medium text-slate-600" htmlFor="jobs-experience">
            Experience preference
            <select
              id="jobs-experience"
              value={draft.experience}
              onChange={(event) => setDraft((current) => ({ ...current, experience: event.target.value as DraftValues['experience'] }))}
              className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"
            >
              <option value="">Any</option>
              <option value="entry">Entry level</option>
              <option value="mid">Mid level</option>
              <option value="senior">Senior or lead</option>
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600" htmlFor="jobs-sort">
            Sort
            <select
              id="jobs-sort"
              value={draft.sort}
              onChange={(event) => setDraft((current) => ({ ...current, sort: event.target.value as FeedSort }))}
              className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"
            >
              <option value="best">Best match</option>
              <option value="newest">Newest</option>
            </select>
          </label>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Experience improves Best match ordering without hiding roles whose level is unclear.
        </p>
      </form>

      {chips.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Active job filters">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => removeFilter(chip.key)}
              className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs text-blue-800 hover:bg-blue-100"
              aria-label={`Remove ${chip.label} filter`}
            >
              {chip.label} <span aria-hidden="true">×</span>
            </button>
          ))}
          <button
            type="button"
            className="text-xs font-medium text-blue-700 hover:underline"
            onClick={() => onApply({})}
          >
            Clear all
          </button>
        </div>
      )}
    </section>
  )
}
