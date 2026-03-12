'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface Domain {
  slug: string
  label: string
  category: string
  isActive: boolean
  isBuiltIn: boolean
  sortOrder: number
}

export default function DomainsListPage() {
  const [domains, setDomains] = useState<Domain[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function fetchDomains() {
    try {
      const res = await fetch('/api/cms/domains')
      if (!res.ok) throw new Error('Failed to fetch')
      const data = await res.json()
      setDomains(data.domains || [])
    } catch {
      setError('Failed to fetch domains')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchDomains() }, [])

  async function toggleActive(slug: string, currentActive: boolean) {
    await fetch(`/api/cms/domains/${slug}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !currentActive }),
    })
    fetchDomains()
  }

  async function deleteDomain(slug: string) {
    if (!confirm(`Delete domain "${slug}"?`)) return
    const res = await fetch(`/api/cms/domains/${slug}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json()
      alert(data.error || 'Failed to delete')
      return
    }
    fetchDomains()
  }

  if (loading) return <div className="text-slate-400">Loading domains...</div>
  if (error) return <div className="text-red-400">{error}</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Domains</h2>
        <Link
          href="/cms/domains/new"
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-sm font-medium transition-colors"
        >
          Add Domain
        </Link>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-left text-slate-400">
              <th className="px-4 py-3">Slug</th>
              <th className="px-4 py-3">Label</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Active</th>
              <th className="px-4 py-3">Sort Order</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {domains.map((domain) => (
              <tr key={domain.slug} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                <td className="px-4 py-3 font-mono text-xs">{domain.slug}</td>
                <td className="px-4 py-3">{domain.label}</td>
                <td className="px-4 py-3 capitalize">{domain.category}</td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => toggleActive(domain.slug, domain.isActive)}
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      domain.isActive
                        ? 'bg-green-900/50 text-green-400'
                        : 'bg-yellow-900/50 text-yellow-400'
                    }`}
                  >
                    {domain.isActive ? 'Active' : 'Inactive'}
                  </button>
                </td>
                <td className="px-4 py-3">{domain.sortOrder}</td>
                <td className="px-4 py-3 space-x-2">
                  <Link
                    href={`/cms/domains/${domain.slug}`}
                    className="text-indigo-400 hover:text-indigo-300 text-xs"
                  >
                    Edit
                  </Link>
                  {!domain.isBuiltIn && (
                    <button
                      onClick={() => deleteDomain(domain.slug)}
                      className="text-red-400 hover:text-red-300 text-xs"
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {domains.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                  No domains found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
