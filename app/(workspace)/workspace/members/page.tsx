'use client'

/**
 * HR team management. Flat permissions: one admin (the creator), identical
 * members. Admin adds people by name + email — no invite flow; the row links
 * to their account on first sign-in. The server enforces admin-only for
 * add/remove; this UI just hides the controls for non-admins.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
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
  authState: 'pending' | 'active' | 'removed'
  passwordSet: boolean
  addedAt: string
}

interface WorkspaceView {
  lifecycleState: 'active' | 'deletion_pending'
}

interface TransferIntent {
  member: MemberRow
  operationId: string
}

export default function MembersPage() {
  const [members, setMembers] = useState<MemberRow[] | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null)
  const [myRole, setMyRole] = useState<'admin' | 'member' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [setupNotice, setSetupNotice] = useState<{
    url: string
    emailSent: boolean
  } | null>(null)
  const [setupRecoveryNotice, setSetupRecoveryNotice] = useState<{
    memberName: string
    url: string
    emailSent: boolean
  } | null>(null)
  const [setupRecoveryBusyId, setSetupRecoveryBusyId] = useState<string | null>(null)
  const [setupRecoveryError, setSetupRecoveryError] = useState<string | null>(null)
  const [transferIntent, setTransferIntent] = useState<TransferIntent | null>(null)
  const [transferBusy, setTransferBusy] = useState(false)
  const [transferError, setTransferError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [membersRes, wsRes] = await Promise.all([
        fetch('/api/workspace/members'),
        fetch('/api/workspace'),
      ])
      const [membersData, wsData] = await Promise.all([
        membersRes.json().catch(() => ({})),
        wsRes.json().catch(() => ({})),
      ])
      if (!wsRes.ok || !wsData.workspace) throw new Error(wsData.error)
      setWorkspace(wsData.workspace)
      setMyRole(wsData.membership?.role ?? null)
      if (wsData.workspace.lifecycleState === 'deletion_pending') {
        // Every normal member-data endpoint is intentionally 410 after the
        // tombstone. The lifecycle GET remains readable solely for recovery.
        setMembers([])
        return
      }
      if (!membersRes.ok) throw new Error(membersData.error)
      setMembers(membersData.members)
    } catch {
      setError('Could not load your team.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setFormError(null)
    setSetupNotice(null)
    try {
      const res = await fetch('/api/workspace/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          name: name.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFormError(data.error || 'Could not add the member.')
        return
      }
      setName('')
      setEmail('')
      setSetupNotice({
        url: data.credentialSetup.url,
        emailSent: data.credentialSetup.emailSent,
      })
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

  async function regenerateSetup(member: MemberRow) {
    setSetupRecoveryBusyId(member.id)
    setSetupRecoveryError(null)
    setSetupRecoveryNotice(null)
    try {
      const res = await fetch(`/api/workspace/members/${member.id}/setup`, {
        method: 'POST',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.credentialSetup?.url) {
        setSetupRecoveryError(data.error || 'Could not regenerate the setup link.')
        return
      }
      setSetupRecoveryNotice({
        memberName: member.name || member.email,
        url: data.credentialSetup.url,
        emailSent: data.credentialSetup.emailSent === true,
      })
    } catch {
      setSetupRecoveryError('Could not regenerate the setup link. Check your connection.')
    } finally {
      setSetupRecoveryBusyId(null)
    }
  }

  async function transferAdmin() {
    if (!transferIntent) return
    setTransferBusy(true)
    setTransferError(null)
    try {
      const res = await fetch(
        `/api/workspace/members/${transferIntent.member.id}/transfer-admin`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operationId: transferIntent.operationId }),
        },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setTransferError(data.error || 'Could not transfer administrator access.')
        return
      }
      // The server returns the caller's freshly-demoted membership. Every
      // API request also re-reads that Hire-owned role, so authority changes
      // immediately without signing either person out.
      setMyRole(data.membership?.role ?? 'member')
      setTransferIntent(null)
      await load()
    } catch {
      setTransferError('Could not transfer administrator access. Check your connection.')
    } finally {
      setTransferBusy(false)
    }
  }

  if (error) return <StateView state="error" error={error} onRetry={load} />
  if (members === null || workspace === null) {
    return <StateView state="loading" skeletonLayout="list" />
  }

  if (workspace.lifecycleState === 'deletion_pending') {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="text-xl font-bold text-[#0f1419]">Team access is locked</h1>
          <p className="mt-2 text-sm text-[#536471]">
            This workspace is scheduled for deletion, so member changes are unavailable.
          </p>
        </div>
        <Link
          href="/workspace/settings#data-privacy"
          className="inline-flex rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          Review deletion status
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#0f1419]">Team</h1>
          <p className="text-sm text-[#536471]">
            Your HR team. Hiring managers and interviewers don&apos;t need accounts —
            they use secure, candidate-scoped interview kits and share packets.
          </p>
        </div>
        <Link
          href="/workspace/settings"
          className="text-sm font-medium text-indigo-700 hover:underline"
        >
          Workspace settings
        </Link>
      </div>

      {myRole === 'admin' && (
        <form onSubmit={add} className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-4">
          <p className="text-sm font-medium text-[#0f1419]">Add a team member</p>
          <div className="grid md:grid-cols-2 gap-4">
            <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
            <Input label="Work email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} />
          </div>
          <p className="text-xs text-[#71767b]">
            Membership is provisioned immediately. They receive a one-time credential
            link and set their password on first sign-in; there is no acceptance step.
          </p>
          {setupNotice && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
              <p>
                Member added.{' '}
                {setupNotice.emailSent
                  ? 'The password setup email was sent.'
                  : 'Email delivery failed — share the setup link manually.'}
              </p>
              <button
                type="button"
                className="mt-2 font-semibold text-emerald-800 underline"
                onClick={() => void navigator.clipboard.writeText(setupNotice.url)}
              >
                Copy password setup link
              </button>
            </div>
          )}
          {formError && (
            <p className="text-xs text-[#f4212e]" role="alert">
              {formError}
            </p>
          )}
          <Button type="submit" disabled={saving || !email.trim() || !name.trim()}>
            {saving ? 'Adding…' : 'Add member'}
          </Button>
        </form>
      )}

      <div className="space-y-2">
        {setupRecoveryNotice && (
          <div
            className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900"
            aria-live="polite"
          >
            <p>
              New setup link created for {setupRecoveryNotice.memberName}.{' '}
              {setupRecoveryNotice.emailSent
                ? 'The password setup email was sent.'
                : 'Email delivery failed — share the new link manually.'}
            </p>
            <button
              type="button"
              className="mt-2 font-semibold text-emerald-800 underline"
              onClick={() => void navigator.clipboard.writeText(setupRecoveryNotice.url)}
            >
              Copy new password setup link
            </button>
          </div>
        )}
        {setupRecoveryError && (
          <p className="text-sm text-[#f4212e]" role="alert">
            {setupRecoveryError}
          </p>
        )}
        <ul className="space-y-2" aria-label="Workspace members">
          {members.map((m) => (
            <li
              key={m.id}
              className="flex flex-col gap-3 rounded-2xl border border-[#e1e8ed] bg-white p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-[#0f1419]">
                  {m.name || m.email}
                </p>
                <p className="truncate text-xs text-[#71767b]">{m.email}</p>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
                {m.role === 'admin' && <Badge variant="primary">admin</Badge>}
                <Badge
                  variant={
                    m.authState === 'active' && (m.passwordSet || m.linked)
                      ? 'success'
                      : 'default'
                  }
                >
                  {m.authState === 'active' && (m.passwordSet || m.linked)
                    ? 'active'
                    : 'password setup pending'}
                </Badge>
                {myRole === 'admin' && m.role !== 'admin' && (
                  <div className="flex flex-wrap items-center gap-2">
                    {m.authState === 'pending' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={setupRecoveryBusyId !== null}
                        onClick={() => void regenerateSetup(m)}
                      >
                        {setupRecoveryBusyId === m.id
                          ? 'Regenerating…'
                          : 'Regenerate setup link'}
                      </Button>
                    )}
                    {m.authState === 'active' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setTransferError(null)
                          setTransferIntent({
                            member: m,
                            operationId: crypto.randomUUID(),
                          })
                        }}
                      >
                        Make admin
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void remove(m.id)}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {myRole === 'admin' && transferIntent && (
        <section
          className="space-y-4 rounded-2xl border border-amber-300 bg-amber-50 p-6"
          aria-labelledby="transfer-admin-title"
        >
          <div>
            <h2 id="transfer-admin-title" className="font-semibold text-amber-950">
              Transfer administrator access?
            </h2>
            <p className="mt-2 text-sm text-amber-950">
              <strong>{transferIntent.member.name || transferIntent.member.email}</strong>{' '}
              will become the workspace&apos;s only administrator. Your role changes to
              member immediately, and only the new administrator can transfer it back.
            </p>
          </div>
          {transferError && (
            <p className="text-sm text-[#f4212e]" role="alert">
              {transferError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void transferAdmin()} disabled={transferBusy}>
              {transferBusy ? 'Transferring…' : 'Transfer administrator'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setTransferIntent(null)
                setTransferError(null)
              }}
              disabled={transferBusy}
            >
              Cancel
            </Button>
          </div>
        </section>
      )}
    </div>
  )
}
