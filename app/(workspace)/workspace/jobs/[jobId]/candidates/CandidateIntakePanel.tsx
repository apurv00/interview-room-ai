'use client'

import { useRef, useState, type FormEvent } from 'react'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'

interface CandidateIntakePanelProps {
  jobId: string
  onAdded: () => void
  onClose: () => void
}

function operationId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `candidate-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function responseError(value: unknown, fallback: string): string {
  if (value && typeof value === 'object' && typeof (value as { error?: unknown }).error === 'string') {
    return (value as { error: string }).error
  }
  return fallback
}

export default function CandidateIntakePanel({
  jobId,
  onAdded,
  onClose,
}: CandidateIntakePanelProps) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const currentOperationId = operationRef.current ?? operationId()
    operationRef.current = currentOperationId
    try {
      const response = await fetch(`/api/workspace/jobs/${encodeURIComponent(jobId)}/candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          operationId: currentOperationId,
        }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        setError(responseError(data, 'Could not add this candidate.'))
        return
      }
      operationRef.current = null
      setName('')
      setEmail('')
      onAdded()
    } catch {
      setError('Network error. No confirmation was received; retrying is safe.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-labelledby="quick-add-candidate-title"
      className="rounded-2xl border border-[#dbe4ea] bg-white p-5 shadow-sm"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="quick-add-candidate-title" className="text-base font-semibold text-[#0f1419]">
            Add one candidate
          </h2>
          <p className="mt-1 text-sm text-[#536471]">
            Quick add creates an unscored application. Import a résumé when you want JD matching.
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <form className="mt-4 grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end" onSubmit={submit}>
        <Input
          id="candidate-name"
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={120}
          autoComplete="name"
        />
        <Input
          id="candidate-email"
          label="Email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          maxLength={254}
          autoComplete="email"
        />
        <Button type="submit" disabled={busy || !name.trim() || !email.trim()}>
          {busy ? 'Adding…' : 'Add candidate'}
        </Button>
      </form>
      {error ? <p role="alert" className="mt-3 text-sm text-[#c2410c]">{error}</p> : null}
    </section>
  )
}
