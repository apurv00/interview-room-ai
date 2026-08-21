/** Member-only, read-only health rows for every job in the current workspace. */

import { NextResponse } from "next/server";
import { requireMembership } from "@hire-operations-boundary";
import { readHireJobsHealth } from "@hire-operations";
import { composeHireApiRoute } from "../../_lib/composeHireApiRoute";

export const dynamic = "force-dynamic";

export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: "rl:hire-operations-health",
  },
  async handler(req, { user }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email });
    const health = await readHireJobsHealth({
      workspaceId: ctx.workspace._id.toString(),
    });
    const response = new URL(req.url).searchParams.get("contractVersion") === "2"
      ? health
      : {
          ...health,
          jobs: health.jobs.map((job) => ({
            ...job,
            attention: job.attention.filter(
              (item) => item.kind !== "interview_validation_attention",
            ),
          })),
        };
    return NextResponse.json(response, {
      headers: { "Cache-Control": "private, no-store" },
    });
  },
});
