'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface Category {
  slug: string
  label: string
  icon: string
  description: string
  isActive: boolean
  isBuiltIn: boolean
  sortOrder: number
}

export default function CategoriesListPage() {
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function fetchCategories() {
    try {
      const res = await fetch('/api/cms/categories')
      if (!res.ok) throw new Error('Failed to fetch')
      const data = await res.json()
      setCategories(data.categories || [])
    } catch {
      setError('Failed to fetch categories')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchCategories() }, [])

  async function toggleActive(slug: string, currentActive: boolean) {
    await fetch(`/api/cms/categories/${slug}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !currentActive }),
    })
    fetchCategories()
  }

  async function deleteCategory(slug: string) {
    if (!confirm(`Delete category "${slug}"?`)) return
    const res = await fetch(`/api/cms/categories/${slug}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json()
      alert(data.error || 'Failed to delete')
      return
    }
    fetchCategories()
  }

  if (loading) return <div className="text-[#536471]">Loading categories...</div>
  if (error) return <div className="text-red-400">{error}</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Categories</h2>
        <Link
          href="/cms/categories/new"
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
        >
          Add Category
        </Link>
      </div>

      <p className="text-sm text-[#8b98a5] mb-4">
        Top-level fields a candidate picks before choosing a role. A role is linked to a category via its
        <span className="font-mono"> categorySlug</span>.
      </p>

      <div className="bg-white border border-[#e1e8ed] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#e1e8ed] text-left text-[#536471]">
              <th className="px-4 py-3">Slug</th>
              <th className="px-4 py-3">Label</th>
              <th className="px-4 py-3">Icon</th>
              <th className="px-4 py-3">Active</th>
              <th className="px-4 py-3">Sort Order</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((category) => (
              <tr key={category.slug} className="border-b border-[#eff3f4] hover:bg-[#f8fafc]">
                <td className="px-4 py-3 font-mono text-xs">{category.slug}</td>
                <td className="px-4 py-3">{category.label}</td>
                <td className="px-4 py-3 text-lg">{category.icon}</td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => toggleActive(category.slug, category.isActive)}
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      category.isActive
                        ? 'bg-green-900/50 text-green-400'
                        : 'bg-yellow-900/50 text-yellow-400'
                    }`}
                  >
                    {category.isActive ? 'Active' : 'Inactive'}
                  </button>
                </td>
                <td className="px-4 py-3">{category.sortOrder}</td>
                <td className="px-4 py-3 space-x-2">
                  <Link href={`/cms/categories/${category.slug}`} className="text-[#2563eb] hover:text-[#2563eb] text-xs">
                    Edit
                  </Link>
                  {!category.isBuiltIn && (
                    <button
                      onClick={() => deleteCategory(category.slug)}
                      className="text-red-400 hover:text-red-300 text-xs"
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {categories.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-[#8b98a5]">
                  No categories found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
