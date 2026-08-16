import { HireApplication, HireCandidate, HireJob } from '../models'
import { HireDepartment } from '@hire-departments/models'
import type { MembershipContext } from './workspaceService'
import { connectHireControlDB } from './hireControlBoundary'

const COLUMNS = [
  'candidate_id',
  'name',
  'email',
  'phone',
  'source',
  'resume_file',
  'job',
  'department',
  'stage',
  'decision_note',
  'candidate_created_at',
  'last_activity_at',
] as const

/** Prevent spreadsheet formula execution while preserving the visible value. */
function safeCell(value: unknown): string {
  let text = value == null ? '' : value instanceof Date ? value.toISOString() : String(value)
  if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

/** Workspace-scoped "my data is not trapped" export used before deletion. */
export async function buildWorkspaceCandidatesCsv(ctx: MembershipContext): Promise<string> {
  await connectHireControlDB()
  const workspaceId = ctx.workspace._id
  const [candidates, applications, jobs] = await Promise.all([
    HireCandidate.find({ workspaceId }).sort({ createdAt: 1 }).lean(),
    HireApplication.find({ workspaceId }).sort({ createdAt: 1 }).lean(),
    HireJob.find({ workspaceId }).select('_id title departmentId').lean(),
  ])
  const departmentIds = Array.from(
    new Map(
      jobs
        .filter((job) => job.departmentId)
        .map((job) => [job.departmentId.toString(), job.departmentId]),
    ).values(),
  )
  const departments = departmentIds.length
    ? await HireDepartment.find({ workspaceId, _id: { $in: departmentIds } })
      .select('_id name')
      .lean()
    : []
  const applicationsByCandidate = new Map<string, typeof applications>()
  for (const application of applications) {
    const key = application.candidateId.toString()
    const rows = applicationsByCandidate.get(key) ?? []
    rows.push(application)
    applicationsByCandidate.set(key, rows)
  }
  const jobById = new Map(jobs.map((job) => [job._id.toString(), job]))
  const titleByJob = new Map(jobs.map((job) => [job._id.toString(), job.title]))
  const departmentNameById = new Map(
    departments.map((department) => [department._id.toString(), department.name]),
  )
  const departmentNameForApplication = (application: (typeof applications)[number] | null) => {
    if (!application) return ''
    const job = jobById.get(application.jobId.toString())
    if (!job) return 'Deleted job'
    return job.departmentId
      ? departmentNameById.get(job.departmentId.toString()) ?? 'Department unavailable'
      : 'Department unavailable'
  }

  const rows: unknown[][] = []
  for (const candidate of candidates) {
    const candidateApplications = applicationsByCandidate.get(candidate._id.toString()) ?? [null]
    for (const application of candidateApplications) {
      rows.push([
        candidate._id,
        candidate.name,
        candidate.email,
        candidate.phone,
        candidate.source,
        candidate.resumeFileName,
        application ? titleByJob.get(application.jobId.toString()) ?? 'Deleted job' : '',
        departmentNameForApplication(application),
        application?.stage,
        application?.decisionNote,
        candidate.createdAt,
        application?.updatedAt ?? candidate.updatedAt,
      ])
    }
  }
  return [COLUMNS.map(safeCell).join(','), ...rows.map((row) => row.map(safeCell).join(','))].join(
    '\r\n',
  )
}

export const __workspaceCsv = { safeCell }
