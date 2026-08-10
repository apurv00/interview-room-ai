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

  it('removes candidate, member setup, and runtime handoff secrets from queries', async () => {
    const { redactSecretUrl } = await import('../track')
    const secrets = {
      token: 'candidate-token-secret',
      setup: 'member-setup-secret',
      code: 'runtime-handoff-secret',
    }
    const sanitized = redactSecretUrl(
      `https://hire.interviewprep.guru/pricing?token=${secrets.token}` +
        `&setup=${secrets.setup}&code=${secrets.code}&utm_source=invite#fragment-secret`,
    )
    const url = new URL(sanitized)

    expect(url.searchParams.get('token')).toBeNull()
    expect(url.searchParams.get('setup')).toBeNull()
    expect(url.searchParams.get('code')).toBeNull()
    expect(url.searchParams.get('utm_source')).toBe('invite')
    expect(url.hash).toBe('')
    expect(sanitized).not.toContain(secrets.token)
    expect(sanitized).not.toContain(secrets.setup)
    expect(sanitized).not.toContain(secrets.code)
    expect(sanitized).not.toContain('fragment-secret')
  })

  it('sanitizes a credential-bearing nested callback URL', async () => {
    const { redactSecretUrl } = await import('../track')
    const secret = 'nested-setup-secret'
    const callback = encodeURIComponent(
      `https://hire.interviewprep.guru/hire-signin?setup=${secret}`,
    )
    const sanitized = redactSecretUrl(
      `https://www.interviewprep.guru/signin?callbackUrl=${callback}`,
    )

    expect(sanitized).not.toContain(secret)
    const nested = new URL(sanitized).searchParams.get('callbackUrl')
    expect(nested).not.toBeNull()
    expect(new URL(nested as string).searchParams.get('setup')).toBeNull()
  })
})

describe('Hire analytics isolation', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    document.documentElement.removeAttribute('data-ipg-surface')
    delete window.gtag
    window.history.replaceState({}, '', '/')
  })

  it('emits no PostHog or GA event from a candidate invite URL', async () => {
    const fetchMock = vi.fn()
    const gtagMock = vi.fn()
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test')
    vi.stubGlobal('fetch', fetchMock)
    window.gtag = gtagMock
    document.documentElement.dataset.ipgSurface = 'b2c'
    window.history.replaceState({}, '', '/candidate/round-1?token=candidate-secret')

    const { track } = await import('../track')
    track('page_view', { pathname: '/candidate/[redacted]' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(gtagMock).not.toHaveBeenCalled()
  })

  it('emits no event from the dedicated runtime, including its lobby', async () => {
    const fetchMock = vi.fn()
    const gtagMock = vi.fn()
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test')
    vi.stubGlobal('fetch', fetchMock)
    window.gtag = gtagMock
    document.documentElement.dataset.ipgSurface = 'hire-runtime'
    window.history.replaceState({}, '', '/lobby?sessionId=opaque')

    const { track } = await import('../track')
    track('page_view', { pathname: '/lobby' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(gtagMock).not.toHaveBeenCalled()
  })

  it('keeps ordinary B2C lobby analytics enabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const gtagMock = vi.fn()
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test')
    vi.stubGlobal('fetch', fetchMock)
    window.gtag = gtagMock
    document.documentElement.dataset.ipgSurface = 'b2c'
    window.history.replaceState({}, '', '/lobby')

    const { track } = await import('../track')
    track('page_view', { pathname: '/lobby' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(gtagMock).toHaveBeenCalledWith('event', 'page_view', {
      pathname: '/lobby',
    })
  })

  it('never places query credentials in the PostHog current URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test')
    vi.stubGlobal('fetch', fetchMock)
    document.documentElement.dataset.ipgSurface = 'b2c'
    window.history.replaceState(
      {},
      '',
      '/pricing?token=candidate-secret&setup=member-secret&code=handoff-secret&utm_source=email',
    )

    const { track } = await import('../track')
    track('page_view', { pathname: '/pricing' })

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    const payload = JSON.parse(request.body as string) as {
      properties: { $current_url: string }
    }
    expect(payload.properties.$current_url).not.toContain('candidate-secret')
    expect(payload.properties.$current_url).not.toContain('member-secret')
    expect(payload.properties.$current_url).not.toContain('handoff-secret')
    expect(payload.properties.$current_url).toContain('utm_source=email')
  })
})
