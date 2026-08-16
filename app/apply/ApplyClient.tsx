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
  companyDescription?: string | null
}

export default function ApplyClient() {
  const [capability, setCapability] = useState<string | null>(null)
  const [bootstrap, setBootstrap] = useState<ApplyBootstrap | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [queued, setQueued] = useState(false)

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
  }, [])

  useEffect(() => {
    if (!capability || invalid) return
    let cancelled = false
    setBootstrapError(null)
    void fetch('/api/apply/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability }),
      cache: 'no-store',
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as Partial<ApplyBootstrap>
        if (cancelled) return
        if (!response.ok) {
          // A capability failure is deliberately indistinguishable from a
          // closed/rotated link. Temporary route or rate-limit failures are
          // not: candidates must be able to retry instead of losing access.
          if (response.status === 400 || response.status === 404) {
            setInvalid(true)
          } else {
            setBootstrapError('We could not open the application form. Please try again.')
          }
          return
        }
        if (
          !payload.jobTitle ||
          !payload.workspaceName ||
          (payload.companyDescription !== undefined &&
            payload.companyDescription !== null &&
            typeof payload.companyDescription !== 'string')
        ) {
          setBootstrapError('We could not open the application form. Please try again.')
          return
        }
        if (cancelled) return
        setBootstrap({
          jobTitle: payload.jobTitle,
          workspaceName: payload.workspaceName,
          companyDescription: payload.companyDescription ?? null,
        })
      })
      .catch(() => {
        if (!cancelled) {
          setBootstrapError('We could not open the application form. Please try again.')
        }
      })

    return () => {
      cancelled = true
    }
  }, [bootstrapAttempt, capability, invalid])

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
      setQueued(true)
    } catch {
      setError('We could not reach the server. Please check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (invalid) {
    return <InactiveApplyLink />
  }

  if (bootstrapError && capability) {
    return (
      <ApplyBootstrapError
        onRetry={() => setBootstrapAttempt((attempt) => attempt + 1)}
      />
    )
  }

  if (!bootstrap || !capability) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
        <p className="text-sm text-[#536471]" role="status">
          Opening the application form…
        </p>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[#f8fafc] px-4 py-10">
      <div className="mx-auto max-w-lg space-y-6">
        <header className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-wide text-[#71767b]">
            {bootstrap.workspaceName}
          </p>
          <h1 className="text-xl font-bold text-[#0f1419]">{bootstrap.jobTitle}</h1>
          {bootstrap.companyDescription ? (
            <p className="mx-auto max-w-md pt-2 text-sm leading-6 text-[#536471]">
              {bootstrap.companyDescription}
            </p>
          ) : null}
          <p className="text-sm text-[#536471]">
            Apply with your résumé — it takes a minute.
          </p>
        </header>

        {queued ? (
          <div className="space-y-3 rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
            <div className="text-4xl">🎉</div>
            <h2 className="text-lg font-bold text-[#0f1419]">Application queued</h2>
            <p className="text-sm leading-relaxed text-[#536471]">
              Thanks! We have received your application and will process your résumé
              shortly. The hiring team will be in touch about next steps. You can close
              this tab.
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
              <input
                id="hire-apply-resume"
                type="file"
                accept={ACCEPT}
                aria-describedby="hire-apply-resume-help"
                className="sr-only"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              <label
                htmlFor="hire-apply-resume"
                className="block cursor-pointer"
              >
                <span className="block text-sm font-medium text-[#0f1419]">Résumé</span>
                <span className="mt-1.5 block rounded-2xl border-2 border-dashed border-[#e1e8ed] p-5 text-center text-sm text-[#536471] transition-colors hover:border-[#2563eb]/40">
                  {file ? file.name : 'Choose a PDF, DOCX or TXT file — up to 5MB'}
                </span>
              </label>
              <p id="hire-apply-resume-help" className="sr-only">
                Choose one résumé file in PDF, DOCX, or TXT format, up to 5MB.
              </p>
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

function ApplyBootstrapError({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
        <div role="alert">
          <h1 className="text-lg font-semibold text-[#0f1419]">
            We could not open the application form
          </h1>
          <p className="mt-2 text-sm text-[#536471]">
            The application link may still be valid. Check your connection and try again.
          </p>
        </div>
        <Button type="button" onClick={onRetry}>Try again</Button>
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
