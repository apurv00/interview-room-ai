'use client'

/**
 * Workspace entry: members land on Jobs; a user with no workspace gets the
 * create form (the creator becomes the single admin — build plan §Permission
 * model). Empty states are designed first: creating a workspace drops you
 * straight into creating your first job.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'
import StateView from '@shared/ui/StateView'

export default function WorkspaceEntryPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [hasWorkspace, setHasWorkspace] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/workspace')
      const data = await res.json()
      if (data.workspace) {
        setHasWorkspace(true)
        router.replace('/workspace/jobs')
        return
      }
      setHasWorkspace(false)
    } catch {
      setError('Could not load your workspace.')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => {
    void load()
  }, [load])

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Could not create the workspace.')
        return
      }
      router.replace('/workspace/jobs?welcome=1')
    } catch {
      setError('Could not create the workspace. Check your connection.')
    } finally {
      setCreating(false)
    }
  }

  if (loading || hasWorkspace) {
    return <StateView state="loading" skeletonLayout="card" />
  }

  return (
    <div className="max-w-md mx-auto mt-12">
      <div className="bg-white border border-[#e1e8ed] rounded-2xl p-8 space-y-5">
        <div className="space-y-1">
          <h1 className="text-xl font-bold text-[#0f1419]">Create your workspace</h1>
          <p className="text-sm text-[#536471]">
            One workspace per company. You&apos;ll be the admin and can add your HR
            team by email — interviewers and stakeholders never need accounts.
          </p>
        </div>
        <form onSubmit={create} className="space-y-4">
          <Input
            label="Company name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Inc."
            required
            minLength={2}
            maxLength={120}
          />
          {error && <p className="text-xs text-[#f4212e]">{error}</p>}
          <Button type="submit" disabled={creating || name.trim().length < 2}>
            {creating ? 'Creating…' : 'Create workspace'}
          </Button>
        </form>
      </div>
    </div>
  )
}
