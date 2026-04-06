'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import DomainSelector from '@interview/components/DomainSelector'
import DepthSelector from '@interview/components/DepthSelector'

export default function InvitePage() {
  const router = useRouter()
  const { status: authStatus } = useSession()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<string | null>(null)
  const [interviewType, setInterviewType] = useState<string | null>(null)
  const [experience, setExperience] = useState<string>('3-6')
  const [duration, setDuration] = useState<number>(20)
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
          duration,
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
            duration,
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
        <h1 className="text-2xl font-bold text-[#0f1419]">Invite Candidates</h1>
        <button
          onClick={() => { setBulkMode(!bulkMode); setResult(null); setBulkResults([]) }}
          className="text-xs text-[#2563eb] hover:text-[#2563eb] transition-colors"
        >
          {bulkMode ? 'Single Invite' : 'Bulk Invite'}
        </button>
      </div>

      {result ? (
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-6 space-y-4 animate-fade-in">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-[#059669]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-[#059669]">Invite Sent!</p>
              <p className="text-xs text-emerald-300/70">Sent to {result.candidateEmail}</p>
            </div>
          </div>

          <div>
            <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Interview Link</label>
            <div className="flex gap-2 mt-1">
              <input
                type="text"
                value={result.inviteLink}
                readOnly
                className="flex-1 px-3 py-2 bg-[#f7f9f9] border border-[#e1e8ed] rounded-lg text-xs text-[#536471] font-mono"
              />
              <button
                onClick={() => copyLink(result.inviteLink)}
                className="px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg font-medium transition-colors"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          <button
            onClick={() => { setResult(null); setEmail(''); setName(''); setNotes('') }}
            className="text-xs text-[#2563eb] hover:text-[#2563eb] transition-colors"
          >
            Send Another Invite
          </button>
        </div>
      ) : (
        <div className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-5">
          {!bulkMode ? (
            <>
              {/* Single invite */}
              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Candidate Email *</label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="candidate@company.com"
                    className="w-full px-3 py-2.5 bg-[#f7f9f9] border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Candidate Name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="John Doe"
                    className="w-full px-3 py-2.5 bg-[#f7f9f9] border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Candidate Emails (one per line or comma-separated)</label>
              <textarea
                value={bulkEmails}
                onChange={e => setBulkEmails(e.target.value)}
                placeholder={'candidate1@company.com\ncandidate2@company.com\ncandidate3@company.com'}
                rows={5}
                className="w-full px-3 py-2.5 bg-[#f7f9f9] border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
            </div>
          )}

          {/* Interview config */}
          <div className="space-y-1.5">
            <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Interview Domain *</label>
            <DomainSelector selectedDomain={role} onSelect={slug => { setRole(slug); setInterviewType(null) }} />
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Interview Type *</label>
            <DepthSelector selectedDomain={role} selectedDepth={interviewType} onSelect={setInterviewType} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Experience Level</label>
              <div className="grid grid-cols-3 gap-2">
                {['0-2', '3-6', '7+'].map(e => (
                  <button
                    key={e}
                    onClick={() => setExperience(e)}
                    className={`py-2 rounded-lg border text-xs font-medium transition-all ${
                      experience === e ? 'border-blue-500 bg-blue-500/10 text-[#2563eb]' : 'border-[#e1e8ed] bg-[#f7f9f9] text-[#536471] hover:border-[#e1e8ed]'
                    }`}
                  >
                    {e} yrs
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Duration</label>
              <div className="grid grid-cols-3 gap-2">
                {[10, 20, 30].map(d => (
                  <button
                    key={d}
                    onClick={() => setDuration(d)}
                    className={`py-2 rounded-lg border text-xs font-medium transition-all ${
                      duration === d ? 'border-blue-500 bg-blue-500/10 text-[#2563eb]' : 'border-[#e1e8ed] bg-[#f7f9f9] text-[#536471] hover:border-[#e1e8ed]'
                    }`}
                  >
                    {d} min
                  </button>
                ))}
              </div>
            </div>
          </div>

          {!bulkMode && (
            <div className="space-y-1.5">
              <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Recruiter Notes (internal)</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                maxLength={1000}
                placeholder="Any context for this candidate..."
                rows={2}
                className="w-full px-3 py-2.5 bg-[#f7f9f9] border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[10px] text-[#8b98a5] uppercase tracking-wider">Job Description (optional)</label>
            <textarea
              value={jdText}
              onChange={e => setJdText(e.target.value)}
              maxLength={50000}
              placeholder="Paste the job description here for role-specific questions..."
              rows={3}
              className="w-full px-3 py-2.5 bg-[#f7f9f9] border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button
            onClick={bulkMode ? handleBulkSend : handleSend}
            disabled={sending || bulkSending}
            className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-medium transition-colors disabled:opacity-50"
          >
            {sending || bulkSending ? 'Sending...' : bulkMode ? 'Send All Invites' : 'Send Interview Invite'}
          </button>
        </div>
      )}

      {/* Bulk results */}
      {bulkResults.length > 0 && (
        <div className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-3">
          <h3 className="text-sm font-semibold text-[#0f1419]">Bulk Invite Results</h3>
          {bulkResults.map((r, i) => (
            <div key={i} className={`flex items-center justify-between px-3 py-2 rounded-lg ${r.success ? 'bg-emerald-500/5' : 'bg-red-500/5'}`}>
              <span className="text-xs text-[#536471]">{r.email}</span>
              {r.success ? (
                <button
                  onClick={() => r.link && copyLink(r.link)}
                  className="text-[10px] text-[#2563eb] hover:text-[#2563eb]"
                >
                  Copy Link
                </button>
              ) : (
                <span className="text-[10px] text-red-400">{r.error}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
