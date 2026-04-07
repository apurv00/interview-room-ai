'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import dynamic from 'next/dynamic'
import DailyChallengeCard from '@learn/components/DailyChallengeCard'
import StreakCalendar from '@learn/components/StreakCalendar'
import StreakMilestoneBar from '@learn/components/StreakMilestoneBar'

// Lazy-load recharts to avoid SSR issues and reduce bundle size
const LineChart = dynamic(() => import('recharts').then(m => m.LineChart), { ssr: false })
const Line = dynamic(() => import('recharts').then(m => m.Line), { ssr: false })
const XAxis = dynamic(() => import('recharts').then(m => m.XAxis), { ssr: false })
const YAxis = dynamic(() => import('recharts').then(m => m.YAxis), { ssr: false })
const CartesianGrid = dynamic(() => import('recharts').then(m => m.CartesianGrid), { ssr: false })
const Tooltip = dynamic(() => import('recharts').then(m => m.Tooltip), { ssr: false })
const ResponsiveContainer = dynamic(() => import('recharts').then(m => m.ResponsiveContainer), { ssr: false })
const RadarChart = dynamic(() => import('recharts').then(m => m.RadarChart), { ssr: false })
const Radar = dynamic(() => import('recharts').then(m => m.Radar), { ssr: false })
const PolarGrid = dynamic(() => import('recharts').then(m => m.PolarGrid), { ssr: false })
const PolarAngleAxis = dynamic(() => import('recharts').then(m => m.PolarAngleAxis), { ssr: false })
const PolarRadiusAxis = dynamic(() => import('recharts').then(m => m.PolarRadiusAxis), { ssr: false })
const BarChart = dynamic(() => import('recharts').then(m => m.BarChart), { ssr: false })
const Bar = dynamic(() => import('recharts').then(m => m.Bar), { ssr: false })

interface AnalyticsData {
  stats: {
    totalSessions: number
    avgScore: number
    currentStreak: number
    longestStreak: number
  }
  scoreTrend: Array<{ date: string; score: number; domain: string }>
  competencyRadar: Array<{ competency: string; score: number; trend: string }>
  sessionsPerWeek: Array<{ week: string; count: number }>
  communicationTrend: Array<{ date: string; wpm: number; fillerRate: number }>
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="surface-card-bordered p-5 flex flex-col gap-1">
      <span className="text-xs text-[#71767b] uppercase tracking-wide">{label}</span>
      <span className="text-2xl font-bold text-[#0f1419]">{value}</span>
      {sub && <span className="text-xs text-[#8b98a5]">{sub}</span>}
    </div>
  )
}

