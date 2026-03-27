'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface SkillEntry {
  domain: string
  depth: string
  domainLabel: string
  depthLabel: string
  hasCustomContent: boolean
  isActive: boolean
  lastEditedAt: string | null
  version: number
}

export default function SkillsListPage() {
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    fetch('/api/cms/skills')
      .then(r => r.json())
      .then(d => setSkills(d.skills || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const filtered = filter
    ? skills.filter(s =>
        s.domainLabel.toLowerCase().includes(filter.toLowerCase()) ||
        s.depthLabel.toLowerCase().includes(filter.toLowerCase())
      )
    : skills

  // Group by domain
  const grouped = filtered.reduce<Record<string, SkillEntry[]>>((acc, s) => {
    if (!acc[s.domainLabel]) acc[s.domainLabel] = []
    acc[s.domainLabel].push(s)
    return acc
  }, {})

  if (loading) {
    return <div className="animate-pulse text-[#8b98a5]">Loading skills...</div>
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#0f1419]">Interview Skills</h1>
          <p className="text-sm text-[#536471] mt-1">
            44 skill playbooks — one per domain x depth combination. Edit markdown content directly.
          </p>
        </div>
        <input
          type="text"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter by domain or depth..."
          className="px-3 py-2 text-sm border border-[#e1e8ed] rounded-lg bg-[#f7f9f9] focus:outline-none focus:ring-2 focus:ring-[#6366f1]/30 w-64"
        />
      </div>

      <div className="space-y-6">
        {Object.entries(grouped).map(([domainLabel, entries]) => (
          <div key={domainLabel} className="border border-[#e1e8ed] rounded-xl overflow-hidden">
            <div className="bg-[#f7f9f9] px-4 py-2.5 border-b border-[#e1e8ed]">
              <h2 className="text-sm font-semibold text-[#0f1419]">{domainLabel}</h2>
            </div>
            <div className="divide-y divide-[#e1e8ed]">
              {entries.map(s => (
                <Link
                  key={`${s.domain}-${s.depth}`}
                  href={`/cms/skills/${s.domain}/${s.depth}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-[#f7f9f9] transition-colors group"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-[#0f1419] group-hover:text-[#6366f1] transition-colors">
                      {s.depthLabel}
                    </span>
                    {s.hasCustomContent && (
                      <span className="text-xs px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded-full">
                        customized
                      </span>
                    )}
                    {!s.isActive && (
                      <span className="text-xs px-2 py-0.5 bg-red-50 text-red-500 rounded-full">
                        inactive
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 text-xs text-[#8b98a5]">
                    {s.lastEditedAt && (
                      <span>Edited {new Date(s.lastEditedAt).toLocaleDateString()}</span>
                    )}
                    {s.version > 0 && <span>v{s.version}</span>}
                    <svg className="w-4 h-4 text-[#8b98a5] group-hover:text-[#6366f1] transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
