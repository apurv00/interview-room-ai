'use client'

import { useEffect, useState } from 'react'

interface Stats {
  totalDomains: number
  activeDomains: number
  inactiveDomains: number
  totalInterviewTypes: number
  activeInterviewTypes: number
  inactiveInterviewTypes: number
}

export default function CmsDashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    async function fetchStats() {
      try {
        const [domainsRes, typesRes] = await Promise.all([
          fetch('/api/cms/domains'),
          fetch('/api/cms/interview-types'),
        ])

        if (!domainsRes.ok || !typesRes.ok) {
          setError('Failed to fetch data. Make sure you are logged in as a platform admin.')
          setLoading(false)
          return
        }

        const domainsData = await domainsRes.json()
        const typesData = await typesRes.json()

        const domains = domainsData.domains || []
        const types = typesData.interviewTypes || []

        setStats({
          totalDomains: domains.length,
          activeDomains: domains.filter((d: { isActive: boolean }) => d.isActive).length,
          inactiveDomains: domains.filter((d: { isActive: boolean }) => !d.isActive).length,
          totalInterviewTypes: types.length,
          activeInterviewTypes: types.filter((t: { isActive: boolean }) => t.isActive).length,
          inactiveInterviewTypes: types.filter((t: { isActive: boolean }) => !t.isActive).length,
        })
      } catch {
        setError('Failed to fetch stats')
      } finally {
        setLoading(false)
      }
    }
    fetchStats()
  }, [])

  if (loading) {
    return <div className="text-slate-400">Loading dashboard...</div>
  }

  if (error) {
    return <div className="text-red-400">{error}</div>
  }

  const cards = [
    { title: 'Total Domains', value: stats?.totalDomains ?? 0, color: 'text-indigo-400' },
    { title: 'Active Domains', value: stats?.activeDomains ?? 0, color: 'text-green-400' },
    { title: 'Inactive Domains', value: stats?.inactiveDomains ?? 0, color: 'text-yellow-400' },
    { title: 'Total Interview Types', value: stats?.totalInterviewTypes ?? 0, color: 'text-indigo-400' },
    { title: 'Active Interview Types', value: stats?.activeInterviewTypes ?? 0, color: 'text-green-400' },
    { title: 'Inactive Interview Types', value: stats?.inactiveInterviewTypes ?? 0, color: 'text-yellow-400' },
  ]

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Dashboard</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((card) => (
          <div
            key={card.title}
            className="bg-slate-900 border border-slate-800 rounded-xl p-6"
          >
            <p className="text-sm text-slate-400 mb-1">{card.title}</p>
            <p className={`text-3xl font-bold ${card.color}`}>{card.value}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
