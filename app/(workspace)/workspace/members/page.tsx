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
  authState: 'pending' | 'active' | 'removed'
  passwordSet: boolean
  addedAt: string
}

interface WorkspaceView {
  id: string
  name: string
  guestAuthMode: 'magic_link' | 'otp'
  lifecycleState: 'active' | 'deletion_pending'
  deletedAt: string | null
  purgeAfter: string | null
  deletedByName: string | null
}

interface CurrentMembership {
  id: string
  email: string
  role: 'admin' | 'member'
  directAccount: boolean
}

interface TransferIntent {
  member: MemberRow
  operationId: string
}

function formatLongDate(value: string | null): string {
  if (!value) return 'the end of the recovery period'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(value))
}

export default function MembersPage() {
  const [members, setMembers] = useState<MemberRow[] | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null)
  const [myRole, setMyRole] = useState<'admin' | 'member' | null>(null)
  const [myMembership, setMyMembership] = useState<CurrentMembership | null>(null)
  const [guestAuthMode, setGuestAuthMode] = useState<'magic_link' | 'otp'>('magic_link')
  const [savingMode, setSavingMode] = useState(false)
  const [modeNotice, setModeNotice] = useState<string | null>(null)
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
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false)
  const [deleteOperationId, setDeleteOperationId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [restoreOperationId, setRestoreOperationId] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [selfDeleteOpen, setSelfDeleteOpen] = useState(false)
  const [selfDeleteEmail, setSelfDeleteEmail] = useState('')
  const [selfDeleteWorkspaceName, setSelfDeleteWorkspaceName] = useState('')
  const [selfDeleteWorkspaceAcknowledged, setSelfDeleteWorkspaceAcknowledged] = useState(false)
  const [selfDeleteOperationId, setSelfDeleteOperationId] = useState<string | null>(null)
  const [selfDeleting, setSelfDeleting] = useState(false)
  const [selfDeleteError, setSelfDeleteError] = useState<string | null>(null)

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
      setMyMembership(wsData.membership ?? null)
      if (wsData.workspace?.guestAuthMode) setGuestAuthMode(wsData.workspace.guestAuthMode)
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

  async function deleteWorkspace() {
    if (!workspace) return
    const operationId = deleteOperationId ?? crypto.randomUUID()
    setDeleteOperationId(operationId)
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch('/api/workspace/lifecycle/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmationName: deleteConfirmation,
          acknowledgePermanentPurge: deleteAcknowledged,
          operationId,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setDeleteError(data.error || 'Could not schedule workspace deletion.')
        return
      }
      setWorkspace(data.workspace)
      setMembers([])
      setDeleteConfirmation('')
      setDeleteAcknowledged(false)
    } catch {
      setDeleteError('Could not schedule workspace deletion. Check your connection.')
    } finally {
      setDeleting(false)
    }
  }

  async function restoreWorkspace() {
    const operationId = restoreOperationId ?? crypto.randomUUID()
    setRestoreOperationId(operationId)
    setRestoring(true)
    setRestoreError(null)
    try {
      const res = await fetch('/api/workspace/lifecycle/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setRestoreError(data.error || 'Could not restore the workspace.')
        return
      }
      setWorkspace(data.workspace)
      setRestoreOperationId(null)
      await load()
    } catch {
      setRestoreError('Could not restore the workspace. Check your connection.')
    } finally {
      setRestoring(false)
    }
  }

  async function deleteMyHireAccount() {
    if (!workspace || !myMembership) return
    const operationId = selfDeleteOperationId ?? crypto.randomUUID()
    setSelfDeleteOperationId(operationId)
    setSelfDeleting(true)
    setSelfDeleteError(null)
    try {
      const res = await fetch('/api/hire-auth/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId,
          ...(myMembership.role === 'admin'
            ? {
                workspaceConfirmationName: selfDeleteWorkspaceName,
                acknowledgeWorkspaceDeletion: selfDeleteWorkspaceAcknowledged,
              }
            : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setSelfDeleteError(data.error || 'Could not delete your Hire account.')
        return
      }
      window.location.href = '/hire-signin?account_deleted=1'
    } catch {
      setSelfDeleteError('Could not delete your Hire account. Check your connection.')
    } finally {
      setSelfDeleting(false)
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
          <h1 className="text-xl font-bold text-[#0f1419]">Workspace scheduled for deletion</h1>
          <p className="mt-2 text-sm text-[#536471]">
            {workspace.name} is locked. Team access and new hiring writes are blocked,
            and public apply links plus active guest sessions were revoked immediately.
          </p>
        </div>
        <div className="space-y-4 rounded-2xl border border-amber-300 bg-amber-50 p-6">
          <p className="text-sm text-amber-950">
            The workspace data remains recoverable through{' '}
            <strong>{formatLongDate(workspace.purgeAfter)}</strong>. After that date,
            jobs, candidates, and media are eligible for permanent purge.
          </p>
          {workspace.deletedByName && (
            <p className="text-xs text-amber-900">
              Scheduled by {workspace.deletedByName}.
            </p>
          )}
          {myRole === 'admin' ? (
            <Button onClick={() => void restoreWorkspace()} disabled={restoring}>
              {restoring ? 'Restoring…' : 'Restore workspace'}
            </Button>
          ) : (
            <p className="text-sm text-amber-950">
              Ask the workspace administrator to restore access before the recovery period ends.
            </p>
          )}
          {restoreError && (
            <p className="text-sm text-[#f4212e]" role="alert">
              {restoreError}
            </p>
          )}
        </div>
      </div>
    )
  }

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
            <p
              className={`text-xs ${modeNotice.startsWith('Saved') ? 'text-emerald-600' : 'text-[#f4212e]'}`}
              aria-live="polite"
            >
              {modeNotice}
            </p>
          )}
        </div>
      )}

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
        {members.map((m) => (
          <div key={m.id} className="bg-white border border-[#e1e8ed] rounded-2xl p-4 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-[#0f1419] truncate">{m.name || m.email}</p>
              <p className="text-xs text-[#71767b] truncate">{m.email}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {m.role === 'admin' && <Badge variant="primary">admin</Badge>}
              <Badge variant={m.authState === 'active' && (m.passwordSet || m.linked) ? 'success' : 'default'}>
                {m.authState === 'active' && (m.passwordSet || m.linked)
                  ? 'active'
                  : 'password setup pending'}
              </Badge>
              {myRole === 'admin' && m.role !== 'admin' && (
                <div className="flex items-center gap-2">
                  {m.authState === 'pending' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={setupRecoveryBusyId !== null}
                      onClick={() => void regenerateSetup(m)}
                    >
                      {setupRecoveryBusyId === m.id ? 'Regenerating…' : 'Regenerate setup link'}
                    </Button>
                  )}
                  {m.authState === 'active' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setTransferError(null)
                        setTransferIntent({ member: m, operationId: crypto.randomUUID() })
                      }}
                    >
                      Make admin
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" onClick={() => void remove(m.id)}>
                    Remove
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}
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

      {myRole === 'admin' && (
        <section
          className="space-y-4 rounded-2xl border border-red-200 bg-white p-6"
          aria-labelledby="delete-workspace-title"
        >
          <div>
            <h2 id="delete-workspace-title" className="font-semibold text-[#0f1419]">
              Delete workspace
            </h2>
            <p className="mt-2 text-sm text-[#536471]">
              Access and public apply links stop immediately. Data is retained for
              a 30-day recovery period and is then eligible for permanent purge.
            </p>
            <a
              href="/api/workspace/export/candidates"
              className="mt-3 inline-flex text-sm font-medium text-[#1d9bf0] hover:underline"
              download
            >
              Download candidates and statuses (CSV) before deleting
            </a>
          </div>
          <div className="max-w-xl space-y-3">
            <Input
              label={`Type “${workspace.name}” to confirm`}
              value={deleteConfirmation}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              autoComplete="off"
            />
            <label className="flex items-start gap-2 text-sm text-[#0f1419]">
              <input
                type="checkbox"
                checked={deleteAcknowledged}
                onChange={(event) => setDeleteAcknowledged(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                I understand that the workspace and all hiring data can be permanently
                purged after the 30-day recovery period.
              </span>
            </label>
          </div>
          {deleteError && (
            <p className="text-sm text-[#f4212e]" role="alert">
              {deleteError}
            </p>
          )}
          <Button
            variant="danger"
            onClick={() => void deleteWorkspace()}
            disabled={
              deleting ||
              deleteConfirmation !== workspace.name ||
              !deleteAcknowledged
            }
          >
            {deleting ? 'Scheduling deletion…' : 'Delete workspace'}
          </Button>
        </section>
      )}

      {myMembership?.directAccount && (
        <section
          className="space-y-4 rounded-2xl border border-red-200 bg-white p-6"
          aria-labelledby="delete-hire-account-title"
        >
          <div>
            <h2 id="delete-hire-account-title" className="font-semibold text-[#0f1419]">
              Delete my Hire account
            </h2>
            <p className="mt-2 text-sm text-[#536471]">
              Your access and active sessions end immediately. Hiring decisions, notes,
              and scorecards remain with your name snapshot so the audit history stays true.
            </p>
          </div>

          {myMembership.role === 'admin' &&
          members.some((member) => member.id !== myMembership.id) ? (
            <p className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
              You are the workspace administrator. Transfer administrator access to an
              active member above before deleting your account.
            </p>
          ) : selfDeleteOpen ? (
            <div className="max-w-xl space-y-3">
              <Input
                label={`Type “${myMembership.email}” to confirm`}
                type="email"
                value={selfDeleteEmail}
                onChange={(event) => setSelfDeleteEmail(event.target.value)}
                autoComplete="off"
              />
              {myMembership.role === 'admin' && (
                <>
                  <p className="text-sm text-[#536471]">
                    As the sole administrator, deleting your account also schedules this
                    workspace for deletion. It is recoverable for 30 days; jobs,
                    candidates, and media are purged after that period.
                  </p>
                  <Input
                    label={`Type “${workspace.name}” to schedule workspace deletion`}
                    value={selfDeleteWorkspaceName}
                    onChange={(event) => setSelfDeleteWorkspaceName(event.target.value)}
                    autoComplete="off"
                  />
                  <label className="flex items-start gap-2 text-sm text-[#0f1419]">
                    <input
                      type="checkbox"
                      checked={selfDeleteWorkspaceAcknowledged}
                      onChange={(event) =>
                        setSelfDeleteWorkspaceAcknowledged(event.target.checked)
                      }
                      className="mt-0.5"
                    />
                    <span>
                      I understand the workspace enters a 30-day deletion period.
                    </span>
                  </label>
                </>
              )}
              {selfDeleteError && (
                <p className="text-sm text-[#f4212e]" role="alert">
                  {selfDeleteError}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  onClick={() => void deleteMyHireAccount()}
                  disabled={
                    selfDeleting ||
                    selfDeleteEmail.trim().toLowerCase() !==
                      myMembership.email.toLowerCase() ||
                    (myMembership.role === 'admin' &&
                      (selfDeleteWorkspaceName !== workspace.name ||
                        !selfDeleteWorkspaceAcknowledged))
                  }
                >
                  {selfDeleting ? 'Deleting…' : 'Delete my Hire account'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSelfDeleteOpen(false)
                    setSelfDeleteError(null)
                  }}
                  disabled={selfDeleting}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="danger"
              onClick={() => {
                setSelfDeleteOpen(true)
                setSelfDeleteEmail('')
                setSelfDeleteWorkspaceName('')
                setSelfDeleteWorkspaceAcknowledged(false)
                setSelfDeleteOperationId(null)
                setSelfDeleteError(null)
              }}
            >
              Delete my Hire account
            </Button>
          )}
        </section>
      )}
    </div>
  )
}
