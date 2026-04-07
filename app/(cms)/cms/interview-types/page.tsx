'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface InterviewType {
  slug: string
  label: string
  isActive: boolean
  isBuiltIn: boolean
  sortOrder: number
  applicableDomains: string[]
}

export default function InterviewTypesListPage() {
  const [types, setTypes] = useState<InterviewType[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function fetchTypes() {
    try {
      const res = await fetch('/api/cms/interview-types')
      if (!res.ok) throw new Error('Failed to fetch')
      const data = await res.json()
      setTypes(data.interviewTypes || [])
    } catch {
      setError('Failed to fetch interview types')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchTypes() }, [])

  async function toggleActive(slug: string, currentActive: boolean) {
    await fetch(`/api/cms/interview-types/${slug}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !currentActive }),
    })
    fetchTypes()
  }

  async function deleteType(slug: string) {
    if (!confirm(`Delete interview type "${slug}"?`)) return
    const res = await fetch(`/api/cms/interview-types/${slug}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json()
      alert(data.error || 'Failed to delete')
      return
    }
    fetchTypes()
  }

  if (loading) return <div className="text-[#536471]">Loading interview types...</div>
  if (error) return <div className="text-red-400">{error}</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Interview Types</h2>
        <Link
          href="/cms/interview-types/new"
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors"
        >
          Add Interview Type
        </Link>
      </div>

      <div className="bg-white border border-[#e1e8ed] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#e1e8ed] text-left text-[#536471]">
              <th className="px-4 py-3">Slug</th>
              <th className="px-4 py-3">Label</th>
              <th className="px-4 py-3">Domains</th>
              <th className="px-4 py-3">Active</th>
              <th className="px-4 py-3">Sort Order</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {types.map((t) => (
              <tr key={t.slug} className="border-b border-[#eff3f4] hover:bg-[#f8fafc]">
                <td className="px-4 py-3 font-mono text-xs">{t.slug}</td>
                <td className="px-4 py-3">{t.label}</td>
                <td className="px-4 py-3 text-xs text-[#536471]">
                  {t.applicableDomains?.length
                    ? t.applicableDomains.join(', ')
                    : 'All'}
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => toggleActive(t.slug, t.isActive)}
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      t.isActive
                        ? 'bg-green-900/50 text-green-400'
                        : 'bg-yellow-900/50 text-yellow-400'
                    }`}
                  >
                    {t.isActive ? 'Active' : 'Inactive'}
                  </button>
                </td>
                <td className="px-4 py-3">{t.sortOrder}</td>
                <td className="px-4 py-3 space-x-2">
                  <Link
                    href={`/cms/interview-types/${t.slug}`}
                    className="text-[#2563eb] hover:text-[#2563eb] text-xs"
                  >
                    Edit
                  </Link>
                  {!t.isBuiltIn && (
                    <button
                      onClick={() => deleteType(t.slug)}
                      className="text-red-400 hover:text-red-300 text-xs"
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {types.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-[#8b98a5]">
                  No interview types found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
