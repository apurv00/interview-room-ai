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
  async handler(_req, { user }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email });
    const health = await readHireJobsHealth({
      workspaceId: ctx.workspace._id.toString(),
    });
    return NextResponse.json(health, {
      headers: { "Cache-Control": "private, no-store" },
    });
  },
});
