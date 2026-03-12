'use client'

import { useState, useEffect, useMemo } from 'react'
import SelectionGroup from './ui/SelectionGroup'
import StateView from './ui/StateView'

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

interface DomainSelectorProps {
  selectedDomain: string | null
  onSelect: (slug: string) => void
}

export default function DomainSelector({ selectedDomain, onSelect }: DomainSelectorProps) {
  const [domains, setDomains] = useState<Domain[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeCategory, setActiveCategory] = useState('all')
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
    return CATEGORY_TABS.filter((t) => t.key === 'all' || cats.has(t.key))
  }, [domains])

  // Find selected domain for detail display
  const selectedDomainData = useMemo(
    () => domains.find((d) => d.slug === selectedDomain),
    [domains, selectedDomain]
  )

  if (loading) {
    return <StateView state="loading" skeletonLayout="grid" skeletonCount={6} />
  }

  if (error) {
    return (
      <StateView
        state="error"
        error="Couldn't load interview domains. Check your connection and try again."
        onRetry={() => window.location.reload()}
      />
    )
  }

  return (
    <div className="space-y-3">
      <SelectionGroup<Domain>
        items={filtered}
        value={selectedDomain}
        onChange={onSelect}
        getKey={(d) => d.slug}
        layout="grid-3"
        searchable
        searchPlaceholder="Search domains..."
        onSearch={setSearch}
        filterable
        filterCategories={availableCategories}
        onFilter={setActiveCategory}
        activeFilter={activeCategory}
        maxVisible={9}
        emptyMessage="No domains match your search."
        renderItem={(d, selected) => (
          <div className="flex flex-col items-center gap-1.5 py-3 px-2">
            <span className="text-xl">{d.icon}</span>
            <span className={`text-caption font-semibold ${selected ? 'text-[#818cf8]' : ''}`}>
              {d.shortLabel || d.label}
            </span>
          </div>
        )}
      />

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
