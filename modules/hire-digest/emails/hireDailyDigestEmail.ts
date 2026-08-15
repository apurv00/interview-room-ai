import { escapeHtml } from '@shared/services/emailTemplates/htmlEscape'
import type { HireDigestPayload } from '../types'

/** Pure aggregate-only template. The link requires normal member authentication. */
export function buildHireDailyDigestEmail(input: {
  recipientName: string
  payload: HireDigestPayload
}): { subject: string; html: string; text: string } {
  const firstName = escapeHtml(input.recipientName.trim().split(/\s+/)[0] || 'there')
  const workspace = escapeHtml(input.payload.workspaceName)
  const overviewUrl = `${(process.env.HIRE_PUBLIC_URL || 'https://hire.interviewprep.guru').replace(/\/$/, '')}/workspace/overview`
  const safeUrl = escapeHtml(overviewUrl)
  const summary = [
    `${input.payload.openJobs} open job${input.payload.openJobs === 1 ? '' : 's'}`,
    `${input.payload.awaitingDecision} application${input.payload.awaitingDecision === 1 ? '' : 's'} awaiting a decision`,
    `${input.payload.pendingScorecards} pending scorecard${input.payload.pendingScorecards === 1 ? '' : 's'}`,
  ]
  const failureLine = input.payload.terminalKitDeliveryFailures > 0
    ? `${input.payload.terminalKitDeliveryFailures} interview-kit delivery issue${input.payload.terminalKitDeliveryFailures === 1 ? '' : 's'} need attention`
    : 'No terminal interview-kit delivery issues'

  return {
    subject: `${input.payload.workspaceName}: daily hiring summary`,
    html: `
<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#172033;">
  <h2 style="margin:0 0 16px;">Hi ${firstName},</h2>
  <p style="line-height:1.6;">Here is the daily hiring summary for <strong>${workspace}</strong>.</p>
  <ul style="line-height:1.7;padding-left:22px;">
    ${summary.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
    <li>${escapeHtml(failureLine)}</li>
  </ul>
  <p style="margin:28px 0;"><a href="${safeUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Open hiring overview</a></p>
  <p style="line-height:1.6;color:#52606d;">This message contains aggregate operational counts only. You can turn daily summaries off in your workspace overview.</p>
</div>`.trim(),
    text: [
      `Hi ${input.recipientName.trim().split(/\s+/)[0] || 'there'},`,
      '',
      `Here is the daily hiring summary for ${input.payload.workspaceName}.`,
      '',
      ...summary.map((item) => `- ${item}`),
      `- ${failureLine}`,
      '',
      `Open hiring overview: ${overviewUrl}`,
      '',
      'This message contains aggregate operational counts only. You can turn daily summaries off in your workspace overview.',
    ].join('\n'),
  }
}
