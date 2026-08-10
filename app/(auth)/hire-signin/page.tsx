'use client'

import Link from 'next/link'
import { useEffect, useState, type FormEvent } from 'react'

const WORKSPACE_STORAGE_KEY = 'ipg-hire-workspace-id'
const WORKSPACE_ID_PATTERN = /^[a-f0-9]{24}$/i
const SETUP_CREDENTIAL_PATTERN = /^([a-f0-9]{24})\.[a-f0-9]{64}$/i

function HireSignInForm() {
  const [ready, setReady] = useState(false)
  const [workspaceId, setWorkspaceId] = useState('')
  const [setupCredential, setSetupCredential] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const candidate = fragment.get('setup') ?? ''
    const match = SETUP_CREDENTIAL_PATTERN.exec(candidate)
    const workspaceFromQuery = new URLSearchParams(window.location.search).get('workspace') ?? ''
    const remembered = window.localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? ''

    if (match) {
      const credentialWorkspaceId = match[1].toLowerCase()
      setSetupCredential(candidate.toLowerCase())
      setWorkspaceId(credentialWorkspaceId)
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, credentialWorkspaceId)
    } else if (WORKSPACE_ID_PATTERN.test(workspaceFromQuery)) {
      setWorkspaceId(workspaceFromQuery.toLowerCase())
    } else if (WORKSPACE_ID_PATTERN.test(remembered)) {
      setWorkspaceId(remembered.toLowerCase())
    }
    if (candidate && !match) setError('This setup link is invalid or incomplete.')

    // Setup secrets must not remain in browser history, screenshots, copied
    // address bars, or later navigations. The workspace id is non-secret.
    if (window.location.hash) {
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${window.location.search}`,
      )
    }
    setReady(true)
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const setup = !!setupCredential
      const response = await fetch(
        setup ? '/api/hire-auth/setup' : '/api/hire-auth/signin',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            setup
              ? { credential: setupCredential, password, confirmPassword }
              : { workspaceId: workspaceId.trim(), email: email.trim(), password }
          ),
        }
      )
      const data = (await response.json().catch(() => ({}))) as {
        error?: string
        details?: Array<{ message?: string }>
      }
      if (!response.ok) {
        setError(data.details?.[0]?.message || data.error || 'Could not sign in.')
        return
      }
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, workspaceId.toLowerCase())
      window.location.assign('/workspace')
    } catch {
      setError('Could not reach the service. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!ready) return <HireSignInFallback />

  const setup = !!setupCredential

  return (
    <main className="min-h-screen bg-[#f8fafc] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <Link href="/" className="text-xl font-bold text-[#0f1419]">
            IPG Hire
          </Link>
          <p className="mt-1 text-sm text-[#536471]">
            {setup
              ? 'Set your password to enter the hiring workspace.'
              : 'Sign in to your hiring workspace.'}
          </p>
        </div>

        <form
          onSubmit={submit}
          className="space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-6 shadow-sm"
        >
          {setup ? (
            <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-[#536471]">
              Workspace sign-in ID
              <span className="mt-0.5 block break-all font-mono text-xs text-[#0f1419]">
                {workspaceId}
              </span>
            </div>
          ) : (
            <label className="block space-y-1.5 text-sm font-medium text-[#0f1419]">
              Workspace sign-in ID
              <input
                type="text"
                inputMode="text"
                autoComplete="organization"
                minLength={24}
                maxLength={24}
                pattern="[A-Fa-f0-9]{24}"
                required
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value.trim())}
                className="w-full rounded-xl border border-[#cfd9de] px-3 py-2.5 font-mono text-sm font-normal outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              />
              <span className="block text-xs font-normal text-[#71767b]">
                Included in your first-password email.
              </span>
            </label>
          )}
          {!setup && (
            <label className="block space-y-1.5 text-sm font-medium text-[#0f1419]">
              Work email
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded-xl border border-[#cfd9de] px-3 py-2.5 font-normal outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              />
            </label>
          )}
          <label className="block space-y-1.5 text-sm font-medium text-[#0f1419]">
            Password
            <input
              type="password"
              autoComplete={setup ? 'new-password' : 'current-password'}
              minLength={setup ? 12 : 1}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-xl border border-[#cfd9de] px-3 py-2.5 font-normal outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
          </label>
          {setup && (
            <>
              <p className="text-xs leading-relaxed text-[#536471]">
                Use at least 12 characters with uppercase, lowercase, and a number.
              </p>
              <label className="block space-y-1.5 text-sm font-medium text-[#0f1419]">
                Confirm password
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  className="w-full rounded-xl border border-[#cfd9de] px-3 py-2.5 font-normal outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                />
              </label>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || (setup ? password !== confirmPassword : false)}
            className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {busy ? 'Please wait…' : setup ? 'Set password and sign in' : 'Sign in'}
          </button>
        </form>

        {!setup && (
          <p className="mt-4 text-center text-xs text-[#71767b]">
            Workspace creator?{' '}
            <Link
              href="/api/hire-auth/b2c-signin"
              className="font-medium text-indigo-600 hover:underline"
            >
              Continue with your IPG account
            </Link>
          </p>
        )}
      </div>
    </main>
  )
}

function HireSignInFallback() {
  return (
    <main className="min-h-screen bg-[#f8fafc] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md text-center">
        <p className="text-xl font-bold text-[#0f1419]">IPG Hire</p>
        <div className="mt-6 rounded-2xl border border-[#e1e8ed] bg-white p-6 shadow-sm">
          <p role="status" aria-live="polite" className="text-sm text-[#536471]">
            Loading secure sign-in…
          </p>
        </div>
      </div>
    </main>
  )
}

export default function HireSignInPage() {
  return <HireSignInForm />
}
