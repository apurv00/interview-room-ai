'use client'

import { useState, useEffect, useMemo } from 'react'

interface Domain {
  slug: string
  label: string
  shortLabel: string
  icon: string
  description: string
  color: string
  category: string
}

const CATEGORY_TABS = ['all', 'engineering', 'business', 'design', 'operations'] as const
const CATEGORY_LABELS: Record<string, string> = {
  all: 'All',
  engineering: 'Engineering',
  business: 'Business',
  design: 'Design',
  operations: 'Operations',
}

interface DomainSelectorProps {
  selectedDomain: string | null
  onSelect: (slug: string) => void
}

export default function DomainSelector({ selectedDomain, onSelect }: DomainSelectorProps) {
  const [domains, setDomains] = useState<Domain[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch('/api/domains')
      .then((r) => r.json())
      .then((data: Domain[]) => {
        setDomains(data)
        setLoading(false)
      })
      .catch(() => {
        setError('Failed to load domains')
        setLoading(false)
      })
  }, [])

  const filtered = useMemo(() => {
    let result = domains
    if (activeCategory !== 'all') {
      result = result.filter((d) => d.category === activeCategory)
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(
        (d) =>
          d.label.toLowerCase().includes(q) ||
          d.shortLabel.toLowerCase().includes(q) ||
          d.description.toLowerCase().includes(q)
      )
    }
    return result
  }, [domains, activeCategory, search])

  // Derive which categories actually exist in the data
  const availableCategories = useMemo(() => {
    const cats = new Set(domains.map((d) => d.category))
    return CATEGORY_TABS.filter((t) => t === 'all' || cats.has(t))
  }, [domains])

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-8 bg-slate-800/50 rounded-lg animate-pulse w-3/4" />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-28 bg-slate-800/50 rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return <p className="text-sm text-red-400">{error}</p>
  }

  return (
    <div className="space-y-3">
      {/* Category tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
        {availableCategories.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`
              px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all duration-200
              ${activeCategory === cat
                ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                : 'bg-slate-800/50 text-slate-500 border border-slate-700 hover:text-slate-300 hover:border-slate-600'
              }
            `}
          >
            {CATEGORY_LABELS[cat] || cat}
          </button>
        ))}
      </div>

      {/* Search input */}
      <div className="relative">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search domains..."
          className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-700 bg-slate-800/50 text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 transition-all"
        />
      </div>

      {/* Domain grid */}
      <div className="max-h-[360px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {filtered.map((d) => (
            <button
              key={d.slug}
              onClick={() => onSelect(d.slug)}
              className={`
                flex flex-col items-center gap-2 py-5 px-3 rounded-xl border text-sm font-medium transition-all duration-200 text-center
                ${selectedDomain === d.slug
                  ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300 shadow-lg shadow-indigo-500/10 ring-1 ring-indigo-500/30'
                  : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:text-slate-200 hover:bg-slate-800'
                }
              `}
            >
              <span className="text-2xl">{d.icon}</span>
              <span className="font-semibold">{d.label}</span>
              <span className="text-[11px] text-slate-500 leading-snug line-clamp-2">
                {d.description}
              </span>
            </button>
          ))}
        </div>
        {filtered.length === 0 && (
          <p className="text-sm text-slate-600 text-center py-8">
            No domains match your search.
          </p>
        )}
      </div>
    </div>
  )
}
