'use client'

import { useState, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function NewDomainPage() {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [form, setForm] = useState({
    slug: '',
    label: '',
    shortLabel: '',
    icon: '',
    description: '',
    color: 'indigo',
    category: 'engineering' as string,
    systemPromptContext: '',
    sampleQuestions: '',
    evaluationEmphasis: '',
    sortOrder: '0',
  })

  function updateField(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')

    try {
      const res = await fetch('/api/cms/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          sortOrder: parseInt(form.sortOrder) || 0,
          sampleQuestions: form.sampleQuestions
            .split('\n')
            .map((q) => q.trim())
            .filter(Boolean),
          evaluationEmphasis: form.evaluationEmphasis
            .split('\n')
            .map((e) => e.trim())
            .filter(Boolean),
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Failed to create domain')
        return
      }

      router.push('/cms/domains')
    } catch {
      setError('Failed to create domain')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/cms/domains" className="text-[#536471] hover:text-[#0f1419] text-sm">
          &larr; Back
        </Link>
        <h2 className="text-2xl font-bold">New Domain</h2>
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
              className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-indigo-500 focus:outline-none"
              placeholder="e.g. backend-engineering"
            />
          </div>
          <div>
            <label className="block text-sm text-[#536471] mb-1">Label</label>
            <input
              type="text"
              required
              value={form.label}
              onChange={(e) => updateField('label', e.target.value)}
              className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-indigo-500 focus:outline-none"
              placeholder="e.g. Backend Engineering"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-[#536471] mb-1">Short Label</label>
            <input
              type="text"
              required
              value={form.shortLabel}
              onChange={(e) => updateField('shortLabel', e.target.value)}
              className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-indigo-500 focus:outline-none"
              placeholder="e.g. Backend"
            />
          </div>
          <div>
            <label className="block text-sm text-[#536471] mb-1">Icon</label>
            <input
              type="text"
              required
              value={form.icon}
              onChange={(e) => updateField('icon', e.target.value)}
              className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-indigo-500 focus:outline-none"
              placeholder="e.g. Server or emoji"
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
            className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-[#536471] mb-1">Color</label>
            <input
              type="text"
              value={form.color}
              onChange={(e) => updateField('color', e.target.value)}
              className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-indigo-500 focus:outline-none"
              placeholder="e.g. indigo"
            />
          </div>
          <div>
            <label className="block text-sm text-[#536471] mb-1">Category</label>
            <select
              value={form.category}
              onChange={(e) => updateField('category', e.target.value)}
              className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-indigo-500 focus:outline-none"
            >
              <option value="engineering">Engineering</option>
              <option value="business">Business</option>
              <option value="design">Design</option>
              <option value="operations">Operations</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm text-[#536471] mb-1">Sort Order</label>
          <input
            type="number"
            value={form.sortOrder}
            onChange={(e) => updateField('sortOrder', e.target.value)}
            className="w-32 bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm text-[#536471] mb-1">System Prompt Context</label>
          <textarea
            value={form.systemPromptContext}
            onChange={(e) => updateField('systemPromptContext', e.target.value)}
            rows={4}
            className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-indigo-500 focus:outline-none font-mono"
          />
        </div>

        <div>
          <label className="block text-sm text-[#536471] mb-1">
            Sample Questions (one per line)
          </label>
          <textarea
            value={form.sampleQuestions}
            onChange={(e) => updateField('sampleQuestions', e.target.value)}
            rows={4}
            className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-indigo-500 focus:outline-none"
            placeholder="Tell me about a complex system you built&#10;How do you handle code reviews?"
          />
        </div>

        <div>
          <label className="block text-sm text-[#536471] mb-1">
            Evaluation Emphasis (one per line)
          </label>
          <textarea
            value={form.evaluationEmphasis}
            onChange={(e) => updateField('evaluationEmphasis', e.target.value)}
            rows={3}
            className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-indigo-500 focus:outline-none"
            placeholder="System design thinking&#10;Technical depth"
          />
        </div>

        <div className="flex gap-3 pt-4">
          <button
            type="submit"
            disabled={saving}
            className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
          >
            {saving ? 'Creating...' : 'Create Domain'}
          </button>
          <Link
            href="/cms/domains"
            className="px-6 py-2 bg-[#f7f9f9] hover:bg-[#f7f9f9] rounded-lg text-sm font-medium transition-colors"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
