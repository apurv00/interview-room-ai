import React from 'react'
import type {
  HireDecisionDimensionAggregate,
  HireDecisionView,
  HireRecommendationTally,
} from '../types'

export interface HireAssessmentReportProps {
  decision: HireDecisionView
  /** PDF and member views share the same safe evidence component. */
  compact?: boolean
}

const RECOMMENDATION_LABELS: Record<keyof HireRecommendationTally, string> = {
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

function displayMean(value: number | null): string {
  return value === null ? '—' : value.toFixed(1)
}

function RecommendationTally({ tally }: { tally: HireRecommendationTally }) {
  return (
    <dl className="hire-assessment-tally">
      {(Object.keys(RECOMMENDATION_LABELS) as Array<keyof HireRecommendationTally>).map((key) => (
        <div key={key}>
          <dt>{RECOMMENDATION_LABELS[key]}</dt>
          <dd>{tally[key]}</dd>
        </div>
      ))}
    </dl>
  )
}

function DimensionTable({ dimensions }: { dimensions: HireDecisionDimensionAggregate[] }) {
  return (
    <table className="hire-assessment-dimensions">
      <thead>
        <tr>
          <th scope="col">Dimension</th>
          <th scope="col">Reviews</th>
          <th scope="col">Average</th>
          <th scope="col">Range</th>
        </tr>
      </thead>
      <tbody>
        {dimensions.map((dimension) => (
          <tr key={dimension.key}>
            <th scope="row">{dimension.key.replace(/_/g, ' ')}</th>
            <td>{dimension.count}</td>
            <td>{displayMean(dimension.mean)}</td>
            <td>
              {dimension.min === null || dimension.max === null
                ? '—'
                : `${dimension.min}–${dimension.max}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * A deliberately narrow evidence presentation. It accepts only the Phase-4
 * decision DTO—not Mongoose documents—so it cannot render contact details,
 * resumes, recordings, private reviewer text, rankings, or audit records.
 */
export function HireAssessmentReport({ decision, compact = false }: HireAssessmentReportProps) {
  const { candidateBrief, aiAssessments, humanScorecards, externalVerdicts } = decision
  return (
    <article className={compact ? 'hire-assessment-report hire-assessment-report-compact' : 'hire-assessment-report'}>
      <header>
        <p className="hire-assessment-eyebrow">Candidate assessment</p>
        <h1>{candidateBrief.candidateName}</h1>
        <p className="hire-assessment-role">{candidateBrief.jobTitle}</p>
        {(candidateBrief.location || candidateBrief.experienceYears !== undefined) && (
          <p className="hire-assessment-meta">
            {[candidateBrief.location, candidateBrief.experienceYears !== undefined
              ? `${candidateBrief.experienceYears} years’ experience`
              : undefined]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
      </header>

      <section aria-labelledby="human-evidence-heading">
        <h2 id="human-evidence-heading">Human scorecards</h2>
        <p className="hire-assessment-supporting">
          {humanScorecards.total.count} submitted · {humanScorecards.member.count} member · {humanScorecards.kit.count} guest-kit
        </p>
        <RecommendationTally tally={humanScorecards.total.recommendations} />
        <DimensionTable dimensions={humanScorecards.total.dimensions} />
      </section>

      <section aria-labelledby="external-evidence-heading">
        <h2 id="external-evidence-heading">External verdicts</h2>
        <p className="hire-assessment-supporting">
          {externalVerdicts.count} submitted. External verdicts are intentionally not blended into scorecard averages.
        </p>
        <RecommendationTally tally={externalVerdicts.recommendations} />
      </section>

      <section aria-labelledby="ai-evidence-heading">
        <h2 id="ai-evidence-heading">AI assessments</h2>
        {aiAssessments.length === 0 ? (
          <p className="hire-assessment-supporting">No completed AI assessment is available.</p>
        ) : (
          <ol className="hire-assessment-ai-list">
            {aiAssessments.map((assessment, index) => (
              <li key={`${assessment.completedAt.toISOString()}-${index}`}>
                <div>
                  <strong>Assessment {index + 1}</strong>
                  <span>{displayDate(assessment.completedAt)}</span>
                </div>
                <p>
                  Overall score: {assessment.overallScore ?? '—'}
                  {assessment.recommendation ? ` · ${assessment.recommendation}` : ''}
                  {assessment.confidence ? ` · ${assessment.confidence} confidence` : ''}
                </p>
                {assessment.dimensions.length > 0 && (
                  <ul>
                    {assessment.dimensions.map((dimension) => (
                      <li key={dimension.key}>
                        {dimension.label ?? dimension.key}: {dimension.score ?? '—'}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer>
        <p>
          This assessment presents evidence for a human decision. It does not make or recommend a pipeline-stage change.
        </p>
      </footer>
    </article>
  )
}
