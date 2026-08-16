import React from 'react'
import {
  HIRE_REPORT_RECOMMENDATIONS,
  type HirePipelineStatusReportSnapshot,
  type HireReportEvidenceSummary,
  type HireReportRecommendationTally,
} from '../types'
import {
  formatHireReportBlocker,
  formatHireReportStage,
} from '../services/reportSnapshotBuilders'

export interface HirePipelineStatusReportProps {
  /** Only the immutable report snapshot is renderable; no live documents enter this component. */
  snapshot: HirePipelineStatusReportSnapshot
  compact?: boolean
}

const RECOMMENDATION_LABELS: Record<keyof HireReportRecommendationTally, string> = {
  strong_yes: 'Strong yes',
  yes: 'Yes',
  no: 'No',
  strong_no: 'Strong no',
}

function displayDate(value: Date): string {
  return new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(value)
}

function RecommendationTally({ tally }: { tally: HireReportRecommendationTally }) {
  return (
    <dl className="hire-report-recommendation-tally">
      {HIRE_REPORT_RECOMMENDATIONS.map((recommendation) => (
        <div key={recommendation}>
          <dt>{RECOMMENDATION_LABELS[recommendation]}</dt>
          <dd>{tally[recommendation]}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Evidence source totals are intentionally presented in separate blocks. */
function EvidenceSummary({ evidence }: { evidence: HireReportEvidenceSummary }) {
  return (
    <section className="hire-report-evidence" aria-label="Evidence summary">
      <h3>Evidence summary</h3>
      <p>{evidence.aiAssessments.completedCount} completed AI assessments</p>
      <div>
        <h4>Member scorecards</h4>
        <p>{evidence.humanScorecards.member.submittedCount} submitted</p>
        <RecommendationTally tally={evidence.humanScorecards.member.recommendations} />
      </div>
      <div>
        <h4>Guest-kit scorecards</h4>
        <p>{evidence.humanScorecards.kit.submittedCount} submitted</p>
        <RecommendationTally tally={evidence.humanScorecards.kit.recommendations} />
      </div>
      <div>
        <h4>External verdicts</h4>
        <p>{evidence.externalVerdicts.submittedCount} submitted</p>
        <RecommendationTally tally={evidence.externalVerdicts.recommendations} />
      </div>
    </section>
  )
}

/**
 * Shared PDF/screen-safe pipeline presentation. It accepts only the frozen
 * aggregate snapshot and intentionally has no candidate ranking or action.
 */
export function HirePipelineStatusReport({ snapshot, compact = false }: HirePipelineStatusReportProps) {
  return (
    <article className={compact ? 'hire-pipeline-report hire-pipeline-report-compact' : 'hire-pipeline-report'}>
      <header>
        <p className="hire-report-eyebrow">Pipeline status report</p>
        <h1>{snapshot.scope === 'job' ? 'Job pipeline status' : 'Workspace pipeline status'}</h1>
        <p>As of {displayDate(snapshot.asOf)}</p>
      </header>

      {snapshot.jobs.map((job, index) => (
        <section key={`${job.jobTitle}-${job.openedAt.toISOString()}-${index}`} className="hire-report-job">
          <header>
            <h2>{job.department ? `${job.jobTitle} — Department: ${job.department.name}` : job.jobTitle}</h2>
            <p>{job.jobStatus.replace(/_/g, ' ')} - Opened {displayDate(job.openedAt)}</p>
          </header>

          <section aria-label={`${job.jobTitle} stage counts`}>
            <h3>Stage counts</h3>
            <table>
              <thead>
                <tr>
                  <th scope="col">Stage</th>
                  <th scope="col">Candidates</th>
                </tr>
              </thead>
              <tbody>
                {job.stageCounts.map((entry) => (
                  <tr key={entry.stage}>
                    <th scope="row">{formatHireReportStage(entry.stage)}</th>
                    <td>{entry.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section aria-label={`${job.jobTitle} aging`}>
            <h3>Aging</h3>
            <ul>
              {job.aging.map((entry) => (
                <li key={entry.bucket}>{entry.bucket.replace(/_/g, ' ')}: {entry.count}</li>
              ))}
            </ul>
          </section>

          <section aria-label={`${job.jobTitle} blockers`}>
            <h3>Blockers</h3>
            <ul>
              {job.blockers.map((entry) => (
                <li key={entry.kind}>{formatHireReportBlocker(entry.kind)}: {entry.count}</li>
              ))}
            </ul>
          </section>

          <EvidenceSummary evidence={job.evidence} />
        </section>
      ))}

      <footer>
        <p>Evidence is displayed by source. This report does not produce a composite score or a hiring action.</p>
      </footer>
    </article>
  )
}
