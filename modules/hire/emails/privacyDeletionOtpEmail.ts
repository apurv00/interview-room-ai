function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export function buildHirePrivacyDeletionOtpEmail(input: {
  code: string
  candidateName?: string
  expiryMinutes: number
}): { subject: string; html: string; text: string } {
  const greeting = input.candidateName
    ? `Hi ${escapeHtml(input.candidateName)},`
    : 'Hello,'
  return {
    subject: 'Confirm your IPG Hire data deletion request',
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.55;color:#0f172a;max-width:560px;margin:auto">
        <p>${greeting}</p>
        <p>Use this one-time code to confirm your request to delete candidate data held in IPG Hire:</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:8px;margin:24px 0">${escapeHtml(input.code)}</p>
        <p>This code expires in ${input.expiryMinutes} minutes. If you did not request deletion, ignore this email.</p>
      </div>
    `,
    text: [
      input.candidateName ? `Hi ${input.candidateName},` : 'Hello,',
      '',
      'Use this one-time code to confirm your request to delete candidate data held in IPG Hire:',
      '',
      input.code,
      '',
      `This code expires in ${input.expiryMinutes} minutes. If you did not request deletion, ignore this email.`,
    ].join('\n'),
  }
}
