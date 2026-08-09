
describe('secret-path redaction (URLs that ARE credentials)', () => {
  it('redacts the token segment of tokenized public routes', async () => {
    const { redactSecretPathSegments, redactSecretUrl } = await import('../track')
    const tok = 'a'.repeat(64)
    expect(redactSecretPathSegments(`/apply/${tok}`)).toBe('/apply/[redacted]')
    expect(redactSecretPathSegments(`/scorecard/${tok}`)).toBe('/scorecard/[redacted]')
    expect(redactSecretPathSegments('/candidate/64f0c1a2b3c4d5e6f7a8b9c0')).toBe(
      '/candidate/[redacted]',
    )
    // Deeper segments are kept — only the secret itself is removed.
    expect(redactSecretPathSegments(`/candidate/abc/prepare`)).toBe('/candidate/[redacted]/prepare')
  })

  it('leaves ordinary paths untouched', async () => {
    const { redactSecretPathSegments } = await import('../track')
    expect(redactSecretPathSegments('/interview/setup')).toBe('/interview/setup')
    expect(redactSecretPathSegments('/jobs/senior-engineer')).toBe('/jobs/senior-engineer')
    expect(redactSecretPathSegments('/apply')).toBe('/apply')
  })

  it('redacts inside a full URL while preserving origin and query', async () => {
    const { redactSecretUrl } = await import('../track')
    expect(redactSecretUrl('https://www.interviewprep.guru/apply/SECRETTOKEN?src=li')).toBe(
      'https://www.interviewprep.guru/apply/[redacted]?src=li',
    )
    expect(redactSecretUrl('not a url')).toBe('not a url')
  })
})
