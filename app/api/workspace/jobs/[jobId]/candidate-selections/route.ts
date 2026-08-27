/** Creates a short-lived immutable candidate set for screening or bulk work. */

import { NextResponse } from "next/server";
import { requireMembership } from "@hire-operations-boundary";
import {
  HireCandidateSelectionCreateSchema,
  HireOperationsJobParamsSchema,
  createCandidateSelectionSnapshot,
  type HireCandidateSelectionCreatePayload,
} from "@hire-operations";
import { composeHireApiRoute } from "../../../_lib/composeHireApiRoute";

export const dynamic = "force-dynamic";

export const POST = composeHireApiRoute<HireCandidateSelectionCreatePayload>({
  schema: HireCandidateSelectionCreateSchema,
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "rl:hire-candidate-selection-create",
  },
  async handler(_request, { user, body, params }) {
    const { jobId } = HireOperationsJobParamsSchema.parse({ jobId: params.jobId });
    const ctx = await requireMembership({ userId: user.id, email: user.email });
    const selection = await createCandidateSelectionSnapshot(ctx, {
      jobId,
      payload: body,
    });
    return NextResponse.json(selection, {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  },
});
