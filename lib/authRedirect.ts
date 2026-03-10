/**
 * Determine where to redirect based on auth session status.
 * Returns the redirect path, or null if the action should be blocked (e.g. still loading).
 */
export function getStartRedirect(status: 'loading' | 'unauthenticated' | 'authenticated'): string | null {
  if (status === 'loading') return null
  if (status === 'unauthenticated') return '/signin?callbackUrl=/lobby'
  return '/lobby'
}
