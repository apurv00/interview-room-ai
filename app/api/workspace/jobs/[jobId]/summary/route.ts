/** Member-only job overview: bounded aggregates and activity, never candidate rows. */

import { NextResponse } from "next/server";
import { requireMembership } from "@hire-operations-boundary";
import {
  HireOperationsJobParamsSchema,
  readHireJobOverview,
} from "@hire-operations";
import { composeHireApiRoute } from "../../../_lib/composeHireApiRoute";

export const dynamic = "force-dynamic";

export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: "rl:hire-job-overview",
  },
  async handler(_request, { user, params }) {
    const { jobId } = HireOperationsJobParamsSchema.parse({ jobId: params.jobId });
    const ctx = await requireMembership({ userId: user.id, email: user.email });
    const summary = await readHireJobOverview({
      workspaceId: ctx.workspace._id.toString(),
      jobId,
    });
    return NextResponse.json(summary, {
      headers: { "Cache-Control": "private, no-store" },
    });
  },
});
