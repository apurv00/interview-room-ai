'use client'

import Link from 'next/link'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'
import {
  CANDIDATE_STAGE_LABEL,
  CANDIDATE_STAGES,
  RECRUITER_DECISION_LABEL,
  type CandidateColumn,
  type CandidateListRow,
  type CandidateSort,
  type CandidateStage,
} from './candidateWorkspaceTypes'

interface CandidatePresentationProps {
  rows: CandidateListRow[]
  stageCounts: Record<CandidateStage, number> | null
  selectedIds: Set<string>
  visibleColumns: Set<CandidateColumn>
  currentSort: CandidateSort
  currentDirection: 'asc' | 'desc'
  returnTo: string
  jobOpen: boolean
  busyApplicationId: string | null
  onSelect: (applicationId: string, selected: boolean) => void
  onSelectPage: (selected: boolean) => void
  onSort: (sort: CandidateSort) => void
  onStageAction: (
    row: CandidateListRow,
    action: 'advance' | 'reject' | 'withdraw' | 'offer_declined',
    trigger?: HTMLElement,
  ) => void
}

const HUMAN_RECOMMENDATION_LABELS: Record<string, string> = {
  strongYes: 'strong yes',
  strong_yes: 'strong yes',
  yes: 'yes',
  no: 'no',
  strongNo: 'strong no',
  strong_no: 'strong no',
}

function candidateHref(row: CandidateListRow, returnTo: string): string {
  const query = new URLSearchParams({ returnTo })
  return `/workspace/applications/${encodeURIComponent(row.applicationId)}?${query}`
}

function dateLabel(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) return 'Unavailable'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(parsed)
}

function attentionLabel(row: CandidateListRow): string {
  return row.attention.length > 0
    ? row.attention.map((item) => item.replaceAll('_', ' ')).join(' · ')
    : 'No action needed'
}

function sourceHistoryLabel(row: CandidateListRow): string {
  const sources = row.sourceHistory.length > 0 ? row.sourceHistory : row.source ? [row.source] : []
  if (sources.length === 0) return 'Unknown'
  return Array.from(new Set(sources)).map((source) => source.replaceAll('_', ' ')).join(' · ')
}

function JdMatch({ row }: { row: CandidateListRow }) {
  const match = row.jdMatch
  if (match.state === 'fresh' && match.score !== null) {
    return (
      <div className="space-y-1">
        <Badge variant="success">{match.score} match</Badge>
        <p className="text-xs text-[#536471]">
          {match.rank === null || match.denominator <= 0 ? 'Freshly scored' : `Rank #${match.rank} of ${match.denominator}`}
        </p>
      </div>
    )
  }
  if (match.state === 'stale') return <Badge variant="caution">Needs refresh</Badge>
  if (match.state === 'pending') return <Badge variant="primary">Scoring pending</Badge>
  return <Badge>Unscored</Badge>
}

function HumanReview({ row }: { row: CandidateListRow }) {
  const review = row.humanReview
  if (review.state === 'none') return <span className="text-sm text-[#71767b]">Not requested</span>
  const recommendationSummary = Object.entries(review.recommendations)
    .filter(([, count]) => count > 0)
    .map(([recommendation, count]) => `${count} ${HUMAN_RECOMMENDATION_LABELS[recommendation] ?? recommendation.replaceAll('_', ' ')}`)
    .join(' · ')
  return (
    <div>
      <p className="text-sm font-medium text-[#0f1419]">
        {recommendationSummary || `${review.submitted} submitted`}
      </p>
      <p className="text-xs text-[#536471]">
        {review.submitted} submitted{review.pending > 0 ? ` · ${review.pending} pending` : ''}
        {review.disagreement ? ' · reviewers differ' : ''}
      </p>
    </div>
  )
}

function AiInterview({ row }: { row: CandidateListRow }) {
  const interview = row.aiInterview
  const label = interview.state.replaceAll('_', ' ')
  return (
    <div>
      <p className="text-sm capitalize text-[#0f1419]">{label}</p>
      {interview.score !== null ? (
        <p className="text-xs text-[#536471]">Supporting score {interview.score}</p>
      ) : null}
    </div>
  )
}

const CARD_DETAIL_COLUMNS: CandidateColumn[] = [
  'attention',
  'jdMatch',
  'humanReview',
  'aiInterview',
  'source',
  'appliedAt',
  'lastActivity',
  'history',
]

