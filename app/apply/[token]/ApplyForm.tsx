'use client'

/**
 * Applicant-facing submit form. Deliberately learns NOTHING about the
 * employer's pipeline: the endpoint returns one uniform body for success,
 * duplicate application, and "this email belongs to someone else", so
 * there is nothing here to leak.
 */

import { useState, type FormEvent } from 'react'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'

const ACCEPT = '.pdf,.docx,.txt'
const MAX_FILE_SIZE = 5 * 1024 * 1024

export default function ApplyForm({ token }: { token: string }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!file) {
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
      const res = await fetch(`/api/apply/${encodeURIComponent(token)}`, {
        method: 'POST',
        body: form,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'We could not submit your application. Please try again.')
        return
      }
      setDone(true)
    } catch {
      setError('We could not reach the server. Please check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="bg-white border border-[#e1e8ed] rounded-2xl p-8 text-center space-y-3">
        <div className="text-4xl">🎉</div>
        <h2 className="text-lg font-bold text-[#0f1419]">Application received</h2>
        <p className="text-sm text-[#536471] leading-relaxed">
          Thanks! The hiring team has your details and will be in touch about next steps.
          You can close this tab.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-4">
      <Input
        label="Full name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        maxLength={120}
      />
      <Input
        label="Email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        maxLength={254}
      />
      <Input
        label="Phone (optional)"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        maxLength={32}
      />

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-[#0f1419] block">Résumé</label>
        <label className="block border-2 border-dashed border-[#e1e8ed] rounded-2xl p-5 text-center cursor-pointer hover:border-[#2563eb]/40 transition-colors">
          <input
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <span className="text-sm text-[#536471]">
            {file ? file.name : 'PDF, DOCX or TXT — up to 5MB'}
          </span>
        </label>
      </div>

      {error && <p className="text-sm text-[#f4212e]">{error}</p>}

      <Button type="submit" disabled={busy || !name.trim() || !email.trim() || !file}>
        {busy ? 'Submitting…' : 'Submit application'}
      </Button>
    </form>
  )
}
