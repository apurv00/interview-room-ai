'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'

const DOMAIN_LABELS: Record<string, string> = {
  general: 'General / Any Role', frontend: 'Frontend Engineer', backend: 'Backend / Infra Engineer',
  sdet: 'SDET / QA', 'data-science': 'Data Science / ML', pm: 'Product Manager',
  design: 'Design / UX', business: 'Business & Strategy',
}
const DEPTH_LABELS: Record<string, string> = {
  behavioral: 'Behavioral', technical: 'Technical', 'case-study': 'Case Study',
}

const REQUIRED_SECTIONS = [
  'Interviewer Persona', 'Question Strategy', 'Anti-Patterns',
  'Experience Calibration', 'Scoring Emphasis', 'Red Flags', 'Sample Questions',
]

function checkMissingSections(content: string): string[] {
  return REQUIRED_SECTIONS.filter(s => {
    const pattern = new RegExp(`^## ${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm')
    return !pattern.test(content)
  })
}

export default function SkillEditorPage() {
  const router = useRouter()
  const params = useParams<{ domain: string; depth: string }>()
  const domain = params.domain
  const depth = params.depth

  const [content, setContent] = useState('')
  const [defaultContent, setDefaultContent] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [hasCustomContent, setHasCustomContent] = useState(false)
  const [version, setVersion] = useState(0)
  const [lastEditedAt, setLastEditedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null)
  const [showPreview, setShowPreview] = useState(true)

  const missingSections = checkMissingSections(content)

  useEffect(() => {
    fetch(`/api/cms/skills/${domain}/${depth}`)
      .then(r => r.json())
      .then(d => {
        setContent(d.content || '')
        setDefaultContent(d.defaultContent || '')
        setIsActive(d.isActive ?? true)
        setHasCustomContent(d.hasCustomContent)
        setVersion(d.version || 0)
        setLastEditedAt(d.lastEditedAt)
      })
      .catch(() => setMessage({ type: 'error', text: 'Failed to load skill' }))
      .finally(() => setLoading(false))
  }, [domain, depth])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/cms/skills/${domain}/${depth}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, isActive }),
      })
      const data = await res.json()
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error || 'Save failed' })
        return
      }
      setVersion(data.skill.version)
      setLastEditedAt(data.skill.lastEditedAt)
      setHasCustomContent(true)
      if (data.warnings) {
        setMessage({ type: 'warning', text: data.warnings.message })
      } else {
        setMessage({ type: 'success', text: 'Skill saved successfully' })
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to save' })
    } finally {
      setSaving(false)
    }
  }, [domain, depth, content, isActive])

  const handleReset = useCallback(async () => {
    if (!confirm('Reset to default? This will discard all custom edits.')) return
    setResetting(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/cms/skills/${domain}/${depth}/reset`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error || 'Reset failed' })
        return
      }
      setContent(data.content)
      setHasCustomContent(false)
      setVersion(0)
      setLastEditedAt(null)
      setMessage({ type: 'success', text: 'Reset to default' })
    } catch {
      setMessage({ type: 'error', text: 'Failed to reset' })
    } finally {
      setResetting(false)
    }
  }, [domain, depth])

  // Ctrl+S save shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleSave])

  if (loading) {
    return <div className="animate-pulse text-[#8b98a5]">Loading skill editor...</div>
  }

  const domainLabel = DOMAIN_LABELS[domain] || domain
  const depthLabel = DEPTH_LABELS[depth] || depth

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-[#e1e8ed] flex-shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <button onClick={() => router.push('/cms/skills')} className="text-[#8b98a5] hover:text-[#0f1419] transition-colors">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
            </button>
            <h1 className="text-xl font-bold text-[#0f1419]">
              {domainLabel} — {depthLabel}
            </h1>
            {hasCustomContent && (
              <span className="text-xs px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded-full">customized</span>
            )}
          </div>
          <div className="flex items-center gap-4 mt-1 text-xs text-[#8b98a5]">
            {version > 0 && <span>Version {version}</span>}
            {lastEditedAt && <span>Last edited {new Date(lastEditedAt).toLocaleString()}</span>}
            <span>{content.length} chars</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)}
              className="rounded border-[#e1e8ed] text-[#6366f1] focus:ring-[#6366f1]/30" />
            Active
          </label>
          <button onClick={() => setShowPreview(!showPreview)}
            className="px-3 py-1.5 text-xs border border-[#e1e8ed] rounded-lg hover:bg-[#f7f9f9] transition-colors">
            {showPreview ? 'Hide' : 'Show'} Preview
          </button>
          {hasCustomContent && (
            <button onClick={handleReset} disabled={resetting}
              className="px-3 py-1.5 text-xs text-red-500 border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50">
              {resetting ? 'Resetting...' : 'Reset to Default'}
            </button>
          )}
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-1.5 text-sm bg-[#6366f1] text-white rounded-lg hover:bg-indigo-500 transition-colors disabled:opacity-50 font-medium">
            {saving ? 'Saving...' : 'Save'} <span className="text-xs opacity-70 ml-1">Ctrl+S</span>
          </button>
        </div>
      </div>

      {/* Messages */}
      {message && (
        <div className={`mt-3 px-4 py-2 rounded-lg text-sm flex-shrink-0 ${
          message.type === 'success' ? 'bg-emerald-50 text-emerald-700' :
          message.type === 'warning' ? 'bg-amber-50 text-amber-700' :
          'bg-red-50 text-red-700'
        }`}>
          {message.text}
        </div>
      )}

      {/* Missing sections warning */}
      {missingSections.length > 0 && (
        <div className="mt-2 px-4 py-2 bg-amber-50 border border-amber-100 rounded-lg text-xs text-amber-700 flex-shrink-0">
          Missing sections: {missingSections.join(', ')}
        </div>
      )}

      {/* Editor + Preview */}
      <div className={`flex-1 mt-4 flex gap-4 min-h-0 ${showPreview ? 'grid grid-cols-2' : ''}`}>
        {/* Editor */}
        <div className="flex flex-col min-h-0">
          <div className="text-xs text-[#8b98a5] mb-1 font-medium">Markdown Editor</div>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            className="flex-1 w-full p-4 border border-[#e1e8ed] rounded-xl bg-[#fafbfc] font-mono text-sm leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-[#6366f1]/30 focus:border-[#6366f1]"
            spellCheck={false}
          />
        </div>

        {/* Preview */}
        {showPreview && (
          <div className="flex flex-col min-h-0">
            <div className="text-xs text-[#8b98a5] mb-1 font-medium">Preview</div>
            <div className="flex-1 overflow-auto p-4 border border-[#e1e8ed] rounded-xl bg-white prose prose-sm max-w-none">
              {content.split('\n').map((line, i) => {
                if (line.startsWith('# ')) return <h1 key={i} className="text-xl font-bold mt-0 mb-3 text-[#0f1419]">{line.slice(2)}</h1>
                if (line.startsWith('## ')) return <h2 key={i} className="text-base font-semibold mt-4 mb-2 text-[#0f1419] border-b border-[#e1e8ed] pb-1">{line.slice(3)}</h2>
                if (line.startsWith('### ')) return <h3 key={i} className="text-sm font-semibold mt-3 mb-1 text-[#536471]">{line.slice(4)}</h3>
                if (line.startsWith('- ')) return <li key={i} className="text-sm text-[#536471] ml-4">{line.slice(2)}</li>
                if (line.match(/^\d+\.\s/)) return <li key={i} className="text-sm text-[#536471] ml-4 list-decimal">{line.replace(/^\d+\.\s/, '')}</li>
                if (line.trim() === '') return <div key={i} className="h-2" />
                return <p key={i} className="text-sm text-[#536471] leading-relaxed">{line}</p>
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
