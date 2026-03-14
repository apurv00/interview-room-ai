'use client'

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { STATIC_DOMAINS, type StaticDomain } from '../config/staticData'

interface Domain {
  slug: string
  label: string
  shortLabel: string
  icon: string
  description: string
  color: string
  category: string
}

const CATEGORY_TABS = [
  { key: 'all', label: 'All' },
  { key: 'engineering', label: 'Engineering' },
  { key: 'business', label: 'Business' },
  { key: 'design', label: 'Design' },
  { key: 'operations', label: 'Operations' },
]

// Gradient backgrounds per domain slug
const DOMAIN_GRADIENTS: Record<string, string> = {
  pm: 'from-violet-600/30 to-indigo-600/30',
  swe: 'from-blue-600/30 to-cyan-600/30',
  ds: 'from-emerald-600/30 to-teal-600/30',
  'data-science': 'from-emerald-600/30 to-teal-600/30',
  design: 'from-pink-600/30 to-rose-600/30',
  ux: 'from-pink-600/30 to-rose-600/30',
  marketing: 'from-amber-600/30 to-orange-600/30',
  mkt: 'from-amber-600/30 to-orange-600/30',
  finance: 'from-green-600/30 to-emerald-600/30',
  fin: 'from-green-600/30 to-emerald-600/30',
  sales: 'from-red-600/30 to-pink-600/30',
  consulting: 'from-purple-600/30 to-violet-600/30',
  con: 'from-purple-600/30 to-violet-600/30',
  mba: 'from-indigo-600/30 to-purple-600/30',
  hr: 'from-teal-600/30 to-cyan-600/30',
  legal: 'from-slate-600/30 to-gray-600/30',
  devops: 'from-sky-600/30 to-blue-600/30',
}
const DEFAULT_GRADIENT = 'from-indigo-600/30 to-violet-600/30'

// Module-level cache for CMS-fetched data
let domainCache: Domain[] | null = null

interface DomainSelectorProps {
  selectedDomain: string | null
  onSelect: (slug: string) => void
}

export default function DomainSelector({ selectedDomain, onSelect }: DomainSelectorProps) {
  // Start with static data immediately — no loading spinner
  const [domains, setDomains] = useState<Domain[]>(domainCache || STATIC_DOMAINS as Domain[])
  const [activeCategory, setActiveCategory] = useState('all')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Background fetch to pick up any CMS-added domains
  useEffect(() => {
    if (domainCache) return
    fetch('/api/domains')
      .then((r) => r.json())
      .then((data: Domain[]) => {
        if (data?.length > 0) {
          domainCache = data
          setDomains(data)
        }
      })
      .catch(() => {
        // Static data already shown — silently ignore
      })
  }, [])

  const filtered = useMemo(() => {
    if (activeCategory === 'all') return domains
    return domains.filter((d) => d.category === activeCategory)
  }, [domains, activeCategory])

  const availableCategories = useMemo(() => {
    const cats = new Set(domains.map((d) => d.category))
    return CATEGORY_TABS.filter((t) => t.key === 'all' || cats.has(t.key))
  }, [domains])

  const selectedDomainData = useMemo(
    () => domains.find((d) => d.slug === selectedDomain),
    [domains, selectedDomain]
  )

  const scroll = useCallback((dir: 'left' | 'right') => {
    if (!scrollRef.current) return
    const amount = 300
    scrollRef.current.scrollBy({ left: dir === 'left' ? -amount : amount, behavior: 'smooth' })
  }, [])

  return (
    <div className="space-y-3">
      {/* Category filters */}
      <div className="flex items-center gap-element flex-wrap">
        {availableCategories.map((cat) => (
          <button
            key={cat.key}
            onClick={() => setActiveCategory(cat.key)}
            className={`px-3 py-1.5 rounded-[6px] text-sm font-medium transition-all duration-[120ms] ${
              activeCategory === cat.key
                ? 'bg-[rgba(99,102,241,0.08)] text-[#818cf8] border border-[rgba(99,102,241,0.15)]'
                : 'text-[#6b7280] hover:text-[#b0b8c4] hover:bg-[#151d2e]'
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Carousel */}
      <div className="relative group">
        {/* Left arrow */}
        <button
          onClick={() => scroll('left')}
          className="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full bg-[#0c1220]/90 border border-[rgba(255,255,255,0.10)] flex items-center justify-center text-[#b0b8c4] hover:text-[#f0f2f5] hover:bg-[#151d2e] transition opacity-0 group-hover:opacity-100 -ml-3 hidden sm:flex"
          aria-label="Scroll left"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        {/* Right arrow */}
        <button
          onClick={() => scroll('right')}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full bg-[#0c1220]/90 border border-[rgba(255,255,255,0.10)] flex items-center justify-center text-[#b0b8c4] hover:text-[#f0f2f5] hover:bg-[#151d2e] transition opacity-0 group-hover:opacity-100 -mr-3 hidden sm:flex"
          aria-label="Scroll right"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>

        <div
          ref={scrollRef}
          className="flex gap-3 overflow-x-auto scroll-smooth snap-x snap-mandatory pb-2 scrollbar-thin"
          role="listbox"
          aria-label="Interview domains"
        >
          {filtered.map((d) => {
            const isSelected = d.slug === selectedDomain
            const gradient = DOMAIN_GRADIENTS[d.slug] || DEFAULT_GRADIENT
            return (
              <button
                key={d.slug}
                role="option"
                aria-selected={isSelected}
                onClick={() => onSelect(d.slug)}
                className={`flex-shrink-0 snap-start w-[180px] h-[120px] rounded-[10px] bg-gradient-to-br ${gradient} flex flex-col items-center justify-center gap-2 transition-all duration-[120ms] border-2 ${
                  isSelected
                    ? 'border-[#6366f1] ring-2 ring-[rgba(99,102,241,0.3)]'
                    : 'border-transparent hover:border-[rgba(255,255,255,0.15)]'
                }`}
              >
                <span className="text-subheading text-[#f0f2f5] font-semibold">
                  {d.shortLabel || d.label}
                </span>
                <span className="text-caption text-[#b0b8c4]">{d.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Selected domain detail */}
      {selectedDomainData && (
        <div className="surface-card p-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">{selectedDomainData.icon}</span>
            <span className="text-subheading text-[#f0f2f5]">{selectedDomainData.label}</span>
          </div>
          <p className="text-body text-[#b0b8c4]">{selectedDomainData.description}</p>
        </div>
      )}
    </div>
  )
}
