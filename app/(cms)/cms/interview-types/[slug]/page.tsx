'use client'

import { useEffect, useState, FormEvent } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'

export default function EditInterviewTypePage() {
  const router = useRouter()
  const params = useParams()
  const slug = params.slug as string

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [isBuiltIn, setIsBuiltIn] = useState(false)

  const [form, setForm] = useState({
    label: '',
    icon: '',
    description: '',
    systemPromptTemplate: '',
    questionStrategy: '',
    evaluationCriteria: '',
    avatarPersona: '',
    applicableDomains: '',
    scoringDimensions: '[]',
    sortOrder: '0',
    isActive: true,
  })

  useEffect(() => {
    async function fetchType() {
      try {
        const res = await fetch(`/api/cms/interview-types/${slug}`)
        if (!res.ok) throw new Error('Failed to fetch')
        const data = await res.json()
        const t = data.interviewType
        setIsBuiltIn(t.isBuiltIn)
        setForm({
          label: t.label || '',
          icon: t.icon || '',
          description: t.description || '',
          systemPromptTemplate: t.systemPromptTemplate || '',
          questionStrategy: t.questionStrategy || '',
          evaluationCriteria: t.evaluationCriteria || '',
          avatarPersona: t.avatarPersona || '',
          applicableDomains: (t.applicableDomains || []).join(', '),
          scoringDimensions: JSON.stringify(t.scoringDimensions || [], null, 2),
          sortOrder: String(t.sortOrder || 0),
          isActive: t.isActive !== false,
        })
      } catch {
        setError('Failed to load interview type')
      } finally {
        setLoading(false)
      }
    }
    fetchType()
  }, [slug])

  function updateField(field: string, value: string | boolean) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')

    let scoringDimensions
    try {
      scoringDimensions = JSON.parse(form.scoringDimensions)
    } catch {
      setError('Scoring dimensions must be valid JSON')
      setSaving(false)
      return
    }

    try {
      const res = await fetch(`/api/cms/interview-types/${slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: form.label,
          icon: form.icon,
          description: form.description,
          systemPromptTemplate: form.systemPromptTemplate,
          questionStrategy: form.questionStrategy,
          evaluationCriteria: form.evaluationCriteria,
          avatarPersona: form.avatarPersona,
          applicableDomains: form.applicableDomains
            .split(',')
            .map((d) => d.trim())
            .filter(Boolean),
          scoringDimensions,
          sortOrder: parseInt(form.sortOrder) || 0,
          isActive: form.isActive,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Failed to update interview type')
        return
      }

      router.push('/cms/interview-types')
    } catch {
      setError('Failed to update interview type')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete interview type "${slug}"? This cannot be undone.`)) return
    const res = await fetch(`/api/cms/interview-types/${slug}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json()
      alert(data.error || 'Failed to delete')
      return
    }
    router.push('/cms/interview-types')
  }

  if (loading) return <div className="text-[#536471]">Loading interview type...</div>

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/cms/interview-types" className="text-[#536471] hover:text-[#0f1419] text-sm">
          &larr; Back
        </Link>
        <h2 className="text-2xl font-bold">Edit Interview Type: {slug}</h2>
        {isBuiltIn && (
          <span className="text-xs bg-[#f8fafc] text-[#536471] px-2 py-1 rounded">Built-in</span>
        )}
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-800 text-red-400 px-4 py-3 rounded-lg mb-4">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-[#536471] mb-1">Slug (read-only)</label>
          <input
            type="text"
            value={slug}
            disabled
            className="w-full bg-[#f8fafc] border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#8b98a5] cursor-not-allowed"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-[#536471] mb-1">Label</label>
            <input
              type="text"
              required
              value={form.label}
              onChange={(e) => updateField('label', e.target.value)}
              className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm text-[#536471] mb-1">Icon</label>
            <input
              type="text"
              required
              value={form.icon}
              onChange={(e) => updateField('icon', e.target.value)}
              className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm text-[#536471] mb-1">Description</label>
          <textarea
            required
            value={form.description}
            onChange={(e) => updateField('description', e.target.value)}
            rows={2}
            className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm text-[#536471] mb-1">System Prompt Template</label>
          <textarea
            value={form.systemPromptTemplate}
            onChange={(e) => updateField('systemPromptTemplate', e.target.value)}
            rows={4}
            className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none font-mono"
          />
        </div>

        <div>
          <label className="block text-sm text-[#536471] mb-1">Question Strategy</label>
          <textarea
            value={form.questionStrategy}
            onChange={(e) => updateField('questionStrategy', e.target.value)}
            rows={3}
            className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none font-mono"
          />
        </div>

        <div>
          <label className="block text-sm text-[#536471] mb-1">Evaluation Criteria</label>
          <textarea
            value={form.evaluationCriteria}
            onChange={(e) => updateField('evaluationCriteria', e.target.value)}
            rows={3}
            className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none font-mono"
          />
        </div>

        <div>
          <label className="block text-sm text-[#536471] mb-1">Avatar Persona</label>
          <textarea
            value={form.avatarPersona}
            onChange={(e) => updateField('avatarPersona', e.target.value)}
            rows={2}
            className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm text-[#536471] mb-1">
            Applicable Domains (comma-separated slugs, empty = all)
          </label>
          <input
            type="text"
            value={form.applicableDomains}
            onChange={(e) => updateField('applicableDomains', e.target.value)}
            className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm text-[#536471] mb-1">
            Scoring Dimensions (JSON)
          </label>
          <textarea
            value={form.scoringDimensions}
            onChange={(e) => updateField('scoringDimensions', e.target.value)}
            rows={6}
            className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none font-mono"
          />
          <p className="text-xs text-[#8b98a5] mt-1">
            Array of {`{ "name": string, "label": string, "weight": number }`}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-[#536471] mb-1">Sort Order</label>
            <input
              type="number"
              value={form.sortOrder}
              onChange={(e) => updateField('sortOrder', e.target.value)}
              className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => updateField('isActive', e.target.checked)}
                className="rounded border-[#e1e8ed] bg-white"
              />
              <span className="text-sm text-[#536471]">Active</span>
            </label>
          </div>
        </div>

        <div className="flex gap-3 pt-4">
          <button
            type="submit"
            disabled={saving}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          <Link
            href="/cms/interview-types"
            className="px-6 py-2 bg-[#f8fafc] hover:bg-[#f8fafc] rounded-lg text-sm font-medium transition-colors"
          >
            Cancel
          </Link>
          {!isBuiltIn && (
            <button
              type="button"
              onClick={handleDelete}
              className="px-6 py-2 bg-red-900/50 hover:bg-red-900 text-red-400 rounded-lg text-sm font-medium transition-colors ml-auto"
            >
              Delete
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
