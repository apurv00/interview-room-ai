'use client'

import { useState, useMemo, type ReactNode } from 'react'
import Input from './Input'

type Layout = 'list' | 'grid-2' | 'grid-3' | 'inline'

interface SelectionGroupProps<T> {
  items: T[]
  value: string | null
  onChange: (value: string) => void
  getKey: (item: T) => string
  renderItem: (item: T, selected: boolean) => ReactNode
  layout?: Layout
  searchable?: boolean
  searchPlaceholder?: string
  onSearch?: (query: string) => void
  filterable?: boolean
  filterCategories?: { key: string; label: string }[]
  onFilter?: (category: string) => void
  activeFilter?: string
  maxVisible?: number
  emptyMessage?: string
}

const layoutClasses: Record<Layout, string> = {
  list: 'flex flex-col gap-element',
  'grid-2': 'grid grid-cols-2 gap-element',
  'grid-3': 'grid grid-cols-2 sm:grid-cols-3 gap-element',
  inline: 'flex gap-element',
}

export default function SelectionGroup<T>({
  items,
  value,
  onChange,
  getKey,
  renderItem,
  layout = 'list',
  searchable = false,
  searchPlaceholder = 'Search...',
  onSearch,
  filterable = false,
  filterCategories = [],
  onFilter,
  activeFilter,
  maxVisible,
  emptyMessage = 'No items found.',
}: SelectionGroupProps<T>) {
  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(false)

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value
    setSearch(q)
    onSearch?.(q)
  }

  const visibleItems = useMemo(() => {
    if (maxVisible && !showAll && items.length > maxVisible) {
      return items.slice(0, maxVisible)
    }
    return items
  }, [items, maxVisible, showAll])

  return (
    <div className="space-y-3">
      {/* Filter tabs */}
      {filterable && filterCategories.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {filterCategories.map((cat) => (
            <button
              key={cat.key}
              onClick={() => onFilter?.(cat.key)}
              className={`
                px-4 py-2.5 rounded-[6px] text-micro font-medium whitespace-nowrap
                transition-all duration-[120ms]
                ${activeFilter === cat.key
                  ? 'bg-[rgba(99,102,241,0.08)] text-[#818cf8] border border-[rgba(99,102,241,0.15)]'
                  : 'bg-transparent text-[#4b5563] border border-transparent hover:text-[#b0b8c4]'
                }
              `}
            >
              {cat.label}
            </button>
          ))}
        </div>
      )}

      {/* Search input */}
      {searchable && (
        <Input
          value={search}
          onChange={handleSearch}
          placeholder={searchPlaceholder}
          leftIcon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          }
        />
      )}

      {/* Items */}
      {visibleItems.length === 0 ? (
        <p className="text-body text-[#6b7280] text-center py-8">{emptyMessage}</p>
      ) : (
        <div className={layoutClasses[layout]} role="listbox">
          {visibleItems.map((item) => {
            const key = getKey(item)
            const selected = value === key

            return (
              <button
                key={key}
                role="option"
                aria-selected={selected}
                onClick={() => onChange(key)}
                className={`
                  text-left transition-all duration-[250ms] cursor-pointer
                  ${layout === 'inline' ? 'flex-1 text-center' : ''}
                  ${layout === 'list' && selected ? 'border-l-[3px] border-l-[#6366f1]' : ''}
                  ${selected
                    ? 'bg-[rgba(99,102,241,0.08)] border border-[rgba(99,102,241,0.15)] text-[#818cf8]'
                    : 'bg-card border border-[rgba(255,255,255,0.06)] text-[#b0b8c4] hover:bg-surface hover:border-[rgba(255,255,255,0.10)]'
                  }
                  rounded-[10px]
                `}
              >
                {renderItem(item, selected)}
              </button>
            )
          })}
        </div>
      )}

      {/* Show all link */}
      {maxVisible && !showAll && items.length > maxVisible && (
        <button
          onClick={() => setShowAll(true)}
          className="text-caption text-[#818cf8] hover:text-[#6366f1] transition-colors"
        >
          Show all {items.length} items &rarr;
        </button>
      )}
      {maxVisible && showAll && items.length > maxVisible && (
        <button
          onClick={() => setShowAll(false)}
          className="text-caption text-[#818cf8] hover:text-[#6366f1] transition-colors"
        >
          Show less
        </button>
      )}
    </div>
  )
}
