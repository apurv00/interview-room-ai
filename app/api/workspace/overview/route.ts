/** Member-only, read-only operational KPI strip and grouped action inbox. */

import { NextResponse } from "next/server";
import { requireMembership } from "@hire-operations-boundary";
import { readHireWorkspaceOverview } from "@hire-operations";
import { composeHireApiRoute } from "../_lib/composeHireApiRoute";

export const dynamic = "force-dynamic";

export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: "rl:hire-operations-overview",
  },
  async handler(_req, { user }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email });
    const overview = await readHireWorkspaceOverview({
      workspaceId: ctx.workspace._id.toString(),
    });
    return NextResponse.json(overview, {
      headers: { "Cache-Control": "private, no-store" },
    });
  },
});
