'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Check } from 'lucide-react'
import Input from '@shared/ui/Input'
import Button from '@shared/ui/Button'
import Badge from '@shared/ui/Badge'
import SelectionGroup from '@shared/ui/SelectionGroup'
import StateView from '@shared/ui/StateView'

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

const DURATION_OPTIONS = [
  { key: '10', label: '10 min' },
  { key: '20', label: '20 min' },
  { key: '30', label: '30 min' },
]

const PLAN_FEATURES: Record<string, string[]> = {
  starter: ['Up to 5 team members', '100 interviews/month', 'Basic templates', 'Email support'],
  professional: ['Up to 25 team members', '500 interviews/month', 'Custom templates', 'Webhooks', 'Priority support'],
  enterprise: ['Unlimited team members', 'Unlimited interviews', 'Custom branding', 'API access', 'Dedicated support'],
}

export default function HireSettingsPage() {
  const router = useRouter()
  const { status: authStatus } = useSession()
  const [org, setOrg] = useState<OrgData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Create org form
  const [createMode, setCreateMode] = useState(false)
  const [newName, setNewName] = useState('')
  const [newSlug, setNewSlug] = useState('')
  const [newDomain, setNewDomain] = useState('')
  const [createError, setCreateError] = useState('')

  // Edit settings
  const [editWelcome, setEditWelcome] = useState('')
  const [editWebhook, setEditWebhook] = useState('')
  const [editDuration, setEditDuration] = useState<string>('10')

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
          setEditDuration(String(data.organization.settings?.defaultDuration || 10))
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
        window.location.reload()
      }
    } catch {
      setCreateError('Network error')
    }
    setSaving(false)
  }

  async function handleSaveSettings() {
    setSaving(true)
    setSaved(false)
    try {
      await fetch('/api/hire/org', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: {
            customWelcomeMessage: editWelcome || undefined,
            webhookUrl: editWebhook || undefined,
            defaultDuration: Number(editDuration),
          },
        }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch { /* ignore */ }
    setSaving(false)
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-heading text-[var(--foreground)]">Organization Settings</h1>
        <StateView state="loading" skeletonLayout="card" skeletonCount={3} />
      </div>
    )
  }

  if (createMode && !org) {
    return (
      <div className="max-w-lg mx-auto py-12 space-y-6">
        <h1 className="text-heading text-[var(--foreground)]">Create Your Organization</h1>
        <p className="text-body text-[var(--foreground-secondary)]">
          Set up your organization to start using IPG Hire for candidate screening.
        </p>

        <div className="surface-card-bordered p-6 space-y-4">
          <Input
            label="Organization Name"
            type="text"
            value={newName}
            onChange={e => { setNewName(e.target.value); if (!newSlug) setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-')) }}
            placeholder="Acme Corp"
          />

          <Input
            label="URL Slug"
            type="text"
            value={newSlug}
            onChange={e => setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
            placeholder="acme-corp"
            hint="Only lowercase letters, numbers, and hyphens"
          />

          <Input
            label="Company Domain"
            type="text"
            value={newDomain}
            onChange={e => setNewDomain(e.target.value)}
            placeholder="acme.com"
            hint="Optional"
          />

          {createError && <p className="text-caption text-rose-500">{createError}</p>}

          <Button
            variant="primary"
            className="w-full"
            onClick={handleCreate}
            disabled={saving}
          >
            {saving ? 'Creating...' : 'Create Organization'}
          </Button>
        </div>
      </div>
    )
  }

  if (!org) return null

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-heading text-[var(--foreground)]">Organization Settings</h1>

      {/* Org info */}
      <section className="surface-card-bordered p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="step-label">Organization</h2>
          <Badge variant="primary">{org.plan}</Badge>
        </div>

        <div className="space-y-2">
          {[
            { label: 'Name', value: org.name },
            { label: 'Slug', value: org.slug, mono: true },
            ...(org.domain ? [{ label: 'Domain', value: org.domain }] : []),
            { label: 'Team Size', value: `${org.currentSeats} / ${org.maxSeats}` },
            { label: 'Monthly Usage', value: `${org.monthlyInterviewsUsed} / ${org.monthlyInterviewLimit}` },
          ].map(row => (
            <div key={row.label} className="flex justify-between text-body">
              <span className="text-[var(--foreground-tertiary)]">{row.label}</span>
              <span className={`text-[var(--foreground-secondary)] ${'mono' in row && row.mono ? 'font-mono text-caption' : ''}`}>{row.value}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Plan features */}
      <section className="surface-card-bordered p-6">
        <h2 className="step-label mb-3">Plan Features</h2>
        <ul className="space-y-1.5">
          {(PLAN_FEATURES[org.plan] || PLAN_FEATURES.starter).map(f => (
            <li key={f} className="flex items-center gap-2 text-body text-[var(--foreground-secondary)]">
              <Check className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
              {f}
            </li>
          ))}
        </ul>
      </section>

      {/* Interview Settings */}
      <section className="surface-card-bordered p-6 space-y-4">
        <h2 className="step-label">Interview Settings</h2>

        <div className="space-y-1.5">
          <label className="text-caption text-[var(--foreground-secondary)]">Default Duration</label>
          <SelectionGroup
            items={DURATION_OPTIONS}
            value={editDuration}
            onChange={setEditDuration}
            getKey={(item) => item.key}
            layout="inline"
            renderItem={(item, selected) => (
              <span className={`block px-2 py-2 text-caption font-medium text-center ${selected ? '' : ''}`}>
                {item.label}
              </span>
            )}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-caption text-[var(--foreground-secondary)]">Custom Welcome Message</label>
          <textarea
            value={editWelcome}
            onChange={e => setEditWelcome(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="A message shown to candidates before starting..."
            className="w-full px-3 py-2.5 bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--ds-radius-sm)] text-body text-[var(--foreground)] placeholder-[var(--foreground-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-primary)] resize-none"
          />
        </div>

        <Input
          label="Webhook URL (results notification)"
          type="url"
          value={editWebhook}
          onChange={e => setEditWebhook(e.target.value)}
          placeholder="https://your-ats.com/webhooks/interview-complete"
        />

        <Button
          variant="primary"
          className="w-full"
          onClick={handleSaveSettings}
          disabled={saving}
        >
          {saved ? 'Saved!' : saving ? 'Saving...' : 'Save Settings'}
        </Button>
      </section>
    </div>
  )
}
