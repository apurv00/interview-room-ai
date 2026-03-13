'use client'

import { useState, useEffect } from 'react'
import SelectionGroup from '@shared/ui/SelectionGroup'
import StateView from '@shared/ui/StateView'

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
  const [types, setTypes] = useState<InterviewDepth[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!selectedDomain) {
      setTypes([])
      return
    }

    // Use cached data if available
    if (depthCache[selectedDomain]) {
      const cached = depthCache[selectedDomain]
      setTypes(cached)
      if (!selectedDepth) {
        const hrType = cached.find((t) => t.slug === 'hr-screening')
        if (hrType) onSelect(hrType.slug)
        else if (cached.length > 0) onSelect(cached[0].slug)
      }
      return
    }

    setLoading(true)
    setError('')

    fetch(`/api/interview-types?domain=${encodeURIComponent(selectedDomain)}`)
      .then((r) => r.json())
      .then((data: InterviewDepth[]) => {
        depthCache[selectedDomain] = data
        setTypes(data)
        setLoading(false)

        // Auto-select hr-screening if available and nothing is selected yet
        if (!selectedDepth) {
          const hrType = data.find((t) => t.slug === 'hr-screening')
          if (hrType) {
            onSelect(hrType.slug)
          } else if (data.length > 0) {
            onSelect(data[0].slug)
          }
        }
      })
      .catch(() => {
        setError('Failed to load interview types')
        setLoading(false)
      })
  }, [selectedDomain]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!selectedDomain) {
    return (
      <StateView
        state="empty"
        title="Select a domain first"
        description="Choose an interview domain to see available interview types."
      />
    )
  }

  if (loading) {
    return <StateView state="loading" skeletonLayout="list" skeletonCount={4} />
  }

  if (error) {
    return (
      <StateView
        state="error"
        error="Couldn't load interview types. Check your connection and try again."
        onRetry={() => window.location.reload()}
      />
    )
  }

  if (types.length === 0) {
    return (
      <StateView
        state="empty"
        title="No interview types"
        description="No interview types available for this domain."
      />
    )
  }

  return (
    <SelectionGroup<InterviewDepth>
      items={types}
      value={selectedDepth}
      onChange={onSelect}
      getKey={(t) => t.slug}
      layout="list"
      renderItem={(t, selected) => (
        <div className="flex items-center gap-3 py-3 px-4">
          <span className="text-lg">{t.icon}</span>
          <div>
            <p className={`text-subheading ${selected ? 'text-[#818cf8]' : 'text-[#f0f2f5]'}`}>
              {t.label}
            </p>
            <p className="text-caption text-[#6b7280]">{t.description}</p>
          </div>
        </div>
      )}
    />
  )
}
