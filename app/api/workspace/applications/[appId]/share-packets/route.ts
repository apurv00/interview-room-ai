/** Member-only share-packet creation and safe lifecycle listing. */

import { NextResponse } from "next/server";
import { requireMembership } from "@hire";
import {
  CreateSharePacketSchema,
  type CreateSharePacketPayload,
} from "@hire-decisions";
import {
  createSharePacket,
  listSharePackets,
} from "@hire-decisions/services/sharePacketService";
import { composeHireApiRoute } from "../../../_lib/composeHireApiRoute";

export const dynamic = "force-dynamic";

/** Lists only opaque packet lifecycle state. It never returns a snapshot or capability. */
export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: "rl:hire-share-packet-list",
  },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email });
    const sharePackets = await listSharePackets(ctx, params.appId);
    return NextResponse.json(
      { sharePackets },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  },
});

/**
 * The returned link is copy-only and appears only once on first creation.
 * There is deliberately no outbox or email-delivery side effect.
 */
export const POST = composeHireApiRoute<CreateSharePacketPayload>({
  schema: CreateSharePacketSchema,
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 10,
    keyPrefix: "rl:hire-share-packet-create",
  },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email });
    const result = await createSharePacket(ctx, {
      applicationId: params.appId,
      allowedSections: body.allowedSections,
      operationId: body.operationId,
    });
    return NextResponse.json(
      {
        sharePacket: result.packet,
        // `null` is intentional for a retried idempotency key: only the first
        // response can contain the raw fragment capability.
        shareUrl: result.shareUrl,
        created: result.created,
      },
      {
        status: result.created ? 201 : 200,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  },
});
