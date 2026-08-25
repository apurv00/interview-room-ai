import { escapeHtml } from '@shared/services/emailTemplates/htmlEscape'

export interface MemberSetupEmailParams {
  memberName: string
  workspaceName: string
  workspaceSignInSlug: string
  setupUrl: string
  expiryHours: number
}

export function buildMemberSetupEmail(params: MemberSetupEmailParams) {
  const name = escapeHtml(params.memberName.split(' ')[0] || params.memberName)
  const workspace = escapeHtml(params.workspaceName)
  const workspaceSignInSlug = escapeHtml(params.workspaceSignInSlug)
  const url = escapeHtml(params.setupUrl)
  return {
    subject: `Set your IPG Hire password for ${params.workspaceName}`,
    html: `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a2e">
  <h2 style="margin:0 0 16px">Hi ${name},</h2>
  <p style="line-height:1.6">You have been added directly to the <strong>${workspace}</strong> hiring workspace. Your membership is already provisioned; set a password to sign in for the first time.</p>
  <p style="line-height:1.6">Your company workspace is <strong>${workspaceSignInSlug}</strong>. Save it with your normal password-manager entry; it identifies the company but is not a password.</p>
  <p style="margin:28px 0"><a href="${url}" style="background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Set password</a></p>
  <p style="line-height:1.6;color:#555">This one-time credential link expires in ${params.expiryHours} hours. If the button does not work, copy this address into your browser:<br><span style="word-break:break-all">${url}</span></p>
</div>`.trim(),
    text: `Hi ${params.memberName},\n\nYou have been added directly to ${params.workspaceName}. Your company workspace is ${params.workspaceSignInSlug}. Set your password here: ${params.setupUrl}\n\nThis one-time link expires in ${params.expiryHours} hours.`,
  }
}
