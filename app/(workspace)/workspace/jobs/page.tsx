'use client'

/**
 * Jobs list + create. The create form IS the Phase 1 "JD builder": title +
 * pasted JD text (the JD grounds AI-round question generation and JD-match
 * scoring). Sorted newest first; per-stage counts as chips.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'
import StateView from '@shared/ui/StateView'

interface JobRow {
  id: string
  title: string
  status: 'open' | 'on_hold' | 'closed'
  applicationCount: number
  byStage: Record<string, number>
  createdAt: string
}

const STATUS_VARIANT: Record<JobRow['status'], 'success' | 'caution' | 'default'> = {
  open: 'success',
  on_hold: 'caution',
  closed: 'default',
}

export default function JobsPage() {
  // Read the one-shot ?welcome=1 flag without useSearchParams — that hook
  // forces a Suspense boundary at static export (missing-suspense-with-csr-bailout).
  const [welcome, setWelcome] = useState(false)
  useEffect(() => {
    setWelcome(new URLSearchParams(window.location.search).get('welcome') === '1')
  }, [])
  const [jobs, setJobs] = useState<JobRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [noWorkspace, setNoWorkspace] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [title, setTitle] = useState('')
  const [jdText, setJdText] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/workspace/jobs')
      if (res.status === 403) {
        setNoWorkspace(true)
        return
      }
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setJobs(data.jobs)
    } catch {
      setError('Could not load jobs.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function createJob(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setFormError(null)
    try {
      const res = await fetch('/api/workspace/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), jdText: jdText.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFormError(
          data.details?.[0]?.message || data.error || 'Could not create the job.'
        )
        return
      }
      setTitle('')
      setJdText('')
      setShowForm(false)
      await load()
    } catch {
      setFormError('Could not create the job. Check your connection.')
    } finally {
      setSaving(false)
    }
  }

  if (noWorkspace) {
    return (
      <StateView
        state="empty"
        title="No workspace yet"
        description="Create your workspace to start hiring."
        action={{ label: 'Create workspace', onClick: () => (window.location.href = '/workspace') }}
      />
    )
  }
  if (error) return <StateView state="error" error={error} onRetry={load} />
  if (jobs === null) return <StateView state="loading" skeletonLayout="list" />

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#0f1419]">Jobs</h1>
          {welcome && (
            <p className="text-sm text-emerald-600">
              Workspace created — add your first job to get going.
            </p>
          )}
        </div>
        <Button onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : 'New job'}
        </Button>
      </div>

      {showForm && (
        <form
          onSubmit={createJob}
          className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-4"
        >
          <Input
            label="Job title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Senior Backend Engineer"
            required
            minLength={2}
            maxLength={200}
          />
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-[#0f1419] block">
              Job description
            </label>
            <p className="text-xs text-[#71767b]">
              Paste the full JD — it grounds the AI interview questions and the
              JD-match score.
            </p>
            <textarea
              value={jdText}
              onChange={(e) => setJdText(e.target.value)}
              required
              minLength={50}
              maxLength={50000}
              rows={8}
              className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
              placeholder="Responsibilities, requirements, nice-to-haves…"
            />
          </div>
          {formError && <p className="text-xs text-[#f4212e]">{formError}</p>}
          <Button type="submit" disabled={saving || title.trim().length < 2 || jdText.trim().length < 50}>
            {saving ? 'Creating…' : 'Create job'}
          </Button>
        </form>
      )}

      {jobs.length === 0 && !showForm ? (
        <StateView
          state="empty"
          title="No jobs yet"
          description="Create your first job: a title and a pasted JD is all it takes."
          action={{ label: 'New job', onClick: () => setShowForm(true) }}
        />
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <Link
              key={job.id}
              href={`/workspace/jobs/${job.id}`}
              className="block bg-white border border-[#e1e8ed] rounded-2xl p-5 hover:border-indigo-300 transition-colors"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-semibold text-[#0f1419] truncate">{job.title}</p>
                  <p className="text-xs text-[#71767b]">
                    {job.applicationCount} candidate{job.applicationCount === 1 ? '' : 's'} ·
                    created {new Date(job.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {(job.byStage.shortlist ?? 0) > 0 && (
                    <Badge variant="primary">{job.byStage.shortlist} shortlisted</Badge>
                  )}
                  {(job.byStage.hired ?? 0) > 0 && (
                    <Badge variant="success">{job.byStage.hired} hired</Badge>
                  )}
                  <Badge variant={STATUS_VARIANT[job.status]}>
                    {job.status.replace('_', ' ')}
                  </Badge>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
