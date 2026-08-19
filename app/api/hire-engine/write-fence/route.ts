import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import {
  claimRuntimeWriteCapability,
  recordRuntimeStorageCapability,
  RuntimeWriteFenceError,
  settleRuntimeMultipartCapability,
} from '@modules/hire-runtime/services/runtimeWriteFence'
import {
  assertRuntimeWriteTargetBound,
  RuntimeWriteTargetGuardError,
} from '@modules/hire-runtime/services/runtimeWriteTargetGuard'
import { requireRuntimeWorkspaceId } from '@modules/hire-runtime/services/runtimeTenantScope'
import { HIRE_RUNTIME_MAX_FENCED_BODY_BYTES } from '@shared/contracts/hireRuntimeWriteFence'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const TARGET_PARAM = '__runtime_target'
const BYPASS_HEADER = 'x-ipg-hire-runtime-fence-bypass'
const ORIGIN_USER_HEADER = 'x-origin-user-id'

function bypassSecret(): string {
  const secret = process.env.HIRE_RUNTIME_FENCE_SECRET
  if (!secret || (process.env.NODE_ENV === 'production' && secret.length < 32)) {
    throw new RuntimeWriteFenceError('Runtime write fence is not configured', 503)
  }
  return secret
}

function internalTargetUrl(req: NextRequest, pathname: string): URL {
  const configured = process.env.NEXTAUTH_URL
  const base = new URL(configured || req.nextUrl.origin)
  if (process.env.NODE_ENV === 'production' && base.protocol !== 'https:') {
    throw new RuntimeWriteFenceError('Runtime internal origin must use HTTPS', 503)
  }
  // TTS has a runtime-owned transient implementation. Send the admitted body
  // there directly; another middleware rewrite would drop it on self-hosted
  // Next.js just like the original fenced PATCH failure.
  const internalPathname = pathname === '/api/tts'
    ? '/api/hire-engine/tts'
    : pathname === '/api/tts/stream'
      ? '/api/hire-engine/tts/stream'
      : pathname
  const target = new URL(internalPathname, base)
  for (const [key, value] of Array.from(req.nextUrl.searchParams.entries())) {
    if (key !== TARGET_PARAM) target.searchParams.append(key, value)
  }
  return target
}

function parseJson(bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes.byteLength === 0) return null
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

async function captureStorageCapability(input: {
  pathname: string
  workspaceId: string
  bindingId: string
  principalId: string
  runtimeSessionId?: string
  requestBody: Record<string, unknown> | null
  responseBody: Record<string, unknown> | null
}): Promise<void> {
  if (!input.pathname.startsWith('/api/storage/')) return
  const action = input.requestBody?.action
  if (typeof action !== 'string') return

  if (input.pathname === '/api/storage/presign') {
    if (action !== 'upload') return
    const key = input.responseBody?.key
    const runtimeSessionId = input.requestBody?.sessionId
    if (typeof key !== 'string' || typeof runtimeSessionId !== 'string') {
      throw new RuntimeWriteFenceError('Runtime presign response was incomplete', 503)
    }
    await recordRuntimeStorageCapability({
      workspaceId: input.workspaceId,
      bindingId: input.bindingId,
      principalId: input.principalId,
      runtimeSessionId,
      key,
    })
    return
  }

  if (input.pathname !== '/api/storage/multipart') return
  const key = (input.responseBody?.key ?? input.requestBody?.key)
  const uploadId = (input.responseBody?.uploadId ?? input.requestBody?.uploadId)
  const runtimeSessionId = input.requestBody?.sessionId ?? input.runtimeSessionId
  if (
    typeof key !== 'string' ||
    typeof uploadId !== 'string' ||
    typeof runtimeSessionId !== 'string'
  ) {
    throw new RuntimeWriteFenceError('Runtime multipart response was incomplete', 503)
  }
  if (action === 'create' || action === 'sign-part') {
    await recordRuntimeStorageCapability({
      workspaceId: input.workspaceId,
      bindingId: input.bindingId,
      principalId: input.principalId,
      runtimeSessionId,
      key,
      uploadId,
    })
  } else if (action === 'complete' || action === 'abort') {
    await settleRuntimeMultipartCapability({
      workspaceId: input.workspaceId,
      bindingId: input.bindingId,
      uploadId,
      key,
      removeObjectCapability: action === 'abort',
    })
  }
}

async function handler(req: NextRequest): Promise<Response> {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id || !session.user.organizationId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const workspaceId = requireRuntimeWorkspaceId(session.user.organizationId)
    const pathname = req.nextUrl.searchParams.get(TARGET_PARAM)
    if (!pathname || !pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const bytes = new Uint8Array(await req.arrayBuffer())
    if (bytes.byteLength > HIRE_RUNTIME_MAX_FENCED_BODY_BYTES) {
      throw new RuntimeWriteTargetGuardError('Runtime target body was too large', 413)
    }
    const requestBody = parseJson(bytes)
    const binding = await claimRuntimeWriteCapability({
      workspaceId,
      principalId: session.user.id,
      pathname,
      method: req.method,
    })
    assertRuntimeWriteTargetBound({
      pathname,
      method: req.method,
      bodyPresent: bytes.byteLength > 0,
      requestBody,
      query: Array.from(req.nextUrl.searchParams.entries())
        .filter(([key]) => key !== TARGET_PARAM),
      binding: {
        bindingId: binding._id.toString(),
        status: binding.status,
        workspaceId: binding.workspaceId.toString(),
        applicationId: binding.applicationId.toString(),
        roundId: binding.roundId.toString(),
        principalId: binding.principalId.toString(),
        runtimeSessionId: binding.runtimeSessionId?.toString(),
        issuedObjectCapabilities: binding.issuedObjectCapabilities?.map((capability) => ({
          key: capability.key,
          runtimeSessionId: capability.runtimeSessionId.toString(),
          expiresAt: capability.expiresAt,
        })),
        issuedMultipartCapabilities: binding.issuedMultipartCapabilities?.map((capability) => ({
          key: capability.key,
          runtimeSessionId: capability.runtimeSessionId.toString(),
          uploadId: capability.uploadId,
          expiresAt: capability.expiresAt,
        })),
      },
    })

    const headers = new Headers(req.headers)
    headers.delete('host')
    headers.delete('content-length')
    headers.set(BYPASS_HEADER, bypassSecret())
    headers.set(ORIGIN_USER_HEADER, binding.principalId.toString())
    const upstream = await fetch(internalTargetUrl(req, pathname), {
      method: req.method,
      headers,
      body: bytes.byteLength > 0 ? bytes : undefined,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(295_000),
    })
    const responseBytes = new Uint8Array(await upstream.arrayBuffer())
    if (upstream.ok) {
      await captureStorageCapability({
        pathname,
        workspaceId,
        bindingId: binding._id.toString(),
        principalId: binding.principalId.toString(),
        runtimeSessionId: binding.runtimeSessionId?.toString(),
        requestBody,
        responseBody: parseJson(responseBytes),
      })
    }
    const responseHeaders = new Headers(upstream.headers)
    responseHeaders.delete('content-length')
    responseHeaders.delete('content-encoding')
    responseHeaders.set('Cache-Control', 'private, no-store')
    return new Response(responseBytes, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    })
  } catch (error) {
    const status = error instanceof RuntimeWriteFenceError ||
      error instanceof RuntimeWriteTargetGuardError
      ? error.status
      : 503
    return NextResponse.json(
      { error: status === 404 ? 'Not found' : 'Runtime unavailable' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}

export const GET = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
