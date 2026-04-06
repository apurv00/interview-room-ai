'use client'

import { useState, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function NewInterviewTypePage() {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [form, setForm] = useState({
    slug: '',
    label: '',
    icon: '',
    description: '',
    systemPromptTemplate: '',
    questionStrategy: '',
    evaluationCriteria: '',
    avatarPersona: '',
    applicableDomains: '',
    scoringDimensions: '[{"name": "relevance", "label": "Relevance", "weight": 0.2}]',
    sortOrder: '0',
  })

  function updateField(field: string, value: string) {
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
      const res = await fetch('/api/cms/interview-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: form.slug,
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
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Failed to create interview type')
        return
      }

      router.push('/cms/interview-types')
    } catch {
      setError('Failed to create interview type')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/cms/interview-types" className="text-[#536471] hover:text-[#0f1419] text-sm">
          &larr; Back
        </Link>
        <h2 className="text-2xl font-bold">New Interview Type</h2>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-800 text-red-400 px-4 py-3 rounded-lg mb-4">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-[#536471] mb-1">Slug</label>
            <input
              type="text"
              required
              value={form.slug}
              onChange={(e) => updateField('slug', e.target.value)}
              className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none"
              placeholder="e.g. screening"
            />
          </div>
          <div>
            <label className="block text-sm text-[#536471] mb-1">Label</label>
            <input
              type="text"
              required
              value={form.label}
              onChange={(e) => updateField('label', e.target.value)}
              className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none"
              placeholder="e.g. HR Screening"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-[#536471] mb-1">Icon</label>
            <input
              type="text"
              required
              value={form.icon}
              onChange={(e) => updateField('icon', e.target.value)}
              className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none"
              placeholder="e.g. Users or emoji"
            />
          </div>
          <div>
            <label className="block text-sm text-[#536471] mb-1">Sort Order</label>
            <input
              type="number"
              value={form.sortOrder}
              onChange={(e) => updateField('sortOrder', e.target.value)}
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
            placeholder="e.g. frontend, backend, fullstack"
          />
        </div>

        <div>
          <label className="block text-sm text-[#536471] mb-1">
            Scoring Dimensions (JSON)
          </label>
          <textarea
            value={form.scoringDimensions}
            onChange={(e) => updateField('scoringDimensions', e.target.value)}
            rows={5}
            className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none font-mono"
          />
          <p className="text-xs text-[#8b98a5] mt-1">
            Array of {`{ "name": string, "label": string, "weight": number }`}
          </p>
        </div>

        <div className="flex gap-3 pt-4">
          <button
            type="submit"
            disabled={saving}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
          >
            {saving ? 'Creating...' : 'Create Interview Type'}
          </button>
          <Link
            href="/cms/interview-types"
            className="px-6 py-2 bg-[#f7f9f9] hover:bg-[#f7f9f9] rounded-lg text-sm font-medium transition-colors"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
