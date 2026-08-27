import { NextResponse } from 'next/server'
import {
  previewJobScreeningGate,
  requireMembership,
  type ScreeningGatePreviewRequest,
} from '@hire'
import { getJobScreeningMemberReadProjection } from '@hire-operations'
import { composeHireApiRoute } from '../../../../_lib/composeHireApiRoute'
import {
  screeningPreviewRequestSchema,
  type ScreeningPreviewRouteBody,
} from '../_lib/schemas'
import {
  SCREENING_PREVIEW_PAGE_SIZE,
  serializeScreeningPreview,
  sliceScreeningPreviewPage,
} from '../_lib/serialize'
import {
  encodeScreeningPreviewPageCursor,
  screeningPreviewPageOffset,
} from '../_lib/paging'

export const dynamic = 'force-dynamic'

/** Read-only HR review. Confirmation is a separate, explicit mutation. */
export const POST = composeHireApiRoute<ScreeningPreviewRouteBody>({
  schema: screeningPreviewRequestSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:hire-screening-preview' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const { page: pageRequest, ...screeningRequest } = body
    const result = await previewJobScreeningGate(
      ctx,
      params.jobId,
      screeningRequest as ScreeningGatePreviewRequest,
    )
    const scope = pageRequest?.scope ?? 'selected'
    const cursorScope = {
      workspaceId: ctx.workspace._id.toString(),
      jobId: params.jobId,
      memberId: ctx.membership._id.toString(),
    }
    const offset = screeningPreviewPageOffset({
      ...cursorScope,
      scope,
      cursor: pageRequest?.cursor,
      expectedFingerprint: pageRequest?.expectedFingerprint,
      currentFingerprint: result.previewFingerprint,
    })
    const page = sliceScreeningPreviewPage(result.preview, scope, offset)
    const previousCursor = page.hasPrevious
      ? encodeScreeningPreviewPageCursor({
          ...cursorScope,
          fingerprint: result.previewFingerprint,
          scope,
          offset: Math.max(0, page.offset - SCREENING_PREVIEW_PAGE_SIZE),
        })
      : null
    const nextCursor = page.hasNext
      ? encodeScreeningPreviewPageCursor({
          ...cursorScope,
          fingerprint: result.previewFingerprint,
          scope,
          offset: page.offset + SCREENING_PREVIEW_PAGE_SIZE,
        })
      : null
    const pageCoordinates = page.rows.map((entry) => ({
      applicationId: entry.applicationId,
      candidateId: entry.candidateId,
    }))
    const cutLineEntry = result.preview.cutLine.applicationId
      ? result.preview.rankedApplications.find(
          (entry) => entry.applicationId === result.preview.cutLine.applicationId,
        )
      : undefined
    const cutLineCoordinate = cutLineEntry &&
      !pageCoordinates.some(
        (coordinate) => coordinate.applicationId === cutLineEntry.applicationId,
      )
      ? [{
          applicationId: cutLineEntry.applicationId,
          candidateId: cutLineEntry.candidateId,
        }]
      : []
    const [pageProjection, cutLineProjection] = await Promise.all([
      getJobScreeningMemberReadProjection(ctx, params.jobId, {
        candidateCoordinates: pageCoordinates,
      }),
      cutLineCoordinate.length
        ? getJobScreeningMemberReadProjection(ctx, params.jobId, {
            candidateCoordinates: cutLineCoordinate,
          })
        : Promise.resolve({ candidates: [] }),
    ])
    const projection = {
      candidates: [
        ...pageProjection.candidates,
        ...cutLineProjection.candidates,
      ],
    }
    return NextResponse.json({
      ...result,
      preview: serializeScreeningPreview(
        result.preview,
        { ...page, previousCursor, nextCursor },
        projection,
      ),
    }, {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  },
})
