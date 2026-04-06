'use client'

import { useEffect, useState, FormEvent } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'

export default function EditDomainPage() {
  const router = useRouter()
  const params = useParams()
  const slug = params.slug as string

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [isBuiltIn, setIsBuiltIn] = useState(false)

  const [form, setForm] = useState({
    label: '',
    shortLabel: '',
    icon: '',
    description: '',
    color: 'indigo',
    category: 'engineering',
    systemPromptContext: '',
    sampleQuestions: '',
    evaluationEmphasis: '',
    sortOrder: '0',
    isActive: true,
  })

  useEffect(() => {
    async function fetchDomain() {
      try {
        const res = await fetch(`/api/cms/domains/${slug}`)
        if (!res.ok) throw new Error('Failed to fetch')
        const data = await res.json()
        const d = data.domain
        setIsBuiltIn(d.isBuiltIn)
        setForm({
          label: d.label || '',
          shortLabel: d.shortLabel || '',
          icon: d.icon || '',
          description: d.description || '',
          color: d.color || 'indigo',
          category: d.category || 'engineering',
          systemPromptContext: d.systemPromptContext || '',
          sampleQuestions: (d.sampleQuestions || []).join('\n'),
          evaluationEmphasis: (d.evaluationEmphasis || []).join('\n'),
          sortOrder: String(d.sortOrder || 0),
          isActive: d.isActive !== false,
        })
      } catch {
        setError('Failed to load domain')
      } finally {
        setLoading(false)
      }
    }
    fetchDomain()
  }, [slug])

  function updateField(field: string, value: string | boolean) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')

    try {
      const res = await fetch(`/api/cms/domains/${slug}`, {
        method: 'PUT',
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
        setError(data.error || 'Failed to update domain')
        return
      }

      router.push('/cms/domains')
    } catch {
      setError('Failed to update domain')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete domain "${slug}"? This cannot be undone.`)) return
    const res = await fetch(`/api/cms/domains/${slug}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json()
      alert(data.error || 'Failed to delete')
      return
    }
    router.push('/cms/domains')
  }

  if (loading) return <div className="text-[#536471]">Loading domain...</div>

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/cms/domains" className="text-[#536471] hover:text-[#0f1419] text-sm">
          &larr; Back
        </Link>
        <h2 className="text-2xl font-bold">Edit Domain: {slug}</h2>
        {isBuiltIn && (
          <span className="text-xs bg-[#f7f9f9] text-[#536471] px-2 py-1 rounded">Built-in</span>
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
            className="w-full bg-[#f7f9f9] border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#8b98a5] cursor-not-allowed"
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
            <label className="block text-sm text-[#536471] mb-1">Short Label</label>
            <input
              type="text"
              required
              value={form.shortLabel}
              onChange={(e) => updateField('shortLabel', e.target.value)}
              className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none"
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
            />
          </div>
          <div>
            <label className="block text-sm text-[#536471] mb-1">Color</label>
            <input
              type="text"
              value={form.color}
              onChange={(e) => updateField('color', e.target.value)}
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

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-[#536471] mb-1">Category</label>
            <select
              value={form.category}
              onChange={(e) => updateField('category', e.target.value)}
              className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none"
            >
              <option value="engineering">Engineering</option>
              <option value="business">Business</option>
              <option value="design">Design</option>
              <option value="operations">Operations</option>
            </select>
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

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="isActive"
            checked={form.isActive}
            onChange={(e) => updateField('isActive', e.target.checked)}
            className="rounded border-[#e1e8ed] bg-white"
          />
          <label htmlFor="isActive" className="text-sm text-[#536471]">Active</label>
        </div>

        <div>
          <label className="block text-sm text-[#536471] mb-1">System Prompt Context</label>
          <textarea
            value={form.systemPromptContext}
            onChange={(e) => updateField('systemPromptContext', e.target.value)}
            rows={4}
            className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none font-mono"
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
            className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none"
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
            className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none"
          />
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
            href="/cms/domains"
            className="px-6 py-2 bg-[#f7f9f9] hover:bg-[#f7f9f9] rounded-lg text-sm font-medium transition-colors"
          >
            Cancel
          </Link>
          {!isBuiltIn && (
            <button
              type="button"
              onClick={handleDelete}
              className="px-6 py-2 bg-red-900/50 hover:bg-red-900 text-red-400 rounded-lg text-sm font-medium transition-colors ml-auto"
            >
              Delete Domain
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
