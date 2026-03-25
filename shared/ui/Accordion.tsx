'use client'

import { useState } from 'react'

interface AccordionItem {
  title: string
  content: React.ReactNode
}

interface AccordionProps {
  items: AccordionItem[]
  mode?: 'single' | 'multi'
}

export default function Accordion({ items, mode = 'single' }: AccordionProps) {
  const [openIndices, setOpenIndices] = useState<Set<number>>(new Set())

  const toggle = (index: number) => {
    setOpenIndices((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        if (mode === 'single') {
          next.clear()
        }
        next.add(index)
      }
      return next
    })
  }

  return (
    <div className="flex flex-col gap-element">
      {items.map((item, index) => {
        const isOpen = openIndices.has(index)
        return (
          <div key={index} className="surface-card-bordered overflow-hidden">
            <button
              onClick={() => toggle(index)}
              className="w-full flex items-center justify-between px-5 py-4 cursor-pointer text-left"
              aria-expanded={isOpen}
            >
              <span className="text-subheading text-[#0f1419]">{item.title}</span>
              <svg
                className={`w-4 h-4 text-[#8b98a5] shrink-0 transition-transform duration-[250ms] ${isOpen ? 'rotate-180' : ''}`}
                style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            <div
              className="transition-all duration-[250ms] overflow-hidden"
              style={{
                maxHeight: isOpen ? '500px' : '0px',
                transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            >
              <div className="px-5 pb-5 text-body text-[#536471]">
                {item.content}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
