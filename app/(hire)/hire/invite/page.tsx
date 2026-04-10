'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { CheckCircle, Copy } from 'lucide-react'
import DomainSelector from '@interview/components/DomainSelector'
import DepthSelector from '@interview/components/DepthSelector'
import Input from '@shared/ui/Input'
import Button from '@shared/ui/Button'
import Badge from '@shared/ui/Badge'
import SelectionGroup from '@shared/ui/SelectionGroup'

const EXPERIENCE_OPTIONS = [
  { key: '0-2', label: '0-2 yrs' },
  { key: '3-6', label: '3-6 yrs' },
  { key: '7+', label: '7+ yrs' },
]

const DURATION_OPTIONS = [
  { key: '10', label: '10 min' },
  { key: '20', label: '20 min' },
  { key: '30', label: '30 min' },
]

export default function InvitePage() {
  const router = useRouter()
  const { status: authStatus } = useSession()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<string | null>(null)
  const [interviewType, setInterviewType] = useState<string | null>(null)
  const [experience, setExperience] = useState<string>('3-6')
  const [duration, setDuration] = useState<string>('20')
  const [notes, setNotes] = useState('')
  const [jdText, setJdText] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ inviteLink: string; candidateEmail: string } | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  // Bulk invite state
  const [bulkMode, setBulkMode] = useState(false)
  const [bulkEmails, setBulkEmails] = useState('')
  const [bulkResults, setBulkResults] = useState<Array<{ email: string; success: boolean; link?: string; error?: string }>>([])
  const [bulkSending, setBulkSending] = useState(false)

  useEffect(() => {
    if (authStatus === 'unauthenticated') router.push('/signin')
  }, [authStatus, router])

  async function handleSend() {
    if (!email || !role) {
      setError('Email and role are required')
      return
    }
    setError('')
    setSending(true)
    try {
      const res = await fetch('/api/hire/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateEmail: email,
          candidateName: name || undefined,
          role,
          interviewType: interviewType || 'screening',
          experience,
          duration: Number(duration),
          recruiterNotes: notes || undefined,
          jobDescription: jdText || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to send invite')
      } else {
        setResult(data)
      }
    } catch {
      setError('Network error')
    }
    setSending(false)
  }

  async function handleBulkSend() {
    if (!role) { setError('Select a role first'); return }
    const emails = bulkEmails.split(/[\n,;]+/).map(e => e.trim()).filter(e => e.includes('@'))
    if (emails.length === 0) { setError('No valid emails found'); return }

    setBulkSending(true)
    setError('')
    const results: typeof bulkResults = []

    for (const candidateEmail of emails) {
      try {
        const res = await fetch('/api/hire/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            candidateEmail,
            role,
            interviewType: interviewType || 'screening',
            experience,
            duration: Number(duration),
            jobDescription: jdText || undefined,
          }),
        })
        const data = await res.json()
        results.push({
          email: candidateEmail,
          success: res.ok,
          link: data.inviteLink,
          error: !res.ok ? data.error : undefined,
        })
      } catch {
        results.push({ email: candidateEmail, success: false, error: 'Network error' })
      }
    }

    setBulkResults(results)
    setBulkSending(false)
  }

  function copyLink(link: string) {
    navigator.clipboard.writeText(link)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-heading text-[var(--foreground)]">Invite Candidates</h1>
        <button
          onClick={() => { setBulkMode(!bulkMode); setResult(null); setBulkResults([]) }}
          className="text-caption text-[var(--ds-primary)] hover:underline transition-colors"
        >
          {bulkMode ? 'Single Invite' : 'Bulk Invite'}
        </button>
      </div>

      {result ? (
        <div className="surface-card-bordered p-6 space-y-4 border-l-4 border-l-emerald-500">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-emerald-50 flex items-center justify-center">
              <CheckCircle className="w-5 h-5 text-emerald-600" />
            </div>
            <div>
              <p className="text-subheading text-emerald-700">Invite Sent!</p>
              <p className="text-caption text-[var(--foreground-tertiary)]">Sent to {result.candidateEmail}</p>
            </div>
          </div>

          <div>
            <p className="step-label">Interview Link</p>
            <div className="flex gap-2 mt-1">
              <input
                type="text"
                value={result.inviteLink}
                readOnly
                className="flex-1 px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--ds-radius-sm)] text-caption text-[var(--foreground-secondary)] font-mono"
              />
              <Button variant="primary" size="sm" onClick={() => copyLink(result.inviteLink)}>
                <Copy className="w-3.5 h-3.5 mr-1" />
                {copied ? 'Copied!' : 'Copy'}
              </Button>
            </div>
          </div>

          <button
            onClick={() => { setResult(null); setEmail(''); setName(''); setNotes('') }}
            className="text-caption text-[var(--ds-primary)] hover:underline transition-colors"
          >
            Send Another Invite
          </button>
        </div>
      ) : (
        <div className="surface-card-bordered p-6 space-y-5">
          {!bulkMode ? (
            <div className="grid md:grid-cols-2 gap-4">
              <Input
                label="Candidate Email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="candidate@company.com"
              />
              <Input
                label="Candidate Name"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="John Doe"
                hint="Optional"
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <label className="text-caption text-[var(--foreground-secondary)]">Candidate Emails (one per line or comma-separated)</label>
              <textarea
                value={bulkEmails}
                onChange={e => setBulkEmails(e.target.value)}
                placeholder={'candidate1@company.com\ncandidate2@company.com\ncandidate3@company.com'}
                rows={5}
                className="w-full px-3 py-2.5 bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--ds-radius-sm)] text-body text-[var(--foreground)] placeholder-[var(--foreground-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-primary)] resize-none"
              />
            </div>
          )}

          {/* Interview config */}
          <div className="space-y-1.5">
            <label className="text-caption text-[var(--foreground-secondary)]">Interview Domain *</label>
            <DomainSelector selectedDomain={role} onSelect={slug => { setRole(slug); setInterviewType(null) }} />
          </div>

          <div className="space-y-1.5">
            <label className="text-caption text-[var(--foreground-secondary)]">Interview Type *</label>
            <DepthSelector selectedDomain={role} selectedDepth={interviewType} onSelect={setInterviewType} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-caption text-[var(--foreground-secondary)]">Experience Level</label>
              <SelectionGroup
                items={EXPERIENCE_OPTIONS}
                value={experience}
                onChange={setExperience}
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
              <label className="text-caption text-[var(--foreground-secondary)]">Duration</label>
              <SelectionGroup
                items={DURATION_OPTIONS}
                value={duration}
                onChange={setDuration}
                getKey={(item) => item.key}
                layout="inline"
                renderItem={(item, selected) => (
                  <span className={`block px-2 py-2 text-caption font-medium text-center ${selected ? '' : ''}`}>
                    {item.label}
                  </span>
                )}
              />
            </div>
          </div>

          {!bulkMode && (
            <div className="space-y-1.5">
              <label className="text-caption text-[var(--foreground-secondary)]">Recruiter Notes (internal)</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                maxLength={1000}
                placeholder="Any context for this candidate..."
                rows={2}
                className="w-full px-3 py-2.5 bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--ds-radius-sm)] text-body text-[var(--foreground)] placeholder-[var(--foreground-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-primary)] resize-none"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-caption text-[var(--foreground-secondary)]">Job Description (optional)</label>
            <textarea
              value={jdText}
              onChange={e => setJdText(e.target.value)}
              maxLength={50000}
              placeholder="Paste the job description here for role-specific questions..."
              rows={3}
              className="w-full px-3 py-2.5 bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--ds-radius-sm)] text-body text-[var(--foreground)] placeholder-[var(--foreground-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-primary)] resize-none"
            />
          </div>

          {error && <p className="text-caption text-rose-500">{error}</p>}

          <Button
            variant="primary"
            className="w-full"
            onClick={bulkMode ? handleBulkSend : handleSend}
            disabled={sending || bulkSending}
          >
            {sending || bulkSending ? 'Sending...' : bulkMode ? 'Send All Invites' : 'Send Interview Invite'}
          </Button>
        </div>
      )}

      {/* Bulk results */}
      {bulkResults.length > 0 && (
        <div className="surface-card-bordered p-5 space-y-3">
          <h3 className="text-subheading text-[var(--foreground)]">Bulk Invite Results</h3>
          {bulkResults.map((r, i) => (
            <div key={i} className={`flex items-center justify-between px-3 py-2 rounded-[var(--ds-radius-sm)] ${r.success ? 'bg-emerald-50' : 'bg-rose-50'}`}>
              <span className="text-caption text-[var(--foreground-secondary)]">{r.email}</span>
              {r.success ? (
                <button
                  onClick={() => r.link && copyLink(r.link)}
                  className="text-micro text-[var(--ds-primary)] hover:underline"
                >
                  Copy Link
                </button>
              ) : (
                <Badge variant="danger">{r.error}</Badge>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
