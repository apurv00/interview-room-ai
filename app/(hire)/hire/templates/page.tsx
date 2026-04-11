'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import Input from '@shared/ui/Input'
import Button from '@shared/ui/Button'
import Badge from '@shared/ui/Badge'
import StateView from '@shared/ui/StateView'

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

const ROLES = ['frontend', 'backend', 'sdet', 'devops', 'data-science', 'pm', 'design', 'business', 'marketing', 'finance', 'sales']
const CATEGORIES = ['behavioral', 'situational', 'technical', 'motivation', 'custom']

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
      <div className="max-w-4xl mx-auto space-y-6">
        <h1 className="text-heading text-[var(--foreground)]">Interview Templates</h1>
        <StateView state="loading" skeletonLayout="grid" skeletonCount={4} />
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-heading text-[var(--foreground)]">Interview Templates</h1>
        <Button
          variant={showCreate ? 'secondary' : 'primary'}
          size="md"
          onClick={() => setShowCreate(!showCreate)}
        >
          {showCreate ? 'Cancel' : 'Create Template'}
        </Button>
      </div>

      {/* Create template form */}
      {showCreate && (
        <div className="surface-card-bordered p-6 space-y-4">
          <h2 className="text-subheading text-[var(--foreground-secondary)]">New Template</h2>

          <div className="grid md:grid-cols-2 gap-4">
            <Input
              label="Template Name"
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="e.g. Senior SWE Behavioral"
            />
            <Input
              label="Description"
              type="text"
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
              placeholder="Brief description..."
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="text-caption text-[var(--foreground-secondary)]">Role</label>
              <select
                value={newRole}
                onChange={e => setNewRole(e.target.value)}
                className="w-full h-9 px-3 bg-[var(--color-card)] border border-[var(--color-border)] rounded-[6px] text-body text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ds-primary)]"
              >
                {ROLES.map(r => (
                  <option key={r} value={r}>{r.toUpperCase()}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-caption text-[var(--foreground-secondary)]">Experience</label>
              <select
                value={newExp}
                onChange={e => setNewExp(e.target.value)}
                className="w-full h-9 px-3 bg-[var(--color-card)] border border-[var(--color-border)] rounded-[6px] text-body text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ds-primary)]"
              >
                <option value="all">All Levels</option>
                <option value="0-2">0-2 years</option>
                <option value="3-6">3-6 years</option>
                <option value="7+">7+ years</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-caption text-[var(--foreground-secondary)]">Duration</label>
              <select
                value={newDuration}
                onChange={e => setNewDuration(Number(e.target.value))}
                className="w-full h-9 px-3 bg-[var(--color-card)] border border-[var(--color-border)] rounded-[6px] text-body text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ds-primary)]"
              >
                <option value={10}>10 min</option>
                <option value={20}>20 min</option>
                <option value={30}>30 min</option>
              </select>
            </div>
          </div>

          {/* Questions */}
          <div className="space-y-2">
            <label className="text-caption text-[var(--foreground-secondary)]">Custom Questions</label>
            {newQuestions.map((q, i) => (
              <div key={i} className="flex gap-2">
                <input
                  type="text"
                  value={q.text}
                  onChange={e => setNewQuestions(prev => prev.map((p, j) => j === i ? { ...p, text: e.target.value } : p))}
                  placeholder={`Question ${i + 1}...`}
                  className="flex-1 h-9 px-3 bg-[var(--color-card)] border border-[var(--color-border)] rounded-[6px] text-body text-[var(--foreground)] placeholder-[var(--foreground-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--ds-primary)]"
                />
                <select
                  value={q.category}
                  onChange={e => setNewQuestions(prev => prev.map((p, j) => j === i ? { ...p, category: e.target.value } : p))}
                  className="h-9 px-2 bg-[var(--color-card)] border border-[var(--color-border)] rounded-[6px] text-caption text-[var(--foreground-secondary)] focus:outline-none"
                >
                  {CATEGORIES.map(cat => (
                    <option key={cat} value={cat}>{cat.charAt(0).toUpperCase() + cat.slice(1)}</option>
                  ))}
                </select>
                {newQuestions.length > 1 && (
                  <button onClick={() => removeQuestion(i)} className="text-[var(--foreground-tertiary)] hover:text-rose-500 transition-colors">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
            <button onClick={addQuestion} className="text-caption text-[var(--ds-primary)] hover:underline transition-colors">
              + Add Question
            </button>
          </div>

          <Button
            variant="primary"
            className="w-full"
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
          >
            {creating ? 'Creating...' : 'Create Template'}
          </Button>
        </div>
      )}

      {/* Template list */}
      {templates.length === 0 && !showCreate ? (
        <StateView
          state="empty"
          title="No templates yet"
          description="Create a template to standardize interviews across your team."
          action={{ label: 'Create Template', onClick: () => setShowCreate(true) }}
        />
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {templates.map(t => (
            <div key={t.id} className="surface-card-bordered p-5">
              <div className="flex items-start justify-between mb-2">
                <h3 className="text-subheading text-[var(--foreground)]">{t.name}</h3>
                <Badge variant={t.isActive ? 'success' : 'default'}>
                  {t.isActive ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              {t.description && <p className="text-caption text-[var(--foreground-secondary)] mb-3">{t.description}</p>}
              <div className="flex items-center gap-3 text-micro text-[var(--foreground-tertiary)]">
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
