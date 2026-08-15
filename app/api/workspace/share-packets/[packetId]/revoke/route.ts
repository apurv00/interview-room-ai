/** POST /api/workspace/share-packets/[packetId]/revoke — member-only revoke. */

import { NextResponse } from "next/server";
import { requireMembership } from "@hire";
import { revokeSharePacket } from "@hire-decisions/services/sharePacketService";
import { composeHireApiRoute } from "../../../_lib/composeHireApiRoute";

export const dynamic = "force-dynamic";

export const POST = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 20,
    keyPrefix: "rl:hire-share-packet-revoke",
  },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email });
    const sharePacket = await revokeSharePacket(ctx, params.packetId);
    return NextResponse.json(
      { sharePacket },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  },
});
