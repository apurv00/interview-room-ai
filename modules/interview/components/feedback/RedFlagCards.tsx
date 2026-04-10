'use client'

interface RedFlagCardsProps {
  redFlags: string[]
}

interface FlagGroup {
  category: string
  icon: React.ReactNode
  severity: 'high' | 'medium' | 'low'
  flags: string[]
}

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  content: ['vague', 'generic', 'no example', 'irrelevant', 'off-topic', 'shallow', 'unclear', 'missing'],
  delivery: ['filler', 'rambling', 'pace', 'hesitant', 'monotone', 'rushed', 'slow', 'ums', 'long-winded'],
  consistency: ['inconsistent', 'contradict', 'mismatch', 'conflicting', 'discrepancy'],
}

function categorizeFlag(flag: string): string {
  const lower = flag.toLowerCase()
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return category
    }
  }
  return 'content' // default category
}

const SEVERITY_STYLES = {
  high: 'bg-red-50 border-red-200 text-red-700',
  medium: 'bg-yellow-50 border-yellow-200 text-yellow-700',
  low: 'bg-blue-50 border-blue-200 text-blue-700',
} as const

const SEVERITY_BADGE_STYLES = {
  high: 'bg-red-100 text-red-600 border-red-200',
  medium: 'bg-yellow-100 text-yellow-600 border-yellow-200',
  low: 'bg-blue-100 text-blue-600 border-blue-200',
} as const

function ContentIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  )
}

function DeliveryIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
    </svg>
  )
}

function ConsistencyIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
  )
}

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  content: <ContentIcon />,
  delivery: <DeliveryIcon />,
  consistency: <ConsistencyIcon />,
}

const CATEGORY_LABELS: Record<string, string> = {
  content: 'Content Issues',
  delivery: 'Delivery Issues',
  consistency: 'Consistency Issues',
}

function getSeverity(flagCount: number): 'high' | 'medium' | 'low' {
  if (flagCount >= 3) return 'high'
  if (flagCount >= 2) return 'medium'
  return 'low'
}

export default function RedFlagCards({ redFlags }: RedFlagCardsProps) {
  if (!redFlags || redFlags.length === 0) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-2xl p-5 flex items-center gap-3">
        <svg className="w-6 h-6 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div>
          <p className="text-sm font-semibold text-green-700">No significant red flags detected</p>
          <p className="text-xs text-green-600 mt-0.5">Your responses were consistent and well-structured.</p>
        </div>
      </div>
    )
  }

  // Group flags by category
  const grouped: Record<string, string[]> = {}
  for (const flag of redFlags) {
    const cat = categorizeFlag(flag)
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(flag)
  }

  const groups: FlagGroup[] = Object.entries(grouped).map(([category, flags]) => ({
    category,
    icon: CATEGORY_ICONS[category] || CATEGORY_ICONS.content,
    severity: getSeverity(flags.length),
    flags,
  }))

  // Sort by severity: high first
  const severityOrder = { high: 0, medium: 1, low: 2 }
  groups.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])

  return (
    <div className="bg-white rounded-2xl border border-[#e1e8ed] p-4">
      <h4 className="text-sm font-semibold text-[#0f1419] mb-3">Red Flags</h4>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {groups.map((group) => (
          <div
            key={group.category}
            className={`rounded-xl border p-4 ${SEVERITY_STYLES[group.severity]}`}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {group.icon}
                <span className="text-sm font-semibold">
                  {CATEGORY_LABELS[group.category] || group.category}
                </span>
              </div>
              <span
                className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full border ${SEVERITY_BADGE_STYLES[group.severity]}`}
              >
                {group.severity}
              </span>
            </div>
            <ul className="space-y-1.5">
              {group.flags.map((flag, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs">
                  <span className="shrink-0 mt-0.5">&#183;</span>
                  <span>{flag}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}
