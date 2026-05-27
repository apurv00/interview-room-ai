/** @typedef {{ id: string, ok: boolean, severity: string, message: string, detail?: object }} InfraCheck */

export const EXPECTED_FUNCTION_COUNT = 6

/** Inngest function ids registered in app/api/inngest/route.ts */
export const CRITICAL_FUNCTION_IDS = [
  'pathway-regenerate',
  'multimodal-analysis',
  'email-digest-daily',
  'regenerate-plans-monthly',
  'keep-mongo-warm',
  'recording-retention-cleanup',
]

/**
 * Parse Inngest serve() GET introspection response.
 * @param {unknown} body
 */
export function parseInngestIntrospection(body) {
  if (!body || typeof body !== 'object') {
    return { functionCount: null, functionIds: [], raw: body }
  }
  const o = /** @type {Record<string, unknown>} */ (body)
  const functionCount =
    typeof o.function_count === 'number'
      ? o.function_count
      : typeof o.functionCount === 'number'
        ? o.functionCount
        : Array.isArray(o.functions)
          ? o.functions.length
          : null

  /** @type {string[]} */
  const functionIds = []
  if (Array.isArray(o.functions)) {
    for (const fn of o.functions) {
      if (fn && typeof fn === 'object') {
        const id = /** @type {Record<string, unknown>} */ (fn).id ?? /** @type {Record<string, unknown>} */ (fn).slug
        if (typeof id === 'string') functionIds.push(id)
      } else if (typeof fn === 'string') {
        functionIds.push(fn)
      }
    }
  }

  return { functionCount, functionIds, mode: o.mode ?? null, raw: body }
}

/**
 * @param {object} parsed Return value of parseInngestIntrospection
 * @param {object} [opts]
 * @param {number} [opts.expectedCount]
 * @param {string[]} [opts.criticalIds]
 */
export function evaluateInngestHealth(parsed, opts = {}) {
  const expectedCount = opts.expectedCount ?? EXPECTED_FUNCTION_COUNT
  const criticalIds = opts.criticalIds ?? ['pathway-regenerate']
  const { functionCount, functionIds } = parsed

  if (functionCount == null) {
    return {
      ok: false,
      severity: 'P1',
      message: 'Inngest introspection did not return function_count',
      detail: { parsed },
    }
  }

  const countOk = functionCount >= expectedCount
  const missingCritical =
    functionIds.length > 0 ? criticalIds.filter((id) => !functionIds.includes(id)) : []

  const idsOk = functionIds.length === 0 || missingCritical.length === 0
  const ok = countOk && idsOk

  let message = `Inngest: ${functionCount} function(s) registered (expected ≥${expectedCount})`
  if (functionIds.length) {
    message += ` — ids: ${functionIds.join(', ')}`
  }
  if (!countOk) {
    message = `Inngest function_count=${functionCount} below expected ${expectedCount}`
  } else if (missingCritical.length) {
    message = `Inngest missing critical functions: ${missingCritical.join(', ')}`
  }

  return {
    ok,
    severity: ok ? 'none' : functionCount < expectedCount - 1 ? 'P0' : 'P1',
    message,
    detail: {
      functionCount,
      expectedCount,
      functionIds,
      missingCritical,
      mode: parsed.mode,
    },
  }
}

/**
 * GET /api/inngest on the deployed app (Inngest serve health + introspection).
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {number} [opts.timeoutMs]
 */
export async function checkInngestEndpoint(opts) {
  const base = opts.baseUrl.replace(/\/$/, '')
  const url = `${base}/api/inngest`
  const timeoutMs = opts.timeoutMs ?? 15_000

  let res
  let text = ''
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    text = await res.text()
  } catch (err) {
    return {
      id: 'inngest-endpoint',
      ok: false,
      severity: 'P0',
      message: `Inngest endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      detail: { url },
    }
  }

  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text.slice(0, 500) }
  }

  if (!res.ok) {
    return {
      id: 'inngest-endpoint',
      ok: false,
      severity: 'P0',
      message: `Inngest GET ${url} returned HTTP ${res.status}`,
      detail: { status: res.status, body },
    }
  }

  const parsed = parseInngestIntrospection(body)
  const health = evaluateInngestHealth(parsed)

  return {
    id: 'inngest-endpoint',
    ok: health.ok,
    severity: health.severity,
    message: health.message,
    detail: health.detail,
  }
}
