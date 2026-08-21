import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { z } from 'zod'
import { authOptions } from '@shared/auth/authOptions'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { logger } from '@shared/logger'
import { supportsHireDisplayCapture } from '@hire-multimodal-boundary'
import {
  type IHireRuntimeBinding,
} from '@modules/hire-runtime/models/HireRuntimeBinding'
import {
  completionBoundaryForPrincipal,
  HireRuntimeBindingError,
} from '@modules/hire-runtime/services/bindingService'
import { terminalizeRuntimeReplayMedia } from '@modules/hire-runtime/services/mediaCompletionService'
import { requireRuntimeWorkspaceId } from '@modules/hire-runtime/services/runtimeTenantScope'

export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
}

const TerminalMediaSchema = z
  .object({
    action: z.literal('mark-unavailable'),
    sessionId: z.string().regex(/^[a-f0-9]{24}$/i),
    kind: z.enum(['camera', 'screen']),
    reason: z.enum([
      'capture_failed',
      'durable_queue_failed',
      'upload_rejected',
      'retry_exhausted',
      'upload_expired',
    ]),
  })
  .strict()

interface CompletionInterview {
  status?: string
  recordingR2Key?: string | null
  recordingSizeBytes?: number | null
  screenRecordingR2Key?: string | null
  screenRecordingSizeBytes?: number | null
}

type CompletionMediaState =
  | 'pending'
  | 'published'
  | 'unavailable'
  | 'not_required'
  | 'legacy_complete'

function completionMediaSummary(
  binding: IHireRuntimeBinding,
): {
  camera: CompletionMediaState
  screen: CompletionMediaState
  ready: boolean
  degraded: boolean
} {
  const screenRequired = supportsHireDisplayCapture(binding.consentVersion)
  if (binding.mediaCompletionContractVersion !== 1) {
    return {
      camera: 'legacy_complete',
      screen: screenRequired ? 'legacy_complete' : 'not_required',
      ready: true,
      degraded: false,
    }
  }
  const camera = binding.cameraMediaStatus === 'published' ||
    binding.cameraMediaStatus === 'unavailable'
    ? binding.cameraMediaStatus
    : 'pending'
  const screen = !screenRequired
    ? 'not_required'
    : binding.screenMediaStatus === 'published' ||
        binding.screenMediaStatus === 'unavailable'
      ? binding.screenMediaStatus
      : 'pending'
  return {
    camera,
    screen,
    ready: camera !== 'pending' && screen !== 'pending',
    degraded: camera === 'unavailable' || screen === 'unavailable',
  }
}

function completionPayload(
  binding: IHireRuntimeBinding,
  interview: CompletionInterview | null,
) {
  const media = completionMediaSummary(binding)
  const sessionCompleted = interview?.status === 'completed'
  return {
    state: sessionCompleted && media.ready ? 'completed' as const : 'pending' as const,
    reason: !sessionCompleted ? 'session' as const : media.ready ? undefined : 'media' as const,
    sessionId: binding.runtimeSessionId?.toString(),
    media: { camera: media.camera, screen: media.screen },
    degraded: media.degraded,
  }
}

async function completionInterview(binding: IHireRuntimeBinding) {
  return InterviewSession.findOne({
    _id: binding.runtimeSessionId,
    userId: binding.principalId,
    organizationId: binding.workspaceId,
  })
    .select(
      'status recordingR2Key recordingSizeBytes screenRecordingR2Key screenRecordingSizeBytes',
    )
    .lean<CompletionInterview>()
}

function hasExactOrigin(req: NextRequest): boolean {
  const configured = process.env.NEXTAUTH_URL
  const expected = new URL(configured || req.nextUrl.origin).origin
  return req.headers.get('origin') === expected
}

