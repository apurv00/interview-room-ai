'use client'

import { useEffect, useState, FormEvent } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'

export default function EditCategoryPage() {
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
    sortOrder: '0',
    isActive: true,
  })

  useEffect(() => {
    async function fetchCategory() {
      try {
        const res = await fetch(`/api/cms/categories/${slug}`)
        if (!res.ok) throw new Error('Failed to fetch')
        const data = await res.json()
        const c = data.category
        setIsBuiltIn(c.isBuiltIn)
        setForm({
          label: c.label || '',
          icon: c.icon || '',
          description: c.description || '',
          sortOrder: String(c.sortOrder || 0),
          isActive: c.isActive !== false,
        })
      } catch {
        setError('Failed to load category')
      } finally {
        setLoading(false)
      }
    }
    fetchCategory()
  }, [slug])

  function updateField(field: string, value: string | boolean) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')

    try {
      const res = await fetch(`/api/cms/categories/${slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, sortOrder: parseInt(form.sortOrder) || 0 }),
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Failed to update category')
        return
      }
      router.push('/cms/categories')
    } catch {
      setError('Failed to update category')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete category "${slug}"? This cannot be undone.`)) return
    const res = await fetch(`/api/cms/categories/${slug}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json()
      alert(data.error || 'Failed to delete')
      return
    }
    router.push('/cms/categories')
  }

  if (loading) return <div className="text-[#536471]">Loading category...</div>

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/cms/categories" className="text-[#536471] hover:text-[#0f1419] text-sm">&larr; Back</Link>
        <h2 className="text-2xl font-bold">Edit Category: {slug}</h2>
        {isBuiltIn && <span className="text-xs bg-[#f8fafc] text-[#536471] px-2 py-1 rounded">Built-in</span>}
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-800 text-red-400 px-4 py-3 rounded-lg mb-4">{error}</div>
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
              value={form.icon}
              onChange={(e) => updateField('icon', e.target.value)}
              className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm text-[#536471] mb-1">Description</label>
          <textarea
            value={form.description}
            onChange={(e) => updateField('description', e.target.value)}
            rows={2}
            className="w-full bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm text-[#536471] mb-1">Sort Order</label>
          <input
            type="number"
            value={form.sortOrder}
            onChange={(e) => updateField('sortOrder', e.target.value)}
            className="w-32 bg-white border border-[#e1e8ed] rounded-lg px-3 py-2 text-sm text-[#0f1419] focus:border-blue-500 focus:outline-none"
          />
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

        <div className="flex gap-3 pt-4">
          <button
            type="submit"
            disabled={saving}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          <Link href="/cms/categories" className="px-6 py-2 bg-[#f8fafc] hover:bg-[#f8fafc] rounded-lg text-sm font-medium transition-colors">
            Cancel
          </Link>
          {!isBuiltIn && (
            <button
              type="button"
              onClick={handleDelete}
              className="px-6 py-2 bg-red-900/50 hover:bg-red-900 text-red-400 rounded-lg text-sm font-medium transition-colors ml-auto"
            >
              Delete Category
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
