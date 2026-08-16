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
  departmentId: string
  title: string
  status: 'open' | 'on_hold' | 'closed'
  applicationCount: number
  byStage: Record<string, number>
  createdAt: string
  activeRequirementVersion: number | null
}

interface DepartmentRow {
  id: string
  name: string
  status: 'active' | 'archived'
  kind: string
}

type WorkMode = 'onsite' | 'hybrid' | 'remote'
type JobDescriptionSource = 'ai_generated' | 'manual'

const JOB_LEVEL_OPTIONS = [
  { value: 'ic', label: 'Individual contributor (IC)' },
  { value: 'manager', label: 'Manager' },
  { value: 'senior_manager', label: 'Senior manager' },
  { value: 'director', label: 'Director' },
  { value: 'executive', label: 'Executive' },
] as const

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

function selectableDepartments(departments: DepartmentRow[]): DepartmentRow[] {
  return departments.filter(
    (department) => department.status === 'active' && department.kind === 'standard',
  )
}

function sortDepartments(departments: DepartmentRow[]): DepartmentRow[] {
  return [...departments].sort((left, right) => left.name.localeCompare(right.name))
}

export default function JobsPage() {
  const [welcome, setWelcome] = useState(false)
  useEffect(() => {
    setWelcome(new URLSearchParams(window.location.search).get('welcome') === '1')
  }, [])
  const [jobs, setJobs] = useState<JobRow[] | null>(null)
  const [departments, setDepartments] = useState<DepartmentRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [noWorkspace, setNoWorkspace] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [title, setTitle] = useState('')
  const [level, setLevel] = useState('')
  const [location, setLocation] = useState('')
  const [screeningLocation, setScreeningLocation] = useState('')
  const [screeningExperienceFloorYears, setScreeningExperienceFloorYears] = useState('')
  const [targetExperienceMinYears, setTargetExperienceMinYears] = useState('')
  const [targetExperienceMaxYears, setTargetExperienceMaxYears] = useState('')
  const [workMode, setWorkMode] = useState<WorkMode>('hybrid')
  const [compensation, setCompensation] = useState('')
  const [companyDescription, setCompanyDescription] = useState('')
  const [canEditWorkspace, setCanEditWorkspace] = useState(false)
  const [mustHavesText, setMustHavesText] = useState('')
  const [niceToHavesText, setNiceToHavesText] = useState('')
  const [jdText, setJdText] = useState('')
  const [jdSource, setJdSource] = useState<JobDescriptionSource>('ai_generated')
  const [generatedFor, setGeneratedFor] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [departmentId, setDepartmentId] = useState('')
  const [newDepartmentName, setNewDepartmentName] = useState('')
  const [creatingDepartment, setCreatingDepartment] = useState(false)
  const [departmentNotice, setDepartmentNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [jobsResponse, workspaceResponse, departmentsResponse] = await Promise.all([
        fetch('/api/workspace/jobs'),
        fetch('/api/workspace', { cache: 'no-store' }),
        fetch('/api/workspace/departments', { cache: 'no-store' }),
      ])
      if (
        jobsResponse.status === 403 ||
        workspaceResponse.status === 403 ||
        departmentsResponse.status === 403
      ) {
        setNoWorkspace(true)
        return
      }
      const [jobsData, workspaceData, departmentsData] = await Promise.all([
        jobsResponse.json(),
        workspaceResponse.json(),
        departmentsResponse.json(),
      ])
      if (!jobsResponse.ok) throw new Error(jobsData.error)
      if (!workspaceResponse.ok) throw new Error(workspaceData.error)
      if (!departmentsResponse.ok || !Array.isArray(departmentsData.departments)) {
        throw new Error(departmentsData.error || 'Could not load departments.')
      }
      setJobs(jobsData.jobs)
      setDepartments(sortDepartments(departmentsData.departments as DepartmentRow[]))
      const onboardingDescription =
        workspaceData.workspace?.companyDescription ?? workspaceData.workspace?.companyBlurb ?? ''
      setCompanyDescription(onboardingDescription)
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
      targetExperienceRange: {
        minYears: Number(targetExperienceMinYears),
        maxYears: Number(targetExperienceMaxYears),
      },
      mustHaves: lines(mustHavesText),
      niceToHaves: lines(niceToHavesText),
      location: location.trim(),
      workMode,
      ...(compensation.trim() ? { compensation: compensation.trim() } : {}),
    }
  }

  function screeningSettingsPayload() {
    return {
      ...(screeningLocation.trim() || screeningExperienceFloorYears.trim()
        ? {
            screeningSettings: {
              ...(screeningLocation.trim() ? { location: screeningLocation.trim() } : {}),
              ...(screeningExperienceFloorYears.trim()
                ? { experienceFloorYears: Number(screeningExperienceFloorYears) }
                : {}),
            },
        }
        : {}),
    }
  }

  const currentBuilderSignature = JSON.stringify(builderPayload())
  const targetExperienceMin = Number(targetExperienceMinYears)
  const targetExperienceMax = Number(targetExperienceMaxYears)
  const hasValidTargetExperienceRange =
    targetExperienceMinYears.trim().length > 0 &&
    targetExperienceMaxYears.trim().length > 0 &&
    Number.isFinite(targetExperienceMin) &&
    Number.isFinite(targetExperienceMax) &&
    targetExperienceMin >= 0 &&
    targetExperienceMax <= 50 &&
    targetExperienceMin <= targetExperienceMax
  const hasCompanyDescription = companyDescription.trim().length >= 10
  const canGenerate =
    hasCompanyDescription &&
    departmentId.length > 0 &&
    title.trim().length >= 2 &&
    level.trim().length > 0 &&
    hasValidTargetExperienceRange &&
    location.trim().length >= 2 &&
    lines(mustHavesText).length > 0
  const previewIsCurrent =
    canGenerate &&
    jdText.trim().length >= 50 &&
    (jdSource === 'manual' || generatedFor === currentBuilderSignature)

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
    if (!hasCompanyDescription) {
      setFormError('Complete the company profile from onboarding before creating a job.')
      return
    }
    if (!previewIsCurrent) {
      setFormError(
        jdSource === 'manual'
          ? 'Complete the required role fields and add the existing job description.'
          : 'Generate or refresh the JD after changing the requirement fields.',
      )
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
          departmentId,
          jdText: jdText.trim(),
          jdSource,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFormError(data.details?.[0]?.message || data.error || 'Could not create the job.')
        return
      }
      setTitle('')
      setDepartmentId('')
      setLevel('')
      setLocation('')
      setScreeningLocation('')
      setScreeningExperienceFloorYears('')
      setTargetExperienceMinYears('')
      setTargetExperienceMaxYears('')
      setWorkMode('hybrid')
      setCompensation('')
      setMustHavesText('')
      setNiceToHavesText('')
      setJdText('')
      setJdSource('ai_generated')
      setGeneratedFor(null)
      setShowForm(false)
      await load()
    } catch {
      setFormError('Could not create the job. Check your connection.')
    } finally {
      setSaving(false)
    }
  }

  async function createDepartmentInline() {
    const name = newDepartmentName.trim()
    if (!name) return
    setCreatingDepartment(true)
    setFormError(null)
    setDepartmentNotice(null)
    try {
      const response = await fetch('/api/workspace/departments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.department?.id) {
        setFormError(data.error || 'Could not add the department.')
        return
      }
      const department = data.department as DepartmentRow
      if (department.status !== 'active' || department.kind !== 'standard') {
        setFormError('Could not add an active department for new jobs.')
        return
      }
      setDepartments((current) => sortDepartments([...(current ?? []), department]))
      setDepartmentId(department.id)
      setNewDepartmentName('')
      setDepartmentNotice(`Department “${department.name}” added and selected.`)
    } catch {
      setFormError('Could not add the department. Check your connection.')
    } finally {
      setCreatingDepartment(false)
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
  if (jobs === null || departments === null) {
    return <StateView state="loading" skeletonLayout="list" />
  }

  const selectable = selectableDepartments(departments)
  const departmentNameById = new Map(departments.map((department) => [department.id, department.name]))

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
            <p className="font-semibold text-[#0f1419]">Job requirements</p>
            <p className="text-xs text-[#71767b] mt-1">
              Seniority, experience range, and requirements are separate parts of the
              scoring contract. Choose AI drafting or paste an existing JD below.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label
                htmlFor="hire-department"
                className="text-sm font-medium text-[#0f1419] block"
              >
                Department
              </label>
              <select
                id="hire-department"
                value={departmentId}
                onChange={(event) => {
                  setDepartmentId(event.target.value)
                  setDepartmentNotice(null)
                }}
                required
                disabled={selectable.length === 0}
                className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-sm disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="">Select a department</option>
                {selectable.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-[#71767b]">
                Every requisition belongs to one department for hiring and reporting.
              </p>
            </div>
            <Input
              label="Role"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Backend Engineer"
              required
              minLength={2}
              maxLength={INTERVIEW_ROLE_SLUG_MAX_CHARS}
            />
            <div className="space-y-1.5">
              <label
                htmlFor="hire-level"
                className="text-sm font-medium text-[#0f1419] block"
              >
                Level
              </label>
              <select
                id="hire-level"
                value={level}
                onChange={(event) => setLevel(event.target.value)}
                required
                className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-sm"
              >
                <option value="">Select a level</option>
                {JOB_LEVEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-[#71767b]">
                Choose seniority only; set experience separately below.
              </p>
            </div>
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
            <div className="md:col-span-2 rounded-xl border border-[#e1e8ed] bg-[#f8fafc] p-4 space-y-3">
              <div>
                <p className="text-sm font-medium text-[#0f1419]">Target experience range</p>
                <p className="text-xs text-[#71767b] mt-1">
                  Used as JD-match context. It helps rank fit and does not automatically
                  reject candidates above or below the range.
                </p>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <Input
                  label="Minimum years"
                  type="number"
                  min="0"
                  max="50"
                  step="0.5"
                  value={targetExperienceMinYears}
                  onChange={(event) => setTargetExperienceMinYears(event.target.value)}
                  placeholder="e.g. 3"
                  required
                />
                <Input
                  label="Maximum years"
                  type="number"
                  min="0"
                  max="50"
                  step="0.5"
                  value={targetExperienceMaxYears}
                  onChange={(event) => setTargetExperienceMaxYears(event.target.value)}
                  placeholder="e.g. 8"
                  required
                />
              </div>
              {targetExperienceMinYears &&
                targetExperienceMaxYears &&
                !hasValidTargetExperienceRange && (
                  <p className="text-xs text-[#f4212e]">
                    Enter values between 0 and 50, with the minimum no greater than the maximum.
                  </p>
                )}
            </div>
            <div className="md:col-span-2 rounded-xl border border-[#e1e8ed] bg-[#f8fafc] p-4 space-y-3">
              <div>
                <p className="text-sm font-medium text-[#0f1419]">
                  Optional hard screening rules
                </p>
                <p className="text-xs text-[#71767b] mt-1">
                  Leave these blank unless they should exclude a candidate from a screening gate.
                </p>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <Input
                  label="Screening location"
                  value={screeningLocation}
                  onChange={(e) => setScreeningLocation(e.target.value)}
                  placeholder="Only set when location is a knockout rule"
                  maxLength={160}
                />
                <Input
                  label="Screening experience floor (years)"
                  type="number"
                  min="0"
                  max="50"
                  step="1"
                  value={screeningExperienceFloorYears}
                  onChange={(e) => setScreeningExperienceFloorYears(e.target.value)}
                  placeholder="Only set when it is a knockout rule"
                />
              </div>
            </div>
          </div>
          {selectable.length === 0 && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 space-y-3">
              <p className="text-sm text-amber-950">
                A department is required before a job can be created.
              </p>
              {canEditWorkspace ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="flex-1">
                    <Input
                      label="New department name"
                      value={newDepartmentName}
                      onChange={(event) => setNewDepartmentName(event.target.value)}
                      maxLength={120}
                      placeholder="Engineering"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={creatingDepartment || !newDepartmentName.trim()}
                    onClick={() => void createDepartmentInline()}
                  >
                    {creatingDepartment ? 'Adding…' : 'Add department'}
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-amber-950">
                  Ask the workspace administrator to add a department, then return here.
                </p>
              )}
            </div>
          )}
          {selectable.length > 0 && canEditWorkspace && (
            <div className="rounded-xl border border-[#e1e8ed] bg-[#f8fafc] p-4 space-y-3">
              <p className="text-sm font-medium text-[#0f1419]">Need another department?</p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <Input
                    label="New department name"
                    value={newDepartmentName}
                    onChange={(event) => setNewDepartmentName(event.target.value)}
                    maxLength={120}
                    placeholder="Engineering"
                  />
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={creatingDepartment || !newDepartmentName.trim()}
                  onClick={() => void createDepartmentInline()}
                >
                  {creatingDepartment ? 'Adding…' : 'Add department'}
                </Button>
              </div>
            </div>
          )}
          {departmentNotice && (
            <p className="text-xs text-emerald-700" aria-live="polite">
              {departmentNotice}
            </p>
          )}
          <div className="rounded-xl border border-[#e1e8ed] bg-[#f8fafc] p-4 space-y-2">
            <p className="text-sm font-medium text-[#0f1419]">Company description</p>
            {companyDescription ? (
              <p className="text-sm text-[#3b4a54] whitespace-pre-wrap">{companyDescription}</p>
            ) : (
              <p className="text-sm text-amber-700">
                No company description is available yet. Complete onboarding before creating
                a job so every JD has consistent company context.
              </p>
            )}
            <p className="text-xs text-[#71767b]">
              This description comes from onboarding and is saved with each immutable JD version.
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
          <div className="rounded-xl border border-[#e1e8ed] bg-[#f8fafc] p-4 space-y-3">
            <div>
              <p className="text-sm font-medium text-[#0f1419]">Job description</p>
              <p className="text-xs text-[#71767b] mt-1">
                Choose how to supply the reviewed job description. Both paths use the same
                structured requirements and company description.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row" role="radiogroup" aria-label="Job description source">
              <Button
                type="button"
                variant={jdSource === 'ai_generated' ? 'primary' : 'secondary'}
                aria-pressed={jdSource === 'ai_generated'}
                onClick={() => {
                  setJdSource('ai_generated')
                  setFormError(null)
                }}
              >
                Create with AI
              </Button>
              <Button
                type="button"
                variant={jdSource === 'manual' ? 'primary' : 'secondary'}
                aria-pressed={jdSource === 'manual'}
                onClick={() => {
                  setJdSource('manual')
                  setGeneratedFor(null)
                  setFormError(null)
                }}
              >
                Paste existing JD
              </Button>
            </div>
          </div>

          {jdSource === 'ai_generated' && (
            <Button
              type="button"
              variant="secondary"
              disabled={generating || !canGenerate}
              onClick={() => void generateJd()}
            >
              {generating ? 'Generating…' : jdText ? 'Regenerate JD' : 'Generate JD'}
            </Button>
          )}

          {(jdSource === 'manual' || jdText) && (
            <div className="space-y-1.5">
              <label
                htmlFor="hire-reviewed-jd"
                className="text-sm font-medium text-[#0f1419] block"
              >
                {jdSource === 'manual' ? 'Existing job description' : 'Reviewed AI-generated JD'}
              </label>
              {jdSource === 'manual' ? (
                <p className="text-xs text-[#71767b]">
                  Your pasted text is preserved. The saved JD adds the selected role level,
                  experience range, location, and onboarding company description as matching context.
                </p>
              ) : !previewIsCurrent ? (
                <p className="text-xs text-amber-600">
                  Requirement fields changed. Regenerate before creating the job.
                </p>
              ) : null}
              <textarea
                id="hire-reviewed-jd"
                value={jdText}
                onChange={(e) => setJdText(e.target.value)}
                required
                minLength={50}
                maxLength={jdSource === 'manual' ? 47000 : 50000}
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
          description="Create a job description and its structured scoring requirements."
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
                    {departmentNameById.get(job.departmentId) ?? 'Department unavailable'} ·{' '}
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
