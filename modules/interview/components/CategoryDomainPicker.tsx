'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { ArrowLeft, Search } from 'lucide-react'
import {
  STATIC_DOMAINS,
  STATIC_CATEGORIES,
  type StaticDomain,
  type StaticCategory,
} from '../config/staticData'

/**
 * Phase 2 — two-screen Category → Domain picker (behind
 * NEXT_PUBLIC_FEATURE_TAXONOMY_V2). Screen 1 is a category grid; screen 2 is the
 * roles within the chosen category. A persistent search bypasses the grid, and
 * a "can't find your role" escape routes to General. Same prop contract as the
 * legacy DomainSelector, so it drops into InterviewSetupForm unchanged and the
 * downstream `config.role` slug is untouched.
 */

type Domain = StaticDomain // /api/domains returns this shape (incl. categorySlug)
type Category = StaticCategory

const GENERAL = 'general'
const catOf = (d: { categorySlug?: string }): string => d.categorySlug || GENERAL

// Module-level caches so the picker re-mounts instantly across wizard steps.
let domainCache: Domain[] | null = null
let categoryCache: Category[] | null = null

interface Props {
  selectedDomain: string | null
  onSelect: (slug: string) => void
}

export default function CategoryDomainPicker({ selectedDomain, onSelect }: Props) {
  const [domains, setDomains] = useState<Domain[]>(domainCache || (STATIC_DOMAINS as Domain[]))
  const [categories, setCategories] = useState<Category[]>(categoryCache || STATIC_CATEGORIES)
  const [search, setSearch] = useState('')

  // Skip-for-known: if a role is already chosen (pathway / retake / prior step),
  // open straight into its category's role list rather than the grid.
  const initialCategory = useMemo(() => {
    if (!selectedDomain) return null
    const d = (domainCache || (STATIC_DOMAINS as Domain[])).find((x) => x.slug === selectedDomain)
    return d ? catOf(d) : null
    // mount-only — deliberately not reacting to later selection changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [activeCategory, setActiveCategory] = useState<string | null>(initialCategory)
  const [view, setView] = useState<'category' | 'role'>(initialCategory ? 'role' : 'category')

  // Background fetch — pick up CMS-added roles/categories without a flash.
  useEffect(() => {
    if (!domainCache) {
      fetch('/api/domains')
        .then((r) => r.json())
        .then((data: Domain[]) => {
          if (Array.isArray(data) && data.length >= STATIC_DOMAINS.length) {
            domainCache = data
            setDomains(data)
          }
        })
        .catch(() => {})
    }
    if (!categoryCache) {
      fetch('/api/categories')
        .then((r) => r.json())
        .then((data: Category[]) => {
          if (Array.isArray(data) && data.length > 0) {
            categoryCache = data
            setCategories(data)
          }
        })
        .catch(() => {})
    }
  }, [])

  const countByCat = useMemo(() => {
    const m: Record<string, number> = {}
    for (const d of domains) m[catOf(d)] = (m[catOf(d)] || 0) + 1
    return m
  }, [domains])

  // Browseable cards: active categories that actually have roles; the 'general'
  // escape is reached via the "can't find" link, not shown as a card.
  const browseCategories = useMemo(
    () =>
      categories
        .filter((c) => c.slug !== GENERAL && (countByCat[c.slug] || 0) > 0)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [categories, countByCat],
  )

  const roleList = useMemo(
    () => domains.filter((d) => catOf(d) === activeCategory),
    [domains, activeCategory],
  )

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    return domains
      .filter(
        (d) =>
          d.label.toLowerCase().includes(q) ||
          d.slug.toLowerCase().includes(q) ||
          (d.shortLabel || '').toLowerCase().includes(q),
      )
      .slice(0, 12)
  }, [domains, search])

  const activeCategoryLabel = useMemo(
    () => categories.find((c) => c.slug === activeCategory)?.label ?? 'Roles',
    [categories, activeCategory],
  )
  const selectedData = useMemo(
    () => domains.find((d) => d.slug === selectedDomain),
    [domains, selectedDomain],
  )

  const openCategory = useCallback((slug: string) => {
    setActiveCategory(slug)
    setView('role')
    setSearch('')
  }, [])

  const pickSearchResult = useCallback(
    (d: Domain) => {
      onSelect(d.slug)
      setActiveCategory(catOf(d))
      setView('role')
      setSearch('')
    },
    [onSelect],
  )

  // "Can't find your role?" → General now. Phase 6 adds a free-text role-request
  // capture here to drive the backfill queue.
  const cantFind = useCallback(() => {
    onSelect(GENERAL)
    setActiveCategory(GENERAL)
    setView('role')
    setSearch('')
  }, [onSelect])

  // ── Role screen ──────────────────────────────────────────────────────────
  if (view === 'role') {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setView('category')}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> {activeCategoryLabel}
        </button>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3" role="listbox" aria-label={`${activeCategoryLabel} roles`}>
          {roleList.map((d) => {
            const isSelected = d.slug === selectedDomain
            return (
              <button
                key={d.slug}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => onSelect(d.slug)}
                className={`h-[96px] rounded-xl bg-white flex flex-col items-center justify-center gap-1 px-2 text-center transition-all duration-[120ms] border-2 ${
                  isSelected
                    ? 'border-[#2563eb] ring-2 ring-[rgba(37,99,235,0.25)]'
                    : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <span className="text-xl">{d.icon}</span>
                <span className="text-caption font-semibold text-slate-900 leading-tight">{d.label}</span>
              </button>
            )
          })}
        </div>

        <button
          type="button"
          onClick={cantFind}
          className="text-sm text-slate-400 hover:text-[#2563eb] transition-colors"
        >
          Can&apos;t find your role? Use General →
        </button>

        {selectedData && (
          <div className="surface-card p-4">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-lg">{selectedData.icon}</span>
              <span className="text-subheading text-slate-900">{selectedData.label}</span>
            </div>
            <p className="text-body text-slate-500">{selectedData.description}</p>
          </div>
        )}
      </div>
    )
  }

  // ── Category screen (with search) ────────────────────────────────────────
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search all roles (e.g. backend, mechanical)…"
          aria-label="Search roles"
          className="w-full bg-white border border-slate-200 rounded-lg pl-9 pr-3 py-2.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
        />
      </div>

      {search.trim() ? (
        <div className="space-y-1" role="listbox" aria-label="Search results">
          {searchResults.length === 0 ? (
            <button
              type="button"
              onClick={cantFind}
              className="w-full text-left px-3 py-3 rounded-lg text-sm text-slate-500 hover:bg-slate-50"
            >
              No roles match “{search.trim()}”. Use <span className="text-[#2563eb] font-medium">General</span> →
            </button>
          ) : (
            searchResults.map((d) => (
              <button
                key={d.slug}
                type="button"
                role="option"
                aria-selected={d.slug === selectedDomain}
                onClick={() => pickSearchResult(d)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-slate-50 transition-colors"
              >
                <span className="text-lg flex-shrink-0">{d.icon}</span>
                <span className="text-sm font-medium text-slate-900">{d.label}</span>
              </button>
            ))
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3" role="listbox" aria-label="Interview fields">
            {browseCategories.map((c) => (
              <button
                key={c.slug}
                type="button"
                onClick={() => openCategory(c.slug)}
                className="rounded-xl bg-white border border-slate-200 hover:border-[#2563eb] hover:shadow-sm p-4 text-left transition-all duration-[120ms]"
              >
                <div className="text-2xl mb-1.5">{c.icon}</div>
                <div className="text-subheading font-semibold text-slate-900">{c.label}</div>
                <div className="text-caption text-slate-500 mt-0.5 leading-snug">{c.description}</div>
                <div className="text-[11px] text-slate-400 mt-1.5">{countByCat[c.slug]} {countByCat[c.slug] === 1 ? 'role' : 'roles'}</div>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={cantFind}
            className="text-sm text-slate-400 hover:text-[#2563eb] transition-colors"
          >
            Can&apos;t find your field? Use General →
          </button>
        </>
      )}
    </div>
  )
}