function accountUnavailablePayload(reason: 'revoked' | 'purging') {
  return NextResponse.json(
    {
      state: 'account_unavailable',
      reason,
      code: 'ACCOUNT_UNAVAILABLE',
    },
    { status: 410, headers: NO_STORE_HEADERS },
  )
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id || !session.user.organizationId) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: NO_STORE_HEADERS },
    )
  }

  try {
    const workspaceId = requireRuntimeWorkspaceId(session.user.organizationId)
    const boundary = await completionBoundaryForPrincipal({
      workspaceId,
      principalId: session.user.id,
    })
    if (boundary.state === 'account_unavailable') {
      return accountUnavailablePayload(boundary.reason)
    }
    const binding = boundary.binding
    if (!binding.runtimeSessionId) {
      return NextResponse.json(
        { state: 'pending' },
        { headers: NO_STORE_HEADERS },
      )
    }

    return NextResponse.json(
      completionPayload(binding, await completionInterview(binding)),
      { headers: NO_STORE_HEADERS },
    )
  } catch (error) {
    if (error instanceof HireRuntimeBindingError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: NO_STORE_HEADERS },
      )
    }
    logger.error(
      { errorName: error instanceof Error ? error.constructor.name : 'UnknownError' },
      'hire runtime completion status failed',
    )
    return NextResponse.json(
      { error: 'Service unavailable' },
      { status: 503, headers: NO_STORE_HEADERS },
    )
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id || !session.user.organizationId) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: NO_STORE_HEADERS },
    )
  }
  if (!hasExactOrigin(req)) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'ORIGIN_MISMATCH' },
      { status: 403, headers: NO_STORE_HEADERS },
    )
  }

  try {
    const parsed = TerminalMediaSchema.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request' },
        { status: 400, headers: NO_STORE_HEADERS },
      )
    }
    const workspaceId = requireRuntimeWorkspaceId(session.user.organizationId)
    const boundary = await completionBoundaryForPrincipal({
      workspaceId,
      principalId: session.user.id,
    })
    if (boundary.state === 'account_unavailable') {
      return accountUnavailablePayload(boundary.reason)
    }
    const binding = boundary.binding
    const interview = await completionInterview(binding)
    if (
      !binding.runtimeSessionId ||
      parsed.data.sessionId.toLowerCase() !==
        binding.runtimeSessionId.toString().toLowerCase() ||
      interview?.status !== 'completed'
    ) {
      return NextResponse.json(
        { error: 'Interview completion is not durable', code: 'SESSION_PENDING' },
        { status: 409, headers: NO_STORE_HEADERS },
      )
    }
    if (binding.mediaCompletionContractVersion !== 1) {
      return NextResponse.json(completionPayload(binding, interview), {
        headers: NO_STORE_HEADERS,
      })
    }
    if (
      parsed.data.kind === 'screen' &&
      !supportsHireDisplayCapture(binding.consentVersion)
    ) {
      return NextResponse.json(
        { error: 'Display recording was not required', code: 'MEDIA_NOT_REQUIRED' },
        { status: 409, headers: NO_STORE_HEADERS },
      )
    }

    const currentStatus = parsed.data.kind === 'camera'
      ? binding.cameraMediaStatus
      : binding.screenMediaStatus
    if (currentStatus === 'published') {
      return NextResponse.json(
        { error: 'Media was already published', code: 'MEDIA_ALREADY_PUBLISHED' },
        { status: 409, headers: NO_STORE_HEADERS },
      )
    }
    if (currentStatus === 'unavailable') {
      return NextResponse.json(
        { recorded: true, ...completionPayload(binding, interview) },
        { headers: NO_STORE_HEADERS },
      )
    }

    const outcome = await terminalizeRuntimeReplayMedia({
      binding,
      kind: parsed.data.kind,
      reason: parsed.data.reason,
    })
    if (outcome === 'already_published') {
      return NextResponse.json(
        { error: 'Media was already published', code: 'MEDIA_ALREADY_PUBLISHED' },
        { status: 409, headers: NO_STORE_HEADERS },
      )
    }
    if (outcome !== 'recorded' && outcome !== 'already_unavailable') {
      return NextResponse.json(
        {
          error: outcome === 'session_pending'
            ? 'Interview completion is not durable'
            : 'Media delivery is still in flight',
          code: outcome === 'session_pending'
            ? 'SESSION_PENDING'
            : outcome === 'state_changed'
              ? 'MEDIA_STATE_CHANGED'
              : 'MEDIA_WRITE_IN_FLIGHT',
        },
        { status: 409, headers: NO_STORE_HEADERS },
      )
    }
    const updatedBoundary = await completionBoundaryForPrincipal({
      workspaceId,
      principalId: session.user.id,
    })
    if (updatedBoundary.state === 'account_unavailable') {
      return accountUnavailablePayload(updatedBoundary.reason)
    }
    const updated = updatedBoundary.binding
    return NextResponse.json(
      {
        recorded: true,
        ...completionPayload(updated, interview),
      },
      { headers: NO_STORE_HEADERS },
    )
  } catch (error) {
    if (error instanceof HireRuntimeBindingError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: NO_STORE_HEADERS },
      )
    }
    logger.error(
      { errorName: error instanceof Error ? error.constructor.name : 'UnknownError' },
      'hire runtime media completion settlement failed',
    )
    return NextResponse.json(
      { error: 'Service unavailable' },
      { status: 503, headers: NO_STORE_HEADERS },
    )
  }
}
