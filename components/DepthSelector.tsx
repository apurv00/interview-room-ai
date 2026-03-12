'use client'

import { useState, useEffect } from 'react'

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

export default function DepthSelector({ selectedDomain, selectedDepth, onSelect }: DepthSelectorProps) {
  const [types, setTypes] = useState<InterviewDepth[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!selectedDomain) {
      setTypes([])
      return
    }

    setLoading(true)
    setError('')

    fetch(`/api/interview-types?domain=${encodeURIComponent(selectedDomain)}`)
      .then((r) => r.json())
      .then((data: InterviewDepth[]) => {
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
      <p className="text-sm text-slate-600 py-4">
        Select a domain first to see available interview types.
      </p>
    )
  }

  if (loading) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="min-w-[180px] h-24 bg-slate-800/50 rounded-xl animate-pulse shrink-0" />
        ))}
      </div>
    )
  }

  if (error) {
    return <p className="text-sm text-red-400">{error}</p>
  }

  if (types.length === 0) {
    return (
      <p className="text-sm text-slate-600 py-4">
        No interview types available for this domain.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto pb-2 -mx-1 px-1 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
      <div className="flex gap-3" style={{ minWidth: 'min-content' }}>
        {types.map((t) => (
          <button
            key={t.slug}
            onClick={() => onSelect(t.slug)}
            className={`
              flex flex-col items-start gap-1.5 py-4 px-4 rounded-xl border text-left transition-all duration-200 shrink-0
              min-w-[180px] max-w-[220px]
              ${selectedDepth === t.slug
                ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300 shadow-lg shadow-indigo-500/10 ring-1 ring-indigo-500/30'
                : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:text-slate-200 hover:bg-slate-800'
              }
            `}
          >
            <div className="flex items-center gap-2">
              <span className="text-xl">{t.icon}</span>
              <span className="text-sm font-semibold">{t.label}</span>
            </div>
            <span className="text-[11px] text-slate-500 leading-snug line-clamp-2">
              {t.description}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
