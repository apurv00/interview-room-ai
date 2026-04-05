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
  { key: 'general', label: 'General' },
  { key: 'engineering', label: 'Engineering' },
  { key: 'product', label: 'Product & Design' },
  { key: 'business', label: 'Business' },
]

// Gradient backgrounds per domain slug
const DOMAIN_GRADIENTS: Record<string, string> = {
  general: 'from-gray-500/30 to-slate-500/30',
  frontend: 'from-blue-600/30 to-cyan-600/30',
  backend: 'from-indigo-600/30 to-blue-600/30',
  sdet: 'from-teal-600/30 to-cyan-600/30',
  'data-science': 'from-emerald-600/30 to-teal-600/30',
  pm: 'from-violet-600/30 to-indigo-600/30',
  design: 'from-pink-600/30 to-rose-600/30',
  business: 'from-purple-600/30 to-violet-600/30',
}
const DEFAULT_GRADIENT = 'from-indigo-600/30 to-violet-600/30'

const CARD_WIDTH = 180
const CARD_GAP = 12

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
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(true)
  const [activeDot, setActiveDot] = useState(0)
  const [totalDots, setTotalDots] = useState(1)

  // Background fetch to pick up any CMS-added domains
  useEffect(() => {
    if (domainCache) return
    fetch('/api/domains')
      .then((r) => r.json())
      .then((data: Domain[]) => {
        // Only replace static data if API returns at least as many domains
        if (data?.length >= STATIC_DOMAINS.length) {
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

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    setCanScrollLeft(scrollLeft > 5)
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 5)

    const pageWidth = clientWidth
    const pages = Math.max(1, Math.ceil((scrollWidth - clientWidth) / (pageWidth * 0.7)) + 1)
    setTotalDots(pages)
    const currentPage = Math.round(scrollLeft / (pageWidth * 0.7))
    setActiveDot(Math.min(currentPage, pages - 1))
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    updateScrollState()
    el.addEventListener('scroll', updateScrollState, { passive: true })
    const ro = new ResizeObserver(updateScrollState)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateScrollState)
      ro.disconnect()
    }
  }, [updateScrollState, filtered])

  // Reset scroll position when category changes
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0
    }
  }, [activeCategory])

  const scroll = useCallback((dir: 'left' | 'right') => {
    if (!scrollRef.current) return
    const amount = 300
    scrollRef.current.scrollBy({ left: dir === 'left' ? -amount : amount, behavior: 'smooth' })
  }, [])

  const scrollToDot = useCallback((dotIndex: number) => {
    const el = scrollRef.current
    if (!el) return
    const pageWidth = el.clientWidth * 0.7
    el.scrollTo({ left: dotIndex * pageWidth, behavior: 'smooth' })
  }, [])

  return (
    <div className="space-y-3">
      {/* Category filters */}
      <div className="flex items-center gap-element flex-wrap">
        {availableCategories.map((cat) => (
          <button
            key={cat.key}
            onClick={() => setActiveCategory(cat.key)}
            className={`px-4 py-2.5 rounded-[6px] text-sm font-medium transition-all duration-[120ms] ${
              activeCategory === cat.key
                ? 'bg-[rgba(99,102,241,0.08)] text-[#6366f1] border border-[rgba(99,102,241,0.15)]'
                : 'text-[#71767b] hover:text-[#536471] hover:bg-[#f7f9f9]'
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Carousel */}
      <div className="relative overflow-hidden" aria-roledescription="carousel">
        {/* Left arrow — always visible on desktop, disabled at scroll start */}
        <button
          onClick={() => scroll('left')}
          disabled={!canScrollLeft}
          className={`absolute left-0 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full bg-white/90 border border-[#e1e8ed] items-center justify-center text-[#536471] hover:text-[#0f1419] hover:bg-[#f7f9f9] transition hidden sm:flex ${
            canScrollLeft ? 'opacity-100' : 'opacity-30 cursor-default'
          }`}
          aria-label="Scroll left"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        {/* Right arrow — always visible on desktop, disabled at scroll end */}
        <button
          onClick={() => scroll('right')}
          disabled={!canScrollRight}
          className={`absolute right-0 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full bg-white/90 border border-[#e1e8ed] items-center justify-center text-[#536471] hover:text-[#0f1419] hover:bg-[#f7f9f9] transition hidden sm:flex ${
            canScrollRight ? 'opacity-100' : 'opacity-30 cursor-default'
          }`}
          aria-label="Scroll right"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>

        {/* Mobile fade indicators */}
        {canScrollLeft && (
          <div className="absolute left-0 top-0 bottom-0 w-16 bg-gradient-to-r from-[var(--color-page)] to-transparent z-[5] pointer-events-none sm:hidden" />
        )}
        {canScrollRight && (
          <div className="absolute right-0 top-0 bottom-0 w-16 bg-gradient-to-l from-[var(--color-page)] to-transparent z-[5] pointer-events-none sm:hidden" />
        )}

        <div
          ref={scrollRef}
          className="flex gap-3 overflow-x-auto scroll-smooth snap-x snap-mandatory pb-2 px-1 sm:px-10 scrollbar-thin"
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
                    : 'border-transparent hover:border-[#e1e8ed]'
                }`}
              >
                <span className="text-subheading text-[#0f1419] font-semibold">
                  {d.shortLabel || d.label}
                </span>
                <span className="text-caption text-[#536471]">{d.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Pagination dots */}
      {totalDots > 1 && (
        <div className="flex items-center justify-center gap-1.5">
          {Array.from({ length: totalDots }, (_, i) => (
            <button
              key={i}
              onClick={() => scrollToDot(i)}
              className={`rounded-full transition-all duration-200 ${
                i === activeDot
                  ? 'w-5 h-2 bg-[#6366f1]'
                  : 'w-2 h-2 bg-[#e1e8ed] hover:bg-[#cfd9de]'
              }`}
              aria-label={`Go to page ${i + 1}`}
            />
          ))}
        </div>
      )}

      {/* Selected domain detail */}
      {selectedDomainData && (
        <div className="surface-card p-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">{selectedDomainData.icon}</span>
            <span className="text-subheading text-[#0f1419]">{selectedDomainData.label}</span>
          </div>
          <p className="text-body text-[#536471]">{selectedDomainData.description}</p>
        </div>
      )}
    </div>
  )
}
