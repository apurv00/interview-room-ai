/** Member-only, read-only operations audit projection. */

import { NextResponse } from "next/server";
import { requireMembership } from "@hire-operations-boundary";
import {
  HireOperationsAuditQuerySchema,
  readHireWorkspaceAudit,
} from "@hire-operations";
import { composeHireApiRoute } from "../_lib/composeHireApiRoute";

export const dynamic = "force-dynamic";

export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: "rl:hire-operations-audit",
  },
  async handler(request, { user }) {
    const url = new URL(request.url);
    const query = HireOperationsAuditQuerySchema.parse({
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.has("limit")
        ? url.searchParams.get("limit")
        : undefined,
    });
    const ctx = await requireMembership({ userId: user.id, email: user.email });
    const page = await readHireWorkspaceAudit({
      workspaceId: ctx.workspace._id.toString(),
      ...query,
    });
    return NextResponse.json(page, {
      headers: { "Cache-Control": "private, no-store" },
    });
  },
});
