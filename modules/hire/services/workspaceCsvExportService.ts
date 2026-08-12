import { HireApplication, HireCandidate, HireJob } from '../models'
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
    HireJob.find({ workspaceId }).select('_id title').lean(),
  ])
  const applicationsByCandidate = new Map<string, typeof applications>()
  for (const application of applications) {
    const key = application.candidateId.toString()
    const rows = applicationsByCandidate.get(key) ?? []
    rows.push(application)
    applicationsByCandidate.set(key, rows)
  }
  const titleByJob = new Map(jobs.map((job) => [job._id.toString(), job.title]))

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
