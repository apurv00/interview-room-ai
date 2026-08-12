import { escapeHtml } from '@shared/services/emailTemplates/htmlEscape'

export interface JobCloseRejectionEmailParams {
  candidateName: string
  jobTitle: string
  workspaceName: string
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/**
 * Candidate-safe close notification. The recruiter's internal close note is
 * intentionally not an input: it is audit evidence, not candidate-facing
 * copy, and may mention the selected candidate or other private context.
 */
export function buildJobCloseRejectionEmail(params: JobCloseRejectionEmailParams): {
  subject: string
  html: string
  text: string
} {
  const candidateFirstName = singleLine(params.candidateName).split(/\s+/)[0] || 'there'
  const subject = `${singleLine(params.workspaceName)}: update on your ${singleLine(params.jobTitle)} application`
  const nameHtml = escapeHtml(candidateFirstName)
  const jobHtml = escapeHtml(params.jobTitle)
  const workspaceHtml = escapeHtml(params.workspaceName)

  const html = `
<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a2e;">
  <h2 style="margin: 0 0 16px;">Hi ${nameHtml},</h2>
  <p style="line-height: 1.6;">
    Thank you for the time and care you put into your application for the
    <strong>${jobHtml}</strong> position at <strong>${workspaceHtml}</strong>.
  </p>
  <p style="line-height: 1.6;">
    This position has now closed, and we won&rsquo;t be progressing your
    application further. We appreciate your interest and wish you the best in
    your search.
  </p>
</div>`.trim()

  const text = [
    `Hi ${candidateFirstName},`,
    '',
    `Thank you for the time and care you put into your application for the ${params.jobTitle} position at ${params.workspaceName}.`,
    '',
    'This position has now closed, and we will not be progressing your application further. We appreciate your interest and wish you the best in your search.',
  ].join('\n')

  return { subject, html, text }
}
