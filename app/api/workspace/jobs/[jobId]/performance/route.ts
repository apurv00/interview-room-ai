/** Member-only, read-only performance aggregate for one exact workspace job. */

import { NextResponse } from "next/server";
import { requireMembership } from "@hire-operations-boundary";
import {
  HireOperationsJobParamsSchema,
  readHireJobPerformance,
} from "@hire-operations";
import { composeHireApiRoute } from "../../../_lib/composeHireApiRoute";

export const dynamic = "force-dynamic";

export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: "rl:hire-operations-performance",
  },
  async handler(_req, { user, params }) {
    const { jobId } = HireOperationsJobParamsSchema.parse({
      jobId: params.jobId,
    });
    const ctx = await requireMembership({ userId: user.id, email: user.email });
    const performance = await readHireJobPerformance({
      workspaceId: ctx.workspace._id.toString(),
      jobId,
    });
    return NextResponse.json(performance, {
      headers: { "Cache-Control": "private, no-store" },
    });
  },
});
