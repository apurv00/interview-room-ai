/** Separate filtered counts/rank context; cursor pages never recompute funnels. */

import { NextResponse } from "next/server";
import { requireMembership } from "@hire-operations-boundary";
import {
  HireJobCandidateSummaryQuerySchema,
  HireOperationsJobParamsSchema,
  readHireJobCandidateSummary,
} from "@hire-operations";
import { composeHireApiRoute } from "../../../../_lib/composeHireApiRoute";

export const dynamic = "force-dynamic";

function rawSearchParams(url: URL): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  url.searchParams.forEach((value, key) => {
    const existing = result[key];
    result[key] =
      existing === undefined
        ? value
        : Array.isArray(existing)
          ? [...existing, value]
          : [existing, value];
  });
  return result;
}

export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: "rl:hire-job-candidate-summary",
  },
  async handler(request, { user, params }) {
    const { jobId } = HireOperationsJobParamsSchema.parse({ jobId: params.jobId });
    const query = HireJobCandidateSummaryQuerySchema.parse(
      rawSearchParams(new URL(request.url)),
    );
    const ctx = await requireMembership({ userId: user.id, email: user.email });
    const summary = await readHireJobCandidateSummary({
      workspaceId: ctx.workspace._id.toString(),
      jobId,
      query,
    });
    return NextResponse.json(summary, {
      headers: { "Cache-Control": "private, no-store" },
    });
  },
});
