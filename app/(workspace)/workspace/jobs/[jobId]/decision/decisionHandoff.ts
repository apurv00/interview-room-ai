const OBJECT_ID = /^[a-f0-9]{24}$/i

export function decisionHandoff(
  value: string | string[] | undefined,
): { applicationIds: string[]; error?: string } {
  if (value === undefined) return { applicationIds: [] }
  const applicationIds = Array.isArray(value) ? value : [value]
  if (
    applicationIds.length < 2 ||
    applicationIds.length > 3 ||
    applicationIds.some((id) => !OBJECT_ID.test(id)) ||
    new Set(applicationIds.map((id) => id.toLowerCase())).size !==
      applicationIds.length
  ) {
    return {
      applicationIds: [],
      error:
        'The comparison handoff was invalid. Select exactly two or three unique candidates again.',
    }
  }
  return { applicationIds }
}
