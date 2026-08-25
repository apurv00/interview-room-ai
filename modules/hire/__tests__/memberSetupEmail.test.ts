import { describe, expect, it } from 'vitest'
import { buildMemberSetupEmail } from '../emails/memberSetupEmail'

describe('Hire member setup email', () => {
  it('uses the readable company workspace and never prints the internal id', () => {
    const internalWorkspaceId = '111111111111111111111111'
    const email = buildMemberSetupEmail({
      memberName: 'Avery Example',
      workspaceName: 'Acme & Partners',
      workspaceSignInSlug: 'acme-partners',
      setupUrl: `https://hire.example/hire-signin#setup=${internalWorkspaceId}.secret`,
      expiryHours: 24,
    })

    expect(email.html).toContain('company workspace is <strong>acme-partners</strong>')
    expect(email.text).toContain('company workspace is acme-partners')
    expect(email.html).not.toContain('workspace sign-in ID')
    expect(email.text).not.toContain('workspace sign-in ID')
  })
})
