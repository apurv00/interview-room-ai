'use client'

/** Workspace talent pool — candidates persist across jobs (build plan §Core
 * data model). Manual add only in Phase 1; bulk upload arrives in Phase 2. */

import { useCallback, useEffect, useState } from 'react'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'
import StateView from '@shared/ui/StateView'

interface CandidateRow {
  id: string
  name: string
  email: string
  phone: string | null
  hasResume: boolean
  addedAt: string
}

export default function CandidatesPage() {
  const [candidates, setCandidates] = useState<CandidateRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/workspace/candidates')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setCandidates(data.candidates)
    } catch {
      setError('Could not load candidates.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setFormError(null)
    try {
      const res = await fetch('/api/workspace/candidates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFormError(data.error || 'Could not add the candidate.')
        return
      }
      setName('')
      setEmail('')
      setPhone('')
      setShowForm(false)
      await load()
    } catch {
      setFormError('Could not add the candidate. Check your connection.')
    } finally {
      setSaving(false)
    }
  }

  if (error) return <StateView state="error" error={error} onRetry={load} />
  if (candidates === null) return <StateView state="loading" skeletonLayout="list" />

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-[#0f1419]">Candidates</h1>
        <Button onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : 'Add candidate'}
        </Button>
      </div>

      {showForm && (
        <form onSubmit={add} className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-4">
          <div className="grid md:grid-cols-3 gap-4">
            <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
            <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} />
            <Input label="Phone (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={32} />
          </div>
          {formError && <p className="text-xs text-[#f4212e]">{formError}</p>}
          <Button type="submit" disabled={saving || !name.trim() || !email.trim()}>
            {saving ? 'Adding…' : 'Add candidate'}
          </Button>
        </form>
      )}

      {candidates.length === 0 && !showForm ? (
        <StateView
          state="empty"
          title="No candidates yet"
          description="Add candidates here, or directly from a job's pipeline."
          action={{ label: 'Add candidate', onClick: () => setShowForm(true) }}
        />
      ) : (
        <div className="space-y-2">
          {candidates.map((c) => (
            <div key={c.id} className="bg-white border border-[#e1e8ed] rounded-2xl p-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-[#0f1419] truncate">{c.name}</p>
                <p className="text-xs text-[#71767b] truncate">
                  {c.email}
                  {c.phone ? ` · ${c.phone}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {c.hasResume && <Badge variant="default">résumé</Badge>}
                <span className="text-xs text-[#71767b]">
                  added {new Date(c.addedAt).toLocaleDateString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