function CandidateCardDetails({
  row,
  visibleColumns,
}: {
  row: CandidateListRow
  visibleColumns: Set<CandidateColumn>
}) {
  if (!CARD_DETAIL_COLUMNS.some((column) => visibleColumns.has(column))) return null
  return (
    <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
      {visibleColumns.has('attention') ? <div><dt className="text-xs text-[#71767b]">Attention</dt><dd className="mt-1 text-[#9a6700]">{attentionLabel(row)}</dd></div> : null}
      {visibleColumns.has('jdMatch') ? <div><dt className="text-xs text-[#71767b]">JD match</dt><dd className="mt-1"><JdMatch row={row} /></dd></div> : null}
      {visibleColumns.has('humanReview') ? <div><dt className="text-xs text-[#71767b]">Human review</dt><dd className="mt-1"><HumanReview row={row} /></dd></div> : null}
      {visibleColumns.has('aiInterview') ? <div><dt className="text-xs text-[#71767b]">AI interview</dt><dd className="mt-1"><AiInterview row={row} /></dd></div> : null}
      {visibleColumns.has('source') ? <div><dt className="text-xs text-[#71767b]">Candidate sources</dt><dd className="mt-1 capitalize text-[#0f1419]">{sourceHistoryLabel(row)}</dd></div> : null}
      {visibleColumns.has('appliedAt') ? <div><dt className="text-xs text-[#71767b]">Applied</dt><dd className="mt-1 text-[#0f1419]">{dateLabel(row.appliedAt)}</dd></div> : null}
      {visibleColumns.has('lastActivity') ? <div><dt className="text-xs text-[#71767b]">Last activity</dt><dd className="mt-1 text-[#0f1419]">{dateLabel(row.lastActivityAt)}</dd></div> : null}
      {visibleColumns.has('history') ? (
        <div>
          <dt className="text-xs text-[#71767b]">Workspace history</dt>
          <dd className="mt-1 text-[#0f1419]">{row.workspaceHistory.previousApplications > 0 ? `${row.workspaceHistory.previousApplications} previous job${row.workspaceHistory.previousApplications === 1 ? '' : 's'}` : 'First seen here'}</dd>
        </div>
      ) : null}
    </dl>
  )
}

