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

export default function DepthSelector({ selectedDomain, selectedDepth, onSelect }: DepthSelectorProps) {
  // Use static data immediately — no loading state needed
  const [types, setTypes] = useState<InterviewDepth[]>(STATIC_DEPTHS as InterviewDepth[])

  // Auto-select screening on first render if nothing selected
  useEffect(() => {
    if (!selectedDepth && types.length > 0) {
      const screeningType = types.find((t) => t.slug === 'screening')
      if (screeningType) onSelect(screeningType.slug)
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
        if (data?.length > 0) {
          depthCache[selectedDomain] = data
          setTypes(data)
        }
      })
      .catch(() => {
        // Static data already shown — silently ignore
      })
  }, [selectedDomain])

  if (!selectedDomain) {
    return (
      <div className="text-sm text-[#6b7280] py-3">
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
        className="w-full px-4 py-3 bg-[#0c1220] border border-[rgba(255,255,255,0.10)] rounded-[10px] text-sm text-[#f0f2f5] focus:outline-none focus:ring-2 focus:ring-[rgba(99,102,241,0.4)] focus:border-[rgba(99,102,241,0.3)] appearance-none cursor-pointer"
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
        <p className="text-xs text-[#6b7280] px-1">{selectedType.description}</p>
      )}
    </div>
  )
}
