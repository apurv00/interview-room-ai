'use client'

/**
 * Jobs list + Smart-JD builder. HR supplies the scoring contract explicitly;
 * AI generates only the narrative. The reviewed prose and immutable
 * requirement set are persisted together when the job is created.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'
import StateView from '@shared/ui/StateView'
import { INTERVIEW_ROLE_SLUG_MAX_CHARS } from '@shared/interviewContract'

interface JobRow {
  id: string
  title: string
  status: 'open' | 'on_hold' | 'closed'
  applicationCount: number
  byStage: Record<string, number>
  createdAt: string
  activeRequirementVersion: number | null
}

type WorkMode = 'onsite' | 'hybrid' | 'remote'

const STATUS_VARIANT: Record<JobRow['status'], 'success' | 'caution' | 'default'> = {
  open: 'success',
  on_hold: 'caution',
  closed: 'default',
}

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
}

export default function JobsPage() {
  const [welcome, setWelcome] = useState(false)
  useEffect(() => {
    setWelcome(new URLSearchParams(window.location.search).get('welcome') === '1')
  }, [])
  const [jobs, setJobs] = useState<JobRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [noWorkspace, setNoWorkspace] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [title, setTitle] = useState('')
  const [level, setLevel] = useState('')
  const [location, setLocation] = useState('')
  const [screeningLocation, setScreeningLocation] = useState('')
  const [experienceFloorYears, setExperienceFloorYears] = useState('')
  const [workMode, setWorkMode] = useState<WorkMode>('hybrid')
  const [compensation, setCompensation] = useState('')
  const [companyBlurb, setCompanyBlurb] = useState('')
  const [savedCompanyBlurb, setSavedCompanyBlurb] = useState('')
  const [canEditWorkspace, setCanEditWorkspace] = useState(false)
  const [savingCompanyBlurb, setSavingCompanyBlurb] = useState(false)
  const [companyBlurbStatus, setCompanyBlurbStatus] = useState<string | null>(null)
  const [mustHavesText, setMustHavesText] = useState('')
  const [niceToHavesText, setNiceToHavesText] = useState('')
  const [jdText, setJdText] = useState('')
  const [generatedFor, setGeneratedFor] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [jobsResponse, workspaceResponse] = await Promise.all([
        fetch('/api/workspace/jobs'),
        fetch('/api/workspace', { cache: 'no-store' }),
      ])
      if (jobsResponse.status === 403 || workspaceResponse.status === 403) {
        setNoWorkspace(true)
        return
      }
      const [jobsData, workspaceData] = await Promise.all([
        jobsResponse.json(),
        workspaceResponse.json(),
      ])
      if (!jobsResponse.ok) throw new Error(jobsData.error)
      if (!workspaceResponse.ok) throw new Error(workspaceData.error)
      setJobs(jobsData.jobs)
      const defaultBlurb = workspaceData.workspace?.companyBlurb || ''
      setSavedCompanyBlurb(defaultBlurb)
      setCompanyBlurb((current) => current || defaultBlurb)
      setCanEditWorkspace(workspaceData.membership?.role === 'admin')
    } catch {
      setError('Could not load jobs.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function builderPayload() {
    return {
      title: title.trim(),
      level: level.trim(),
      mustHaves: lines(mustHavesText),
      niceToHaves: lines(niceToHavesText),
      location: location.trim(),
      workMode,
      ...(compensation.trim() ? { compensation: compensation.trim() } : {}),
      ...(companyBlurb.trim() ? { companyBlurb: companyBlurb.trim() } : {}),
    }
  }

  function screeningSettingsPayload() {
    return {
      ...(screeningLocation.trim() || experienceFloorYears.trim()
        ? {
            screeningSettings: {
              ...(screeningLocation.trim() ? { location: screeningLocation.trim() } : {}),
              ...(experienceFloorYears.trim()
                ? { experienceFloorYears: Number(experienceFloorYears) }
                : {}),
            },
        }
        : {}),
    }
  }

  const currentBuilderSignature = JSON.stringify(builderPayload())
  const canGenerate =
    title.trim().length >= 2 &&
    level.trim().length > 0 &&
    location.trim().length >= 2 &&
    lines(mustHavesText).length > 0
  const previewIsCurrent = generatedFor === currentBuilderSignature && jdText.trim().length >= 50

  async function generateJd() {
    setGenerating(true)
    setFormError(null)
    try {
      const payload = builderPayload()
      const res = await fetch('/api/workspace/jobs/jd-builder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) {
        setFormError(data.details?.[0]?.message || data.error || 'Could not generate the JD.')
        return
      }
      setJdText(data.jdText)
      setGeneratedFor(JSON.stringify(payload))
    } catch {
      setFormError('Could not generate the JD. Check your connection.')
    } finally {
      setGenerating(false)
    }
  }

  async function createJob(e: React.FormEvent) {
    e.preventDefault()
    if (!previewIsCurrent) {
      setFormError('Generate or refresh the JD after changing the requirement fields.')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const res = await fetch('/api/workspace/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...builderPayload(),
          ...screeningSettingsPayload(),
          jdText: jdText.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFormError(data.details?.[0]?.message || data.error || 'Could not create the job.')
        return
      }
      setTitle('')
      setLevel('')
      setLocation('')
      setScreeningLocation('')
      setExperienceFloorYears('')
      setWorkMode('hybrid')
      setCompensation('')
      setCompanyBlurb(savedCompanyBlurb)
      setMustHavesText('')
      setNiceToHavesText('')
      setJdText('')
      setGeneratedFor(null)
      setShowForm(false)
      await load()
    } catch {
      setFormError('Could not create the job. Check your connection.')
    } finally {
      setSaving(false)
    }
  }

  async function saveCompanyBlurb() {
    setSavingCompanyBlurb(true)
    setCompanyBlurbStatus(null)
    setFormError(null)
    try {
      const value = companyBlurb.trim()
      const response = await fetch('/api/workspace', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyBlurb: value }),
      })
      const data = await response.json()
      if (!response.ok) {
        setFormError(data.details?.[0]?.message || data.error || 'Could not save the company blurb.')
        return
      }
      const saved = data.workspace?.companyBlurb || ''
      setSavedCompanyBlurb(saved)
      setCompanyBlurb(saved)
      setCompanyBlurbStatus(saved ? 'Saved as the workspace default.' : 'Workspace default cleared.')
    } catch {
      setFormError('Could not save the company blurb. Check your connection.')
    } finally {
      setSavingCompanyBlurb(false)
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
        <Button onClick={() => setShowForm((value) => !value)}>
          {showForm ? 'Cancel' : 'New job'}
        </Button>
      </div>

      {showForm && (
        <form
          onSubmit={createJob}
          className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-5"
        >
          <div>
            <p className="font-semibold text-[#0f1419]">Smart JD</p>
            <p className="text-xs text-[#71767b] mt-1">
              Requirements are the scoring contract. The generated prose can be edited,
              but it never changes which items are must-have or nice-to-have.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <Input
              label="Role"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Senior Backend Engineer"
              required
              minLength={2}
              maxLength={INTERVIEW_ROLE_SLUG_MAX_CHARS}
            />
            <Input
              label="Level"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              placeholder="Senior · 5–8 years"
              required
              maxLength={80}
            />
            <Input
              label="Location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Bengaluru, India"
              required
              maxLength={160}
            />
            <div className="space-y-1.5">
              <label
                htmlFor="hire-work-mode"
                className="text-sm font-medium text-[#0f1419] block"
              >
                Work mode
              </label>
              <select
                id="hire-work-mode"
                value={workMode}
                onChange={(e) => setWorkMode(e.target.value as WorkMode)}
                className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-sm"
              >
                <option value="onsite">On-site</option>
                <option value="hybrid">Hybrid</option>
                <option value="remote">Remote</option>
              </select>
            </div>
            <Input
              label="Compensation (optional)"
              value={compensation}
              onChange={(e) => setCompensation(e.target.value)}
              placeholder="₹30–40 LPA + ESOPs"
              maxLength={240}
            />
            <Input
              label="Screening location (optional)"
              value={screeningLocation}
              onChange={(e) => setScreeningLocation(e.target.value)}
              placeholder="Only set when location is a knockout rule"
              maxLength={160}
            />
            <Input
              label="Experience floor (years, optional)"
              type="number"
              min="0"
              max="50"
              step="1"
              value={experienceFloorYears}
              onChange={(e) => setExperienceFloorYears(e.target.value)}
              placeholder="e.g. 3"
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="hire-company-blurb"
                className="text-sm font-medium text-[#0f1419] block"
              >
                Company blurb (optional)
              </label>
              {canEditWorkspace && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    savingCompanyBlurb || companyBlurb.trim() === savedCompanyBlurb
                  }
                  onClick={() => void saveCompanyBlurb()}
                >
                  {savingCompanyBlurb ? 'Saving…' : 'Save workspace default'}
                </Button>
              )}
            </div>
            <textarea
              id="hire-company-blurb"
              value={companyBlurb}
              onChange={(e) => {
                setCompanyBlurb(e.target.value)
                setCompanyBlurbStatus(null)
              }}
              rows={3}
              minLength={10}
              maxLength={2000}
              placeholder="What the company builds, who it serves, and why the role matters."
              className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-sm"
            />
            <p className="text-xs text-[#71767b]">
              {canEditWorkspace
                ? 'Save once to prefill every future Smart JD.'
                : 'The workspace admin controls the saved default.'}
            </p>
            <p aria-live="polite" className="text-xs text-emerald-700">
              {companyBlurbStatus}
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label
                htmlFor="hire-must-haves"
                className="text-sm font-medium text-[#0f1419] block"
              >
                Must-haves · one per line
              </label>
              <textarea
                id="hire-must-haves"
                value={mustHavesText}
                onChange={(e) => setMustHavesText(e.target.value)}
                rows={6}
                required
                maxLength={10000}
                placeholder={'5+ years building backend systems\nStrong SQL and data modelling\nProduction experience with Kafka'}
                className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="hire-nice-to-haves"
                className="text-sm font-medium text-[#0f1419] block"
              >
                Nice-to-haves · one per line
              </label>
              <textarea
                id="hire-nice-to-haves"
                value={niceToHavesText}
                onChange={(e) => setNiceToHavesText(e.target.value)}
                rows={6}
                maxLength={10000}
                placeholder={'Payments domain experience\nKubernetes operations'}
                className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-sm"
              />
            </div>
          </div>

          <Button
            type="button"
            variant="secondary"
            disabled={generating || !canGenerate}
            onClick={() => void generateJd()}
          >
            {generating ? 'Generating…' : jdText ? 'Regenerate JD' : 'Generate JD'}
          </Button>

          {jdText && (
            <div className="space-y-1.5">
              <label
                htmlFor="hire-reviewed-jd"
                className="text-sm font-medium text-[#0f1419] block"
              >
                Reviewed prose JD
              </label>
              {!previewIsCurrent && (
                <p className="text-xs text-amber-600">
                  Requirement fields changed. Regenerate before creating the job.
                </p>
              )}
              <textarea
                id="hire-reviewed-jd"
                value={jdText}
                onChange={(e) => setJdText(e.target.value)}
                required
                minLength={50}
                maxLength={50000}
                rows={16}
                className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-sm font-mono"
              />
            </div>
          )}
          {formError && <p className="text-xs text-[#f4212e]">{formError}</p>}
          <Button type="submit" disabled={saving || !previewIsCurrent}>
            {saving ? 'Creating…' : 'Create job'}
          </Button>
        </form>
      )}

      {jobs.length === 0 && !showForm ? (
        <StateView
          state="empty"
          title="No jobs yet"
          description="Create a Smart JD and its structured scoring requirements."
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
                    {job.activeRequirementVersion ? ` · JD v${job.activeRequirementVersion}` : ''}
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
