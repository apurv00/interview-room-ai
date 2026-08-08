'use client'

/**
 * HR team management. Flat permissions: one admin (the creator), identical
 * members. Admin adds people by name + email — no invite flow; the row links
 * to their account on first sign-in. The server enforces admin-only for
 * add/remove; this UI just hides the controls for non-admins.
 */

import { useCallback, useEffect, useState } from 'react'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'
import StateView from '@shared/ui/StateView'

interface MemberRow {
  id: string
  email: string
  name: string | null
  role: 'admin' | 'member'
  linked: boolean
  addedAt: string
}

export default function MembersPage() {
  const [members, setMembers] = useState<MemberRow[] | null>(null)
  const [myRole, setMyRole] = useState<'admin' | 'member' | null>(null)
  const [guestAuthMode, setGuestAuthMode] = useState<'magic_link' | 'otp'>('magic_link')
  const [savingMode, setSavingMode] = useState(false)
  const [modeNotice, setModeNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [membersRes, wsRes] = await Promise.all([
        fetch('/api/workspace/members'),
        fetch('/api/workspace'),
      ])
      const membersData = await membersRes.json()
      const wsData = await wsRes.json()
      if (!membersRes.ok) throw new Error(membersData.error)
      setMembers(membersData.members)
      setMyRole(wsData.membership?.role ?? null)
      if (wsData.workspace?.guestAuthMode) setGuestAuthMode(wsData.workspace.guestAuthMode)
    } catch {
      setError('Could not load your team.')
    }
  }, [])

  async function saveMode(mode: 'magic_link' | 'otp') {
    setSavingMode(true)
    setModeNotice(null)
    const previous = guestAuthMode
    setGuestAuthMode(mode)
    try {
      const res = await fetch('/api/workspace', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestAuthMode: mode }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setGuestAuthMode(previous)
        setModeNotice(data.error || 'Could not save the setting.')
        return
      }
      setModeNotice('Saved — applies to invites sent from now on.')
    } catch {
      setGuestAuthMode(previous)
      setModeNotice('Could not save the setting. Check your connection.')
    } finally {
      setSavingMode(false)
    }
  }

  useEffect(() => {
    void load()
  }, [load])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setFormError(null)
    try {
      const res = await fetch('/api/workspace/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          ...(name.trim() ? { name: name.trim() } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFormError(data.error || 'Could not add the member.')
        return
      }
      setName('')
      setEmail('')
      await load()
    } catch {
      setFormError('Could not add the member. Check your connection.')
    } finally {
      setSaving(false)
    }
  }

  async function remove(memberId: string) {
    try {
      const res = await fetch(`/api/workspace/members/${memberId}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'Could not remove the member.')
        return
      }
      await load()
    } catch {
      setError('Could not remove the member.')
    }
  }

  if (error) return <StateView state="error" error={error} onRetry={load} />
  if (members === null) return <StateView state="loading" skeletonLayout="list" />

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-[#0f1419]">Team</h1>
        <p className="text-sm text-[#536471]">
          Your HR team. Hiring managers and interviewers don&apos;t need accounts —
          they get guest links per candidate (coming in the next phase).
        </p>
      </div>

      {myRole === 'admin' && (
        <div className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-3">
          <p className="text-sm font-medium text-[#0f1419]">
            Candidate verification on interview links
          </p>
          <p className="text-xs text-[#71767b]">
            Applies to invites sent from now on — links already in candidates&apos;
            inboxes keep the mode they were sent with.
          </p>
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="ws-guest-auth"
              checked={guestAuthMode === 'magic_link'}
              onChange={() => void saveMode('magic_link')}
              disabled={savingMode}
              className="mt-0.5"
            />
            <span>
              <strong>Magic link</strong> — the emailed link takes candidates straight
              to the consent screen and interview.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="ws-guest-auth"
              checked={guestAuthMode === 'otp'}
              onChange={() => void saveMode('otp')}
              disabled={savingMode}
              className="mt-0.5"
            />
            <span>
              <strong>Email code</strong> — candidates additionally confirm a 6-digit
              code emailed to them before starting.
            </span>
          </label>
          {modeNotice && (
            <p className={`text-xs ${modeNotice.startsWith('Saved') ? 'text-emerald-600' : 'text-[#f4212e]'}`}>
              {modeNotice}
            </p>
          )}
        </div>
      )}

      {myRole === 'admin' && (
        <form onSubmit={add} className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-4">
          <p className="text-sm font-medium text-[#0f1419]">Add a team member</p>
          <div className="grid md:grid-cols-2 gap-4">
            <Input label="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            <Input label="Work email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} />
          </div>
          <p className="text-xs text-[#71767b]">
            They sign in with Google or GitHub using this email — their account links
            to the workspace automatically on first sign-in.
          </p>
          {formError && <p className="text-xs text-[#f4212e]">{formError}</p>}
          <Button type="submit" disabled={saving || !email.trim()}>
            {saving ? 'Adding…' : 'Add member'}
          </Button>
        </form>
      )}

      <div className="space-y-2">
        {members.map((m) => (
          <div key={m.id} className="bg-white border border-[#e1e8ed] rounded-2xl p-4 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-[#0f1419] truncate">{m.name || m.email}</p>
              <p className="text-xs text-[#71767b] truncate">{m.email}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {m.role === 'admin' && <Badge variant="primary">admin</Badge>}
              <Badge variant={m.linked ? 'success' : 'default'}>
                {m.linked ? 'active' : 'not signed in yet'}
              </Badge>
              {myRole === 'admin' && m.role !== 'admin' && (
                <Button size="sm" variant="secondary" onClick={() => void remove(m.id)}>
                  Remove
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
