/** Scoped metadata/release endpoint; immutable application IDs never leave the server. */

import { NextResponse } from "next/server";
import { requireMembership } from "@hire-operations-boundary";
import {
  HireCandidateSelectionParamsSchema,
  readCandidateSelectionMetadata,
  releaseCandidateSelectionSnapshot,
} from "@hire-operations";
import { composeHireApiRoute } from "../../../../_lib/composeHireApiRoute";

export const dynamic = "force-dynamic";

async function scopedContext(
  user: { id: string; email: string },
  params: Record<string, string>,
) {
  const parsed = HireCandidateSelectionParamsSchema.parse({
    jobId: params.jobId,
    selectionId: params.selectionId,
  });
  const ctx = await requireMembership({ userId: user.id, email: user.email });
  return { ctx, ...parsed };
}

export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: "rl:hire-candidate-selection-read",
  },
  async handler(_request, { user, params }) {
    const { ctx, jobId, selectionId } = await scopedContext(user, params);
    const selection = await readCandidateSelectionMetadata(ctx, {
      jobId,
      selectionId,
    });
    return NextResponse.json(selection, {
      headers: { "Cache-Control": "private, no-store" },
    });
  },
});

export const DELETE = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "rl:hire-candidate-selection-release",
  },
  async handler(_request, { user, params }) {
    const { ctx, jobId, selectionId } = await scopedContext(user, params);
    const released = await releaseCandidateSelectionSnapshot(ctx, {
      jobId,
      selectionId,
    });
    return NextResponse.json(
      { released },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  },
});
