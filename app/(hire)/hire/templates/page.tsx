'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

interface Template {
  id: string
  name: string
  description: string
  role: string
  experienceLevel: string
  questionCount: number
  duration: number
  isActive: boolean
  createdAt: string
}

export default function TemplatesPage() {
  const router = useRouter()
  const { status: authStatus } = useSession()
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)

  // Create form state
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newRole, setNewRole] = useState('backend')
  const [newExp, setNewExp] = useState('all')
  const [newDuration, setNewDuration] = useState(20)
  const [newQuestions, setNewQuestions] = useState<Array<{ text: string; category: string }>>([
    { text: '', category: 'behavioral' },
  ])

  useEffect(() => {
    if (authStatus === 'unauthenticated') { router.push('/signin'); return }
    if (authStatus !== 'authenticated') return

    fetch('/api/hire/templates')
      .then(r => r.json())
      .then(data => setTemplates(data.templates || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [authStatus, router])

  function addQuestion() {
    setNewQuestions(prev => [...prev, { text: '', category: 'behavioral' }])
  }

  function removeQuestion(idx: number) {
    setNewQuestions(prev => prev.filter((_, i) => i !== idx))
  }

  async function handleCreate() {
    if (!newName.trim()) return
    setCreating(true)
    try {
      await fetch('/api/hire/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName,
          description: newDesc,
          role: newRole,
          experienceLevel: newExp,
          questions: newQuestions.filter(q => q.text.trim()),
          settings: { duration: newDuration, questionCount: newQuestions.filter(q => q.text.trim()).length },
        }),
      })
      // Reload
      const res = await fetch('/api/hire/templates')
      const data = await res.json()
      setTemplates(data.templates || [])
      setShowCreate(false)
      setNewName('')
      setNewDesc('')
      setNewQuestions([{ text: '', category: 'behavioral' }])
    } catch { /* ignore */ }
    setCreating(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 rounded-full border-2 border-[#6366f1] border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[#0f1419]">Interview Templates</h1>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-xl font-medium transition-colors"
        >
          {showCreate ? 'Cancel' : 'Create Template'}
        </button>
      </div>

      {/* Create template form */}
      {showCreate && (
        <div className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-4 animate-fade-in">
          <h2 className="text-sm font-semibold text-[#536471]">New Template</h2>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Template Name *</label>
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Senior SWE Behavioral"
                className="w-full px-3 py-2.5 bg-[#f7f9f9] border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Description</label>
              <input
                type="text"
                value={newDesc}
                onChange={e => setNewDesc(e.target.value)}
                placeholder="Brief description..."
                className="w-full px-3 py-2.5 bg-[#f7f9f9] border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Role</label>
              <select
                value={newRole}
                onChange={e => setNewRole(e.target.value)}
                className="w-full px-3 py-2.5 bg-[#f7f9f9] border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {['frontend', 'backend', 'sdet', 'devops', 'data-science', 'pm', 'design', 'business', 'marketing', 'finance', 'sales'].map(r => (
                  <option key={r} value={r}>{r.toUpperCase()}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Experience</label>
              <select
                value={newExp}
                onChange={e => setNewExp(e.target.value)}
                className="w-full px-3 py-2.5 bg-[#f7f9f9] border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="all">All Levels</option>
                <option value="0-2">0-2 years</option>
                <option value="3-6">3-6 years</option>
                <option value="7+">7+ years</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Duration</label>
              <select
                value={newDuration}
                onChange={e => setNewDuration(Number(e.target.value))}
                className="w-full px-3 py-2.5 bg-[#f7f9f9] border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value={10}>10 min</option>
                <option value={20}>20 min</option>
                <option value={30}>30 min</option>
              </select>
            </div>
          </div>

          {/* Questions */}
          <div className="space-y-2">
            <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Custom Questions</label>
            {newQuestions.map((q, i) => (
              <div key={i} className="flex gap-2">
                <input
                  type="text"
                  value={q.text}
                  onChange={e => setNewQuestions(prev => prev.map((p, j) => j === i ? { ...p, text: e.target.value } : p))}
                  placeholder={`Question ${i + 1}...`}
                  className="flex-1 px-3 py-2 bg-[#f7f9f9] border border-[#e1e8ed] rounded-lg text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <select
                  value={q.category}
                  onChange={e => setNewQuestions(prev => prev.map((p, j) => j === i ? { ...p, category: e.target.value } : p))}
                  className="px-2 py-2 bg-[#f7f9f9] border border-[#e1e8ed] rounded-lg text-xs text-[#536471] focus:outline-none"
                >
                  <option value="behavioral">Behavioral</option>
                  <option value="situational">Situational</option>
                  <option value="technical">Technical</option>
                  <option value="motivation">Motivation</option>
                  <option value="custom">Custom</option>
                </select>
                {newQuestions.length > 1 && (
                  <button onClick={() => removeQuestion(i)} className="text-[#8b98a5] hover:text-red-400 transition-colors">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
            <button onClick={addQuestion} className="text-xs text-[#6366f1] hover:text-[#6366f1] transition-colors">
              + Add Question
            </button>
          </div>

          <button
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-medium text-sm transition-colors disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create Template'}
          </button>
        </div>
      )}

      {/* Template list */}
      {templates.length === 0 && !showCreate ? (
        <div className="text-center py-12 bg-white border border-[#e1e8ed] rounded-2xl">
          <p className="text-[#536471] mb-2">No templates yet.</p>
          <p className="text-xs text-[#8b98a5]">Create a template to standardize interviews across your team.</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {templates.map(t => (
            <div key={t.id} className="bg-white border border-[#e1e8ed] rounded-2xl p-5 hover:border-[#e1e8ed] transition-all">
              <div className="flex items-start justify-between mb-2">
                <h3 className="text-sm font-semibold text-[#0f1419]">{t.name}</h3>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${t.isActive ? 'bg-emerald-500/20 text-[#059669]' : 'bg-[#f7f9f9] text-[#536471]'}`}>
                  {t.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
              {t.description && <p className="text-xs text-[#536471] mb-3">{t.description}</p>}
              <div className="flex items-center gap-3 text-[10px] text-[#8b98a5]">
                <span className="capitalize">{t.role}</span>
                <span>{t.experienceLevel === 'all' ? 'All levels' : t.experienceLevel}</span>
                <span>{t.questionCount} questions</span>
                <span>{t.duration} min</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
