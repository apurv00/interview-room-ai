'use client'

import { useState, useEffect } from 'react'
import { STATIC_DEPTHS, type StaticDepth } from '../config/staticData'

interface InterviewDepth {
  slug: string
  label: string
  icon: string
  description: string
}

interface DepthSelectorProps {
  selectedDomain: string | null
  selectedDepth: string | null
  onSelect: (slug: string) => void
}

// Module-level cache keyed by domain slug
const depthCache: Record<string, InterviewDepth[]> = {}

function filterDepthsByDomain(depths: StaticDepth[], domain: string | null): InterviewDepth[] {
  if (!domain) return depths as InterviewDepth[]
  return depths.filter(d => !d.applicableDomains || d.applicableDomains.length === 0 || d.applicableDomains.includes(domain)) as InterviewDepth[]
}

export default function DepthSelector({ selectedDomain, selectedDepth, onSelect }: DepthSelectorProps) {
  // Use static data immediately, filtered by domain — no loading state needed
  const [types, setTypes] = useState<InterviewDepth[]>(() => filterDepthsByDomain(STATIC_DEPTHS, selectedDomain))

  // Re-filter static depths when domain changes, and auto-select behavioral
  useEffect(() => {
    const filtered = filterDepthsByDomain(STATIC_DEPTHS, selectedDomain)
    setTypes(filtered)

    // If current selection is no longer valid for this domain, reset to behavioral
    if (selectedDepth && !filtered.some(t => t.slug === selectedDepth)) {
      const behavioralType = filtered.find((t) => t.slug === 'behavioral')
      onSelect(behavioralType ? behavioralType.slug : filtered[0]?.slug || 'behavioral')
    } else if (!selectedDepth && filtered.length > 0) {
      const behavioralType = filtered.find((t) => t.slug === 'behavioral')
      onSelect(behavioralType ? behavioralType.slug : filtered[0].slug)
    }
  }, [selectedDomain]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select behavioral on first render if nothing selected
  useEffect(() => {
    if (!selectedDepth && types.length > 0) {
      const behavioralType = types.find((t) => t.slug === 'behavioral')
      if (behavioralType) onSelect(behavioralType.slug)
      else onSelect(types[0].slug)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Background fetch for CMS-managed depths (domain-filtered)
  useEffect(() => {
    if (!selectedDomain) return

    if (depthCache[selectedDomain]) {
      setTypes(depthCache[selectedDomain])
      return
    }

    fetch(`/api/interview-types?domain=${encodeURIComponent(selectedDomain)}`)
      .then((r) => r.json())
      .then((data: InterviewDepth[]) => {
        // Only replace static data if API returns at least as many depth options
        // (domain filtering may legitimately reduce the count, so compare per-domain)
        if (data?.length > 0) {
          // Verify API data has correct labels by checking at least one expected slug
          const hasSlugs = data.every((d: InterviewDepth) => d.slug && d.label)
          if (hasSlugs) {
            depthCache[selectedDomain] = data
            setTypes(data)
          }
        }
      })
      .catch(() => {
        // Static data already shown — silently ignore
      })
  }, [selectedDomain])

  if (!selectedDomain) {
    return (
      <div className="w-full px-4 py-3 bg-[#f7f9f9] border border-[#e1e8ed] rounded-[10px] text-sm text-[var(--foreground-tertiary)]">
        Select a domain first to choose an interview type.
      </div>
    )
  }

  const selectedType = types.find((t) => t.slug === selectedDepth)

  return (
    <div className="space-y-2">
      <select
        value={selectedDepth || ''}
        onChange={(e) => onSelect(e.target.value)}
        className="w-full px-4 py-3 bg-white border border-[#e1e8ed] rounded-[10px] text-sm text-[#0f1419] focus:outline-none focus:ring-2 focus:ring-[rgba(99,102,241,0.4)] focus:border-[rgba(99,102,241,0.3)] appearance-none cursor-pointer"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 12px center',
          paddingRight: '40px',
        }}
      >
        {types.map((t) => (
          <option key={t.slug} value={t.slug}>
            {t.icon} {t.label}
          </option>
        ))}
      </select>

      {/* Description of selected type */}
      {selectedType && (
        <p className="text-xs text-[#71767b] px-1">{selectedType.description}</p>
      )}
    </div>
  )
}
