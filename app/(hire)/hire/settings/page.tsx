'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

interface OrgData {
  id: string
  name: string
  slug: string
  domain: string
  plan: string
  maxSeats: number
  currentSeats: number
  monthlyInterviewLimit: number
  monthlyInterviewsUsed: number
  settings: {
    allowedRoles: string[]
    defaultDuration: number
    requireRecording: boolean
    customWelcomeMessage?: string
    webhookUrl?: string
  }
}

export default function HireSettingsPage() {
  const router = useRouter()
  const { status: authStatus } = useSession()
  const [org, setOrg] = useState<OrgData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Create org form
  const [createMode, setCreateMode] = useState(false)
  const [newName, setNewName] = useState('')
  const [newSlug, setNewSlug] = useState('')
  const [newDomain, setNewDomain] = useState('')
  const [createError, setCreateError] = useState('')

  // Edit settings
  const [editWelcome, setEditWelcome] = useState('')
  const [editWebhook, setEditWebhook] = useState('')
  const [editDuration, setEditDuration] = useState(10)

  useEffect(() => {
    if (authStatus === 'unauthenticated') { router.push('/signin'); return }
    if (authStatus !== 'authenticated') return

    fetch('/api/hire/org')
      .then(r => r.json())
      .then(data => {
        if (data.organization) {
          setOrg(data.organization)
          setEditWelcome(data.organization.settings?.customWelcomeMessage || '')
          setEditWebhook(data.organization.settings?.webhookUrl || '')
          setEditDuration(data.organization.settings?.defaultDuration || 10)
        } else {
          setCreateMode(true)
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [authStatus, router])

  async function handleCreate() {
    if (!newName.trim() || !newSlug.trim()) {
      setCreateError('Name and slug are required')
      return
    }
    setCreateError('')
    setSaving(true)
    try {
      const res = await fetch('/api/hire/org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName,
          slug: newSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
          domain: newDomain || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setCreateError(data.error || 'Failed to create organization')
      } else {
        // Reload page to show org
        window.location.reload()
      }
    } catch {
      setCreateError('Network error')
    }
    setSaving(false)
  }

  async function handleSaveSettings() {
    setSaving(true)
    try {
      await fetch('/api/hire/org', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: {
            customWelcomeMessage: editWelcome || undefined,
            webhookUrl: editWebhook || undefined,
            defaultDuration: editDuration,
          },
        }),
      })
    } catch { /* ignore */ }
    setSaving(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
      </div>
    )
  }

  if (createMode && !org) {
    return (
      <div className="max-w-lg mx-auto py-12 space-y-6">
        <h1 className="text-2xl font-bold text-[#0f1419]">Create Your Organization</h1>
        <p className="text-sm text-[#536471]">
          Set up your organization to start using IPG Hire for candidate screening.
        </p>

        <div className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-4">
          <div className="space-y-1.5">
            <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Organization Name *</label>
            <input
              type="text"
              value={newName}
              onChange={e => { setNewName(e.target.value); if (!newSlug) setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-')) }}
              placeholder="Acme Corp"
              className="w-full px-3 py-2.5 bg-[#f7f9f9] border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">URL Slug *</label>
            <input
              type="text"
              value={newSlug}
              onChange={e => setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              placeholder="acme-corp"
              className="w-full px-3 py-2.5 bg-[#f7f9f9] border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-[10px] text-[#8b98a5]">Only lowercase letters, numbers, and hyphens</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Company Domain (optional)</label>
            <input
              type="text"
              value={newDomain}
              onChange={e => setNewDomain(e.target.value)}
              placeholder="acme.com"
              className="w-full px-3 py-2.5 bg-[#f7f9f9] border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {createError && <p className="text-xs text-red-400">{createError}</p>}

          <button
            onClick={handleCreate}
            disabled={saving}
            className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-medium transition-colors disabled:opacity-50"
          >
            {saving ? 'Creating...' : 'Create Organization'}
          </button>
        </div>
      </div>
    )
  }

  if (!org) return null

  const PLAN_FEATURES: Record<string, string[]> = {
    starter: ['Up to 5 team members', '100 interviews/month', 'Basic templates', 'Email support'],
    professional: ['Up to 25 team members', '500 interviews/month', 'Custom templates', 'Webhooks', 'Priority support'],
    enterprise: ['Unlimited team members', 'Unlimited interviews', 'Custom branding', 'API access', 'Dedicated support'],
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-[#0f1419]">Organization Settings</h1>

      {/* Org info */}
      <section className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[#536471] uppercase tracking-widest">Organization</h2>
          <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-600 text-white capitalize">
            {org.plan}
          </span>
        </div>

        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-[#8b98a5]">Name</span>
            <span className="text-[#536471]">{org.name}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-[#8b98a5]">Slug</span>
            <span className="text-[#536471] font-mono text-xs">{org.slug}</span>
          </div>
          {org.domain && (
            <div className="flex justify-between text-sm">
              <span className="text-[#8b98a5]">Domain</span>
              <span className="text-[#536471]">{org.domain}</span>
            </div>
          )}
          <div className="flex justify-between text-sm">
            <span className="text-[#8b98a5]">Team Size</span>
            <span className="text-[#536471]">{org.currentSeats} / {org.maxSeats}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-[#8b98a5]">Monthly Usage</span>
            <span className="text-[#536471]">{org.monthlyInterviewsUsed} / {org.monthlyInterviewLimit}</span>
          </div>
        </div>
      </section>

      {/* Plan features */}
      <section className="bg-white border border-[#e1e8ed] rounded-2xl p-6">
        <h2 className="text-sm font-semibold text-[#536471] uppercase tracking-widest mb-3">Plan Features</h2>
        <ul className="space-y-1.5">
          {(PLAN_FEATURES[org.plan] || PLAN_FEATURES.starter).map(f => (
            <li key={f} className="flex items-center gap-2 text-sm text-[#536471]">
              <svg className="w-3.5 h-3.5 text-[#059669] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              {f}
            </li>
          ))}
        </ul>
      </section>

      {/* Interview Settings */}
      <section className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-4">
        <h2 className="text-sm font-semibold text-[#536471] uppercase tracking-widest">Interview Settings</h2>

        <div className="space-y-1.5">
          <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Default Duration</label>
          <div className="grid grid-cols-3 gap-2">
            {[10, 20, 30].map(d => (
              <button
                key={d}
                onClick={() => setEditDuration(d)}
                className={`py-2 rounded-lg border text-xs font-medium transition-all ${
                  editDuration === d ? 'border-blue-500 bg-blue-500/10 text-[#2563eb]' : 'border-[#e1e8ed] bg-[#f7f9f9] text-[#536471] hover:border-[#e1e8ed]'
                }`}
              >
                {d} min
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Custom Welcome Message</label>
          <textarea
            value={editWelcome}
            onChange={e => setEditWelcome(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="A message shown to candidates before starting..."
            className="w-full px-3 py-2.5 bg-[#f7f9f9] border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Webhook URL (results notification)</label>
          <input
            type="url"
            value={editWebhook}
            onChange={e => setEditWebhook(e.target.value)}
            placeholder="https://your-ats.com/webhooks/interview-complete"
            className="w-full px-3 py-2.5 bg-[#f7f9f9] border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <button
          onClick={handleSaveSettings}
          disabled={saving}
          className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-medium text-sm transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </section>
    </div>
  )
}
