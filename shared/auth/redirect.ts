function isLocalDevelopmentHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

function isInterviewPrepHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    normalized === 'interviewprep.guru' ||
    normalized.endsWith('.interviewprep.guru')
  )
}

/**
 * NextAuth defaults to same-origin callbacks. HR authenticates on the B2C
 * origin and then returns to the isolated Hire control origin, so explicitly
 * allow only HTTPS first-party sibling hosts. The engine runtime remains
 * same-origin-only because its cookie and secret are a separate trust zone.
 */
export function resolveFirstPartyAuthRedirect(
  url: string,
  baseUrl: string,
  runtimeOnly = false,
): string {
  try {
    const base = new URL(baseUrl)
    const target = new URL(url, base)
    if (runtimeOnly) return target.origin === base.origin ? target.toString() : baseUrl

    const localDevelopment =
      process.env.NODE_ENV !== 'production' &&
      isLocalDevelopmentHost(base.hostname) &&
      isLocalDevelopmentHost(target.hostname) &&
      target.protocol === base.protocol
    const firstPartyProduction =
      target.protocol === 'https:' && isInterviewPrepHost(target.hostname)

    return localDevelopment || firstPartyProduction ? target.toString() : baseUrl
  } catch {
    return baseUrl
  }
}
