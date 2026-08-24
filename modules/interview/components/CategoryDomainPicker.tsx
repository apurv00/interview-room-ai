'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { ArrowLeft } from 'lucide-react'
import {
  STATIC_DOMAINS,
  STATIC_CATEGORIES,
  type StaticDomain,
  type StaticCategory,
} from '../config/staticData'

/**
 * Two-screen Category → Domain picker — the shared domain selector for
 * interview setup surfaces. Screen 1 is a category grid; screen 2 is
 * the roles within the chosen category. A "can't find your role" escape routes to
 * General. Props are just `selectedDomain` + `onSelect`, and the downstream
 * `config.role` slug is untouched.
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

  // Skip-for-known: if a role is already chosen (pathway / retake / prior step),
  // open straight into its category's role list rather than the grid.
  const initialCategory = useMemo(() => {
    if (!selectedDomain) return null
    const d = (domainCache || (STATIC_DOMAINS as Domain[])).find((x) => x.slug === selectedDomain)
    return d ? catOf(d) : null
    // first-render lookup only (no flash when the role is already known); later
    // async hydration is handled by the effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [activeCategory, setActiveCategory] = useState<string | null>(initialCategory)
  const [view, setView] = useState<'category' | 'role'>(initialCategory ? 'role' : 'category')

  // Skip-for-known across ASYNC hydration: retake / last-config / pathway /
  // onboarding set `selectedDomain` from effects, *after* this picker has already
  // rendered with `null`. React to that null→known transition once — open the
  // role's category list — and only once, so the user's later manual navigation
  // is never overridden.
  const hydratedRef = useRef<boolean>(initialCategory != null)
  const prevSelectedRef = useRef<string | null>(selectedDomain)
  useEffect(() => {
    const prev = prevSelectedRef.current
    prevSelectedRef.current = selectedDomain
    if (!selectedDomain) {
      // A known→null transition is a "Start over" / cleared role: return to the
      // category grid and re-arm hydration. A *persistent* null (the user is
      // browsing categories without having picked a role yet) leaves the view
      // untouched, so we never yank them off a category they opened.
      if (prev) {
        hydratedRef.current = false
        setActiveCategory(null)
        setView('category')
      }
      return
    }
    if (hydratedRef.current) return
    const d = domains.find((x) => x.slug === selectedDomain)
    if (!d) return
    hydratedRef.current = true
    setActiveCategory(catOf(d))
    setView('role')
  }, [selectedDomain, domains])

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

  const activeCategoryLabel = useMemo(
    () => categories.find((c) => c.slug === activeCategory)?.label ?? 'Roles',
    [categories, activeCategory],
  )
  const selectedData = useMemo(
    () => domains.find((d) => d.slug === selectedDomain),
    [domains, selectedDomain],
  )

  // Any manual navigation "settles" the view, so a later async role-hydration
  // won't yank the user away from where they chose to be.
  const openCategory = useCallback((slug: string) => {
    hydratedRef.current = true
    setActiveCategory(slug)
    setView('role')
  }, [])

  // "Can't find your role?" → General now. Phase 6 adds a free-text role-request
  // capture here to drive the backfill queue.
  const cantFind = useCallback(() => {
    hydratedRef.current = true
    onSelect(GENERAL)
    setActiveCategory(GENERAL)
    setView('role')
  }, [onSelect])

  const backToGrid = useCallback(() => {
    hydratedRef.current = true
    setView('category')
  }, [])

  // ── Role screen ──────────────────────────────────────────────────────────
  if (view === 'role') {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={backToGrid}
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

  // ── Category screen ──────────────────────────────────────────────────────
  return (
    <div className="space-y-3">
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
    </div>
  )
}
