'use client'

/**
 * Workspace entry: established members land on Overview; a user with no workspace gets the
 * create form (the creator becomes the single admin — build plan §Permission
 * model). Empty states are designed first: creating a workspace drops you
 * straight into creating your first job.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'
import StateView from '@shared/ui/StateView'

export default function WorkspaceEntryPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [hasWorkspace, setHasWorkspace] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [guestAuthMode, setGuestAuthMode] = useState<'magic_link' | 'otp'>('magic_link')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/workspace')
      const data = await res.json()
      if (data.workspace) {
        setHasWorkspace(true)
        router.replace('/workspace/overview')
        return
      }
      setHasWorkspace(false)
    } catch {
      setError('Could not load your workspace.')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => {
    void load()
  }, [load])

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), guestAuthMode }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Could not create the workspace.')
        return
      }
      router.replace('/workspace/jobs?welcome=1')
    } catch {
      setError('Could not create the workspace. Check your connection.')
    } finally {
      setCreating(false)
    }
  }

  if (loading || hasWorkspace) {
    return <StateView state="loading" skeletonLayout="card" />
  }

  return (
    <div className="max-w-md mx-auto mt-12">
      <div className="bg-white border border-[#e1e8ed] rounded-2xl p-8 space-y-5">
        <div className="space-y-1">
          <h1 className="text-xl font-bold text-[#0f1419]">Create your workspace</h1>
          <p className="text-sm text-[#536471]">
            One workspace per company. You&apos;ll be the admin and can add your HR
            team by email — interviewers and stakeholders never need accounts.
          </p>
        </div>
        <form onSubmit={create} className="space-y-4">
          <Input
            label="Company name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Inc."
            required
            minLength={2}
            maxLength={120}
          />
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-[#0f1419]">
              How do candidates verify on interview links?
            </legend>
            <p className="text-xs text-[#71767b]">
              You can change this any time from the Team page — links already sent
              keep the mode they were sent with.
            </p>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="guestAuthMode"
                checked={guestAuthMode === 'magic_link'}
                onChange={() => setGuestAuthMode('magic_link')}
                className="mt-0.5"
              />
              <span>
                <strong>Magic link</strong> — the emailed link takes them straight to
                the consent screen and interview. Fastest for candidates.
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="guestAuthMode"
                checked={guestAuthMode === 'otp'}
                onChange={() => setGuestAuthMode('otp')}
                className="mt-0.5"
              />
              <span>
                <strong>Email code</strong> — we additionally email them a 6-digit
                code to confirm mailbox access before the interview starts.
              </span>
            </label>
          </fieldset>
          {error && <p className="text-xs text-[#f4212e]">{error}</p>}
          <Button type="submit" disabled={creating || name.trim().length < 2}>
            {creating ? 'Creating…' : 'Create workspace'}
          </Button>
        </form>
      </div>
    </div>
  )
}
