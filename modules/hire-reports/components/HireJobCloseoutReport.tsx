import React from 'react'
import {
  HIRE_REPORT_RECOMMENDATIONS,
  type HireJobCloseoutReportSnapshot,
  type HireReportEvidenceSummary,
  type HireReportRecommendationTally,
} from '../types'
import { formatHireReportStage } from '../services/reportSnapshotBuilders'

export interface HireJobCloseoutReportProps {
  /** Only the durable close-out snapshot is renderable; member/candidate records are not props. */
  snapshot: HireJobCloseoutReportSnapshot
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

function EvidenceSummary({ evidence }: { evidence: HireReportEvidenceSummary }) {
  return (
    <section className="hire-report-evidence" aria-label="Evidence summary">
      <h2>Evidence summary</h2>
      <p>{evidence.aiAssessments.completedCount} completed AI assessments</p>
      <div>
        <h3>Member scorecards</h3>
        <p>{evidence.humanScorecards.member.submittedCount} submitted</p>
        <RecommendationTally tally={evidence.humanScorecards.member.recommendations} />
      </div>
      <div>
        <h3>Guest-kit scorecards</h3>
        <p>{evidence.humanScorecards.kit.submittedCount} submitted</p>
        <RecommendationTally tally={evidence.humanScorecards.kit.recommendations} />
      </div>
      <div>
        <h3>External verdicts</h3>
        <p>{evidence.externalVerdicts.submittedCount} submitted</p>
        <RecommendationTally tally={evidence.externalVerdicts.recommendations} />
      </div>
    </section>
  )
}

/**
 * Shared PDF/screen-safe close-out presentation. The hired-candidate list is
 * an explicitly allowed internal disclosure, but contact data and IDs never
 * enter this component or the report snapshot.
 */
export function HireJobCloseoutReport({ snapshot, compact = false }: HireJobCloseoutReportProps) {
  return (
    <article className={compact ? 'hire-job-closeout-report hire-job-closeout-report-compact' : 'hire-job-closeout-report'}>
      <header>
        <p className="hire-report-eyebrow">Job close-out report</p>
        <h1>{snapshot.department ? `${snapshot.jobTitle} — Department: ${snapshot.department.name}` : snapshot.jobTitle}</h1>
        <p>
          Opened {displayDate(snapshot.openedAt)} - Closed {displayDate(snapshot.closedAt)} - {snapshot.timeToCloseHours} hours to close
        </p>
      </header>

      <section aria-labelledby="closeout-funnel-heading">
        <h2 id="closeout-funnel-heading">Funnel</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Candidates</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.stageCounts.map((entry) => (
              <tr key={entry.stage}>
                <th scope="row">{formatHireReportStage(entry.stage)}</th>
                <td>{entry.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="closeout-hires-heading">
        <h2 id="closeout-hires-heading">Hired candidates</h2>
        {snapshot.hiredCandidates.length === 0 ? (
          <p>No candidate was recorded as hired when this job closed.</p>
        ) : (
          <ul>
            {snapshot.hiredCandidates.map((candidate, index) => (
              <li key={`${candidate.candidateName}-${candidate.hiredAt.toISOString()}-${index}`}>
                {candidate.candidateName} - Hired {displayDate(candidate.hiredAt)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="closeout-decision-heading">
        <h2 id="closeout-decision-heading">Decision note</h2>
        <p>{snapshot.decisionNote}</p>
      </section>

      <EvidenceSummary evidence={snapshot.evidence} />

      <footer>
        <p>Evidence is shown by source. This report does not calculate a composite score or revise a pipeline decision.</p>
      </footer>
    </article>
  )
}
