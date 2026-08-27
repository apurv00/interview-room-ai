import Link from 'next/link'
import Badge from '@shared/ui/Badge'

export type JobWorkspaceStatus = 'open' | 'on_hold' | 'closed'

interface JobWorkspaceHeaderProps {
  title: string
  status: JobWorkspaceStatus
  departmentName?: string | null
  candidateCount?: number | null
  actions?: React.ReactNode
}

const STATUS_LABEL: Record<JobWorkspaceStatus, string> = {
  open: 'Open',
  on_hold: 'On hold',
  closed: 'Closed',
}

export default function JobWorkspaceHeader({
  title,
  status,
  departmentName,
  candidateCount,
  actions,
}: JobWorkspaceHeaderProps) {
  return (
    <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0 max-w-full flex-1">
        <Link
          href="/workspace/jobs"
          className="text-xs font-medium text-[#71767b] hover:text-[#2563eb] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          ← All jobs
        </Link>
        <div className="mt-1 flex min-w-0 max-w-full flex-wrap items-center gap-2">
          <h1 className="min-w-0 max-w-full break-words text-xl font-bold text-[#0f1419]">{title}</h1>
          <Badge variant={status === 'open' ? 'success' : status === 'on_hold' ? 'caution' : 'default'}>
            {STATUS_LABEL[status]}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-[#536471]">
          {departmentName ? <span>{departmentName}</span> : null}
          {departmentName && typeof candidateCount === 'number' ? <span aria-hidden="true"> · </span> : null}
          {typeof candidateCount === 'number' ? (
            <span>{candidateCount.toLocaleString()} candidate{candidateCount === 1 ? '' : 's'}</span>
          ) : null}
        </p>
      </div>
      {actions ? (
        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:justify-end" aria-label="Job actions">
          {actions}
        </div>
      ) : null}
    </header>
  )
}