export default function DashboardPage() {
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<'7d' | '30d' | 'all'>('all')

  useEffect(() => {
    setLoading(true)
    fetch(`/api/learn/analytics?period=${period}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [period])

  if (loading) {
    return (
      <main className="max-w-6xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-[#eff3f4] rounded w-60" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map(i => <div key={i} className="h-24 bg-[#eff3f4] rounded-xl" />)}
          </div>
          <div className="h-64 bg-[#eff3f4] rounded-xl" />
        </div>
      </main>
    )
  }

  if (!data) {
    return (
      <main className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-[#0f1419] mb-4">Analytics Dashboard</h1>
        <p className="text-[#71767b]">Unable to load analytics data. Please try again later.</p>
      </main>
    )
  }

  const { stats, scoreTrend, competencyRadar, sessionsPerWeek, communicationTrend } = data

  return (
    <main className="max-w-6xl mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <motion.h1
          className="text-2xl font-bold text-[#0f1419]"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          Analytics Dashboard
        </motion.h1>

        <div className="flex gap-1 p-1 bg-[#eff3f4] rounded-lg">
          {(['7d', '30d', 'all'] as const).map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                period === p
                  ? 'bg-white text-[#0f1419]'
                  : 'text-[#71767b] hover:text-[#536471]'
              }`}
            >
              {p === 'all' ? 'All Time' : p === '7d' ? '7 Days' : '30 Days'}
            </button>
          ))}
        </div>
      </div>

      {/* Daily Challenge */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
      >
        <DailyChallengeCard />
      </motion.div>

      {/* Streak Calendar + Milestone */}
      <motion.div
        className="space-y-3"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08 }}
      >
        <StreakCalendar />
        <StreakMilestoneBar currentStreak={stats.currentStreak} />
      </motion.div>

      {/* Stat Cards */}
      <motion.div
        className="grid grid-cols-2 md:grid-cols-4 gap-4"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <StatCard label="Total Sessions" value={stats.totalSessions} />
        <StatCard label="Avg Score" value={stats.avgScore > 0 ? `${stats.avgScore}/100` : '--'} />
        <StatCard
          label="Current Streak"
          value={stats.currentStreak > 0 ? `${stats.currentStreak} day${stats.currentStreak !== 1 ? 's' : ''}` : '--'}
        />
        <StatCard
          label="Longest Streak"
          value={stats.longestStreak > 0 ? `${stats.longestStreak} day${stats.longestStreak !== 1 ? 's' : ''}` : '--'}
        />
      </motion.div>

      {/* Score Trend */}
      {scoreTrend.length > 1 && (
        <motion.section
          className="surface-card-bordered p-5 sm:p-6"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <h2 className="text-sm font-semibold text-[#0f1419] mb-4">Score Over Time</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={scoreTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e1e8ed" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: '#71767b' }}
                  tickFormatter={(v: string) => {
                    const d = new Date(v)
                    return `${d.getMonth() + 1}/${d.getDate()}`
                  }}
                />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#71767b' }} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#ffffff', border: '1px solid #e1e8ed', borderRadius: '8px' }}
                  labelStyle={{ color: '#536471' }}
                  itemStyle={{ color: '#60a5fa' }}
                />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke="#60a5fa"
                  strokeWidth={2}
                  dot={{ r: 3, fill: '#60a5fa' }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </motion.section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Competency Radar */}
        {competencyRadar.length > 0 && (
          <motion.section
            className="surface-card-bordered p-5 sm:p-6"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            <h2 className="text-sm font-semibold text-[#0f1419] mb-4">Competency Snapshot</h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart data={competencyRadar} outerRadius="70%">
                  <PolarGrid stroke="#e1e8ed" />
                  <PolarAngleAxis
                    dataKey="competency"
                    tick={{ fontSize: 10, fill: '#8b98a5' }}
                  />
                  <PolarRadiusAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#71767b' }} />
                  <Radar
                    dataKey="score"
                    stroke="#2563eb"
                    fill="#2563eb"
                    fillOpacity={0.2}
                  />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          </motion.section>
        )}

        {/* Sessions Per Week */}
        {sessionsPerWeek.length > 0 && (
          <motion.section
            className="surface-card-bordered p-5 sm:p-6"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
          >
            <h2 className="text-sm font-semibold text-[#0f1419] mb-4">Sessions Per Week</h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sessionsPerWeek}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e1e8ed" />
                  <XAxis
                    dataKey="week"
                    tick={{ fontSize: 10, fill: '#71767b' }}
                    tickFormatter={(v: string) => {
                      const d = new Date(v)
                      return `${d.getMonth() + 1}/${d.getDate()}`
                    }}
                  />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#71767b' }} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#ffffff', border: '1px solid #e1e8ed', borderRadius: '8px' }}
                    labelStyle={{ color: '#536471' }}
                  />
                  <Bar dataKey="count" fill="#34d399" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </motion.section>
        )}
      </div>

      {/* Communication Trend */}
      {communicationTrend.length > 1 && (
        <motion.section
          className="surface-card-bordered p-5 sm:p-6"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
        >
          <h2 className="text-sm font-semibold text-[#0f1419] mb-4">Communication Trends</h2>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={communicationTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e1e8ed" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: '#71767b' }}
                  tickFormatter={(v: string) => {
                    const d = new Date(v)
                    return `${d.getMonth() + 1}/${d.getDate()}`
                  }}
                />
                <YAxis yAxisId="wpm" tick={{ fontSize: 11, fill: '#71767b' }} />
                <YAxis yAxisId="filler" orientation="right" tick={{ fontSize: 11, fill: '#71767b' }} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#ffffff', border: '1px solid #e1e8ed', borderRadius: '8px' }}
                  labelStyle={{ color: '#536471' }}
                />
                <Line yAxisId="wpm" type="monotone" dataKey="wpm" stroke="#f59e0b" strokeWidth={2} dot={false} name="WPM" />
                <Line yAxisId="filler" type="monotone" dataKey="fillerRate" stroke="#f87171" strokeWidth={2} dot={false} name="Filler %" />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="flex gap-6 mt-3">
            <span className="text-xs text-[#71767b] flex items-center gap-1.5">
              <span className="w-3 h-0.5 bg-[#d97706] rounded" /> Words Per Minute
            </span>
            <span className="text-xs text-[#71767b] flex items-center gap-1.5">
              <span className="w-3 h-0.5 bg-[#f4212e] rounded" /> Filler Rate
            </span>
          </div>
        </motion.section>
      )}

      {/* Empty state */}
      {stats.totalSessions === 0 && (
        <div className="text-center py-16">
          <p className="text-[#71767b] mb-4">No session data yet. Complete an interview to see your analytics!</p>
          <a
            href="/lobby"
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Start an Interview
          </a>
        </div>
      )}
    </main>
  )
}
