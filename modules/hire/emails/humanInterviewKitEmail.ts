import { escapeHtml } from '@shared/services/emailTemplates/htmlEscape'

/**
 * Pure Phase 3 interviewer-kit email. A kit is intentionally not an account
 * invitation: it carries a possession link to a brief and one fixed
 * scorecard, while the actual meeting remains in the team's normal tool.
 */
export interface HumanInterviewKitEmailParams {
  purpose: 'initial' | 'reminder'
  interviewerName: string
  workspaceName: string
  jobTitle: string
  kitUrl: string
  expiryDays: number
}

export function buildHumanInterviewKitEmail(
  params: HumanInterviewKitEmailParams,
): { subject: string; html: string; text: string } {
  const interviewer = escapeHtml(params.interviewerName.split(' ')[0] || 'there')
  const workspace = escapeHtml(params.workspaceName)
  const job = escapeHtml(params.jobTitle)
  const kitUrl = escapeHtml(params.kitUrl)
  const reminder = params.purpose === 'reminder'
  const subject = reminder
    ? `${params.workspaceName}: reminder to submit your ${params.jobTitle} scorecard`
    : `${params.workspaceName}: interview kit for ${params.jobTitle}`
  const intro = reminder
    ? 'A scorecard is still waiting after your interview. Your feedback helps the hiring team make a fair decision.'
    : 'You have been asked to interview a candidate. Use your usual meeting tool, then record your feedback in the short scorecard.'

  return {
    subject,
    html: `
<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#172033;">
  <h2 style="margin:0 0 16px;">Hi ${interviewer},</h2>
  <p style="line-height:1.6;"><strong>${workspace}</strong> invited you to help interview for the <strong>${job}</strong> role.</p>
  <p style="line-height:1.6;">${intro}</p>
  <p style="line-height:1.6;">No account or training is needed. This personal link shows a concise interview brief and four feedback prompts. Please do not forward it.</p>
  <p style="margin:28px 0;"><a href="${kitUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Open interview kit</a></p>
  <p style="line-height:1.6;color:#52606d;">The link expires in ${params.expiryDays} days. If the button does not work, copy this address into your browser:<br/><span style="word-break:break-all;">${kitUrl}</span></p>
</div>`.trim(),
    text: [
      `Hi ${params.interviewerName.split(' ')[0] || 'there'},`,
      '',
      `${params.workspaceName} invited you to help interview for the ${params.jobTitle} role.`,
      '',
      intro,
      'No account or training is needed. This personal link opens a concise interview brief and four feedback prompts. Please do not forward it.',
      '',
      `Open interview kit: ${params.kitUrl}`,
      '',
      `This link expires in ${params.expiryDays} days.`,
    ].join('\n'),
  }
}