function SortHeader({
  label,
  sort,
  currentSort,
  currentDirection,
  onSort,
}: {
  label: string
  sort: CandidateSort
  currentSort: CandidateSort
  currentDirection: 'asc' | 'desc'
  onSort: (sort: CandidateSort) => void
}) {
  const active = sort === currentSort
  return (
    <th
      scope="col"
      aria-sort={active ? (currentDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
      className="whitespace-nowrap px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-[#536471]"
    >
      <button
        type="button"
        className="rounded-sm hover:text-[#0f1419] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        onClick={() => onSort(sort)}
      >
        {label}{active ? <span aria-hidden="true"> {currentDirection === 'asc' ? '↑' : '↓'}</span> : null}
      </button>
    </th>
  )
}

function RowActions({
  row,
  jobOpen,
  busy,
  returnTo,
  onStageAction,
}: {
  row: CandidateListRow
  jobOpen: boolean
  busy: boolean
  returnTo: string
  onStageAction: CandidatePresentationProps['onStageAction']
}) {
  const terminal = ['hired', 'rejected', 'withdrawn'].includes(row.stage)
  return (
    <div className="flex items-center justify-end gap-2">
      <Link
        href={candidateHref(row, returnTo)}
        className="whitespace-nowrap text-sm font-medium text-[#2563eb] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        View details
      </Link>
      {jobOpen && !terminal ? (
        <details className="relative">
          <summary className="cursor-pointer list-none rounded-lg border border-[#dbe4ea] px-2.5 py-1.5 text-sm font-medium text-[#0f1419] hover:bg-[#f8fafc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
            <span aria-hidden="true">Actions</span><span className="sr-only">Actions for {row.name}</span>
          </summary>
          <div className="absolute right-0 z-20 mt-1 w-44 space-y-1 rounded-xl border border-[#dbe4ea] bg-white p-2 shadow-lg">
            {row.stage !== 'offer' ? (
              <button
                type="button"
                data-stage-action={`${row.applicationId}:advance`}
                disabled={busy}
                onClick={(event) => onStageAction(row, 'advance', event.currentTarget)}
                className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[#f8fafc] disabled:opacity-50"
              >
                Advance one stage
              </button>
            ) : (
              <button
                type="button"
                data-stage-action={`${row.applicationId}:offer_declined`}
                disabled={busy}
                onClick={(event) => onStageAction(row, 'offer_declined', event.currentTarget)}
                className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[#f8fafc] disabled:opacity-50"
              >
                Record offer declined
              </button>
            )}
            {row.stage !== 'offer' ? (
              <button
                type="button"
                data-stage-action={`${row.applicationId}:reject`}
                disabled={busy}
                onClick={(event) => onStageAction(row, 'reject', event.currentTarget)}
                className="block w-full rounded-lg px-3 py-2 text-left text-sm text-[#b91c1c] hover:bg-red-50 disabled:opacity-50"
              >
                Reject…
              </button>
            ) : null}
            <button
              type="button"
              data-stage-action={`${row.applicationId}:withdraw`}
              disabled={busy}
              onClick={(event) => onStageAction(row, 'withdraw', event.currentTarget)}
              className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[#f8fafc] disabled:opacity-50"
            >
              Mark withdrawn…
            </button>
          </div>
        </details>
      ) : null}
    </div>
  )
}

export function CandidateTable(props: CandidatePresentationProps) {
  const {
    rows,
    selectedIds,
    visibleColumns,
    currentSort,
    currentDirection,
    returnTo,
    jobOpen,
    busyApplicationId,
    onSelect,
    onSelectPage,
    onSort,
    onStageAction,
  } = props
  const pageSelected = rows.length > 0 && rows.every((row) => selectedIds.has(row.applicationId))
  const partiallySelected = !pageSelected && rows.some((row) => selectedIds.has(row.applicationId))

  return (
    <>
      <div className="hidden overflow-x-auto rounded-2xl border border-[#dbe4ea] bg-white md:block">
        <table className="w-full min-w-[980px] border-collapse">
          <caption className="sr-only">Candidates for this job</caption>
          <thead className="border-b border-[#dbe4ea] bg-[#f8fafc]">
            <tr>
              <th scope="col" className="w-10 px-3 py-3 text-left">
                <input
                  type="checkbox"
                  checked={pageSelected}
                  ref={(node) => { if (node) node.indeterminate = partiallySelected }}
                  onChange={(event) => onSelectPage(event.target.checked)}
                  aria-label="Select every candidate on this page"
                />
              </th>
              <SortHeader label="Candidate" sort="name" currentSort={currentSort} currentDirection={currentDirection} onSort={onSort} />
              <SortHeader label={RECRUITER_DECISION_LABEL} sort="stage" currentSort={currentSort} currentDirection={currentDirection} onSort={onSort} />
              {visibleColumns.has('attention') ? <SortHeader label="Attention" sort="attention" currentSort={currentSort} currentDirection={currentDirection} onSort={onSort} /> : null}
              {visibleColumns.has('jdMatch') ? <SortHeader label="JD match" sort={currentSort === 'rank' ? 'rank' : 'jd_match'} currentSort={currentSort} currentDirection={currentDirection} onSort={onSort} /> : null}
              {visibleColumns.has('humanReview') ? <SortHeader label="Human review" sort="human_review" currentSort={currentSort} currentDirection={currentDirection} onSort={onSort} /> : null}
              {visibleColumns.has('aiInterview') ? <th scope="col" className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-[#536471]">AI interview</th> : null}
              {visibleColumns.has('source') ? <th scope="col" className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-[#536471]">Candidate sources</th> : null}
              {visibleColumns.has('appliedAt') ? <SortHeader label="Applied" sort={currentSort === 'oldest' ? 'oldest' : 'newest'} currentSort={currentSort} currentDirection={currentDirection} onSort={onSort} /> : null}
              {visibleColumns.has('lastActivity') ? <SortHeader label="Last activity" sort="last_activity" currentSort={currentSort} currentDirection={currentDirection} onSort={onSort} /> : null}
              {visibleColumns.has('history') ? <th scope="col" className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-[#536471]">History</th> : null}
              <th scope="col" className="px-3 py-3 text-right text-xs font-semibold uppercase tracking-wide text-[#536471]">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#e6ecf0]">
            {rows.map((row) => (
              <tr key={row.applicationId} className="align-top hover:bg-[#fbfdff]">
                <td className="px-3 py-4">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(row.applicationId)}
                    onChange={(event) => onSelect(row.applicationId, event.target.checked)}
                    aria-label={`Select ${row.name}`}
                  />
                </td>
                <th scope="row" className="px-3 py-4 text-left font-normal">
                  <Link href={candidateHref(row, returnTo)} className="font-semibold text-[#0f1419] hover:text-[#2563eb] hover:underline">
                    {row.name}
                  </Link>
                  {row.email ? <p className="mt-0.5 max-w-[220px] truncate text-xs text-[#71767b]">{row.email}</p> : null}
                </th>
                <td className="px-3 py-4"><Badge>{CANDIDATE_STAGE_LABEL[row.stage]}</Badge></td>
                {visibleColumns.has('attention') ? <td className="max-w-[220px] px-3 py-4 text-sm text-[#536471]">{attentionLabel(row)}</td> : null}
                {visibleColumns.has('jdMatch') ? <td className="px-3 py-4"><JdMatch row={row} /></td> : null}
                {visibleColumns.has('humanReview') ? <td className="px-3 py-4"><HumanReview row={row} /></td> : null}
                {visibleColumns.has('aiInterview') ? <td className="px-3 py-4"><AiInterview row={row} /></td> : null}
                {visibleColumns.has('source') ? <td className="px-3 py-4 text-sm capitalize text-[#536471]">{sourceHistoryLabel(row)}</td> : null}
                {visibleColumns.has('appliedAt') ? <td className="whitespace-nowrap px-3 py-4 text-sm text-[#536471]">{dateLabel(row.appliedAt)}</td> : null}
                {visibleColumns.has('lastActivity') ? <td className="whitespace-nowrap px-3 py-4 text-sm text-[#536471]">{dateLabel(row.lastActivityAt)}</td> : null}
                {visibleColumns.has('history') ? <td className="px-3 py-4 text-sm text-[#536471]">{row.workspaceHistory.previousApplications > 0 ? `${row.workspaceHistory.previousApplications} previous job${row.workspaceHistory.previousApplications === 1 ? '' : 's'}` : 'First seen here'}</td> : null}
                <td className="px-3 py-4">
                  <RowActions row={row} jobOpen={jobOpen} busy={busyApplicationId === row.applicationId} returnTo={returnTo} onStageAction={onStageAction} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-3 md:hidden" aria-label="Candidates for this job">
        {rows.map((row) => (
          <li key={row.applicationId} className="rounded-2xl border border-[#dbe4ea] bg-white p-4">
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={selectedIds.has(row.applicationId)}
                onChange={(event) => onSelect(row.applicationId, event.target.checked)}
                aria-label={`Select ${row.name}`}
                className="mt-1"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link href={candidateHref(row, returnTo)} className="block max-w-full break-words font-semibold text-[#0f1419] hover:text-[#2563eb] hover:underline">{row.name}</Link>
                    {row.email ? <p className="break-words text-xs text-[#71767b]">{row.email}</p> : null}
                  </div>
                </div>
                <div className="mt-3 rounded-xl border border-[#dbe4ea] bg-[#f8fafc] px-3 py-2">
                  <p className="text-xs font-medium text-[#536471]">{RECRUITER_DECISION_LABEL}</p>
                  <div className="mt-1"><Badge>{CANDIDATE_STAGE_LABEL[row.stage]}</Badge></div>
                </div>
                <CandidateCardDetails row={row} visibleColumns={visibleColumns} />
                <div className="mt-4 border-t border-[#e6ecf0] pt-3">
                  <RowActions row={row} jobOpen={jobOpen} busy={busyApplicationId === row.applicationId} returnTo={returnTo} onStageAction={onStageAction} />
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}

export function CandidateBoard(props: CandidatePresentationProps) {
  const groups = new Map<CandidateStage, CandidateListRow[]>()
  for (const stage of CANDIDATE_STAGES) groups.set(stage, [])
  for (const row of props.rows) groups.get(row.stage)?.push(row)

  return (
    <div>
      <p className="mb-3 text-sm text-[#536471]">
        {props.stageCounts
          ? 'Showing only this bounded result page by stage. Stage totals describe all candidates in this job, independent of the current filters.'
          : 'Showing only this bounded result page by stage. Aggregate stage totals are temporarily unavailable.'}
      </p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Candidate stage board">
        {CANDIDATE_STAGES.map((stage) => {
          const rows = groups.get(stage) ?? []
          if (rows.length === 0 && (props.stageCounts?.[stage] ?? 0) === 0) return null
          return (
            <section key={stage} aria-labelledby={`candidate-stage-${stage}`} className="min-w-0 rounded-2xl bg-[#f3f6f8] p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-[#71767b]">{RECRUITER_DECISION_LABEL}</p>
                  <h2 id={`candidate-stage-${stage}`} className="text-sm font-semibold text-[#0f1419]">{CANDIDATE_STAGE_LABEL[stage]}</h2>
                </div>
                <span className="text-xs text-[#536471]">
                  {rows.length} shown · {props.stageCounts ? `${props.stageCounts[stage]} job total` : 'totals unavailable'}
                </span>
              </div>
              {rows.length === 0 ? <p className="rounded-xl border border-dashed border-[#cfd9df] p-3 text-xs text-[#71767b]">No candidates from this page.</p> : null}
              <ul className="space-y-2">
                {rows.map((row) => (
                  <li key={row.applicationId} className="rounded-xl border border-[#dbe4ea] bg-white p-3 shadow-sm">
                    <label className="flex items-start gap-2">
                      <input type="checkbox" className="mt-1" aria-label={`Select ${row.name}`} checked={props.selectedIds.has(row.applicationId)} onChange={(event) => props.onSelect(row.applicationId, event.target.checked)} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-[#0f1419]">{row.name}</span>
                      </span>
                    </label>
                    <CandidateCardDetails row={row} visibleColumns={props.visibleColumns} />
                    <div className="mt-3 border-t border-[#e6ecf0] pt-3">
                      <RowActions row={row} jobOpen={props.jobOpen} busy={props.busyApplicationId === row.applicationId} returnTo={props.returnTo} onStageAction={props.onStageAction} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}
