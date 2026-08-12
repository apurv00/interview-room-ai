'use client'

import { useEffect, useState, type FormEvent } from 'react'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'

const CAPABILITY = /^[a-f0-9]{24}\.[a-f0-9]{64}$/i
const ACCEPT = '.pdf,.docx,.txt'
const MAX_FILE_SIZE = 5 * 1024 * 1024

interface ApplyBootstrap {
  jobTitle: string
  workspaceName: string
}

export default function ApplyClient() {
  const [capability, setCapability] = useState<string | null>(null)
  const [bootstrap, setBootstrap] = useState<ApplyBootstrap | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1))
    const raw = fragment.get('apply')?.trim() ?? ''

    // The page request never contains the fragment; remove it from history
    // before the first client fetch as defense in depth.
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    )
    if (!CAPABILITY.test(raw)) {
      setInvalid(true)
      return
    }
    setCapability(raw)

    let cancelled = false
    void fetch('/api/apply/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability: raw }),
      cache: 'no-store',
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as Partial<ApplyBootstrap>
        if (cancelled) return
        if (!response.ok || !payload.jobTitle || !payload.workspaceName) {
          setInvalid(true)
          return
        }
        setBootstrap({
          jobTitle: payload.jobTitle,
          workspaceName: payload.workspaceName,
        })
      })
      .catch(() => {
        if (!cancelled) setInvalid(true)
      })

    return () => {
      cancelled = true
    }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (!file || !capability) {
      setError('Please attach your résumé.')
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      setError('That file is larger than 5MB — please attach a smaller one.')
      return
    }
    setBusy(true)
    try {
      const form = new FormData()
      form.append('name', name.trim())
      form.append('email', email.trim())
      if (phone.trim()) form.append('phone', phone.trim())
      form.append('file', file)
      const response = await fetch('/api/apply', {
        method: 'POST',
        headers: { 'x-hire-apply-capability': capability },
        body: form,
      })
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        setError(payload.error || 'We could not submit your application. Please try again.')
        return
      }
      setDone(true)
    } catch {
      setError('We could not reach the server. Please check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!invalid && !bootstrap) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
        <p className="text-sm text-[#536471]" role="status">
          Opening the application form…
        </p>
      </main>
    )
  }

  if (invalid || !bootstrap || !capability) {
    return <InactiveApplyLink />
  }

  return (
    <main className="min-h-screen bg-[#f8fafc] px-4 py-10">
      <div className="mx-auto max-w-lg space-y-6">
        <header className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-wide text-[#71767b]">
            {bootstrap.workspaceName}
          </p>
          <h1 className="text-xl font-bold text-[#0f1419]">{bootstrap.jobTitle}</h1>
          <p className="text-sm text-[#536471]">
            Apply with your résumé — it takes a minute.
          </p>
        </header>

        {done ? (
          <div className="space-y-3 rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
            <div className="text-4xl">🎉</div>
            <h2 className="text-lg font-bold text-[#0f1419]">Application received</h2>
            <p className="text-sm leading-relaxed text-[#536471]">
              Thanks! The hiring team has your details and will be in touch about next
              steps. You can close this tab.
            </p>
          </div>
        ) : (
          <form
            onSubmit={submit}
            className="space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-6"
          >
            <Input
              label="Full name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={120}
            />
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              maxLength={254}
            />
            <Input
              label="Phone (optional)"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              maxLength={32}
            />
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-[#0f1419]">Résumé</label>
              <label className="block cursor-pointer rounded-2xl border-2 border-dashed border-[#e1e8ed] p-5 text-center transition-colors hover:border-[#2563eb]/40">
                <input
                  type="file"
                  accept={ACCEPT}
                  className="hidden"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
                <span className="text-sm text-[#536471]">
                  {file ? file.name : 'PDF, DOCX or TXT — up to 5MB'}
                </span>
              </label>
            </div>
            {error ? (
              <p className="text-sm text-[#f4212e]" role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={busy || !name.trim() || !email.trim() || !file}>
              {busy ? 'Submitting…' : 'Submit application'}
            </Button>
          </form>
        )}

        <p className="text-center text-xs leading-relaxed text-[#71767b]">
          By applying you agree that your name, contact details and résumé are shared
          with {bootstrap.workspaceName} for this role, and may be reviewed with AI
          assistance. We keep that information while your application is active. After
          the job closes, it may remain in the company talent pool for up to 12 months
          from your last activity, then it is anonymized. If you complete an AI
          interview, recordings and identity photos are deleted 6 months after the job
          closes. A verified deletion request overrides both periods and deletes or
          anonymizes your personal data sooner. See our{' '}
          <a href="/privacy" className="text-[#2563eb]">
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </main>
  )
}

function InactiveApplyLink() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
      <div className="w-full max-w-md space-y-3 rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
        <div className="text-3xl">🔗</div>
        <h1 className="text-lg font-semibold text-[#0f1419]">
          This application link is no longer active
        </h1>
        <p className="text-sm text-[#536471]">
          The role may have closed or the link may have been replaced. Please contact
          the company for an up-to-date link.
        </p>
      </div>
    </main>
  )
}
