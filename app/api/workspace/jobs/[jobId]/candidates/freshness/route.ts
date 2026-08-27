/** Lightweight polling read: reports matching arrivals without replacing rows. */

import { NextResponse } from "next/server";
import { requireMembership } from "@hire-operations-boundary";
import {
  HireJobCandidateFreshnessQuerySchema,
  HireOperationsJobParamsSchema,
  readHireJobCandidateFreshness,
} from "@hire-operations";
import { composeHireApiRoute } from "../../../../_lib/composeHireApiRoute";

export const dynamic = "force-dynamic";

function rawSearchParams(url: URL): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  url.searchParams.forEach((value, key) => {
    const current = result[key];
    result[key] = current === undefined
      ? value
      : Array.isArray(current) ? [...current, value] : [current, value];
  });
  return result;
}

export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: "rl:hire-job-candidate-freshness",
  },
  async handler(request, { user, params }) {
    const { jobId } = HireOperationsJobParamsSchema.parse({ jobId: params.jobId });
    const query = HireJobCandidateFreshnessQuerySchema.parse(
      rawSearchParams(new URL(request.url)),
    );
    const ctx = await requireMembership({ userId: user.id, email: user.email });
    const freshness = await readHireJobCandidateFreshness({
      workspaceId: ctx.workspace._id.toString(),
      jobId,
      query,
    });
    return NextResponse.json(freshness, {
      headers: { "Cache-Control": "private, no-store" },
    });
  },
});
