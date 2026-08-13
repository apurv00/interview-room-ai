import { escapeHtml } from '@shared/services/emailTemplates/htmlEscape'

export interface JobReengagementEmailParams {
  candidateName: string
  jobTitle: string
  workspaceName: string
  optOutUrl: string
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/**
 * A transparent, recruiter-triggered invitation to be considered again.
 * It never promises an interview or a job, and exposes a one-click,
 * Hire-only unsubscribe route rather than an account or B2C preference page.
 */
export function buildJobReengagementEmail(params: JobReengagementEmailParams): {
  subject: string
  html: string
  text: string
} {
  const candidateFirstName = singleLine(params.candidateName).split(/\s+/)[0] || 'there'
  const subject = `${singleLine(params.workspaceName)}: an opportunity for ${singleLine(params.jobTitle)}`
  const nameHtml = escapeHtml(candidateFirstName)
  const jobHtml = escapeHtml(params.jobTitle)
  const workspaceHtml = escapeHtml(params.workspaceName)
  const optOutHtml = escapeHtml(params.optOutUrl)

  const html = `
<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a2e;">
  <h2 style="margin: 0 0 16px;">Hi ${nameHtml},</h2>
  <p style="line-height: 1.6;">
    You previously connected with <strong>${workspaceHtml}</strong>. A member
    of the hiring team thinks your background may be relevant to the
    <strong>${jobHtml}</strong> role and has added you for consideration.
  </p>
  <p style="line-height: 1.6;">
    There is nothing you need to do now. If the team decides to progress,
    they will contact you with the next step.
  </p>
  <p style="line-height: 1.6; color: #555;">
    Do not want future talent-pool re-engagement emails from this hiring
    workspace? <a href="${optOutHtml}">Opt out here</a>.
  </p>
</div>`.trim()

  const text = [
    `Hi ${candidateFirstName},`,
    '',
    `You previously connected with ${params.workspaceName}. A member of the hiring team thinks your background may be relevant to the ${params.jobTitle} role and has added you for consideration.`,
    '',
    'There is nothing you need to do now. If the team decides to progress, they will contact you with the next step.',
    '',
    `Opt out of future talent-pool re-engagement emails from this hiring workspace: ${params.optOutUrl}`,
  ].join('\n')

  return { subject, html, text }
}
