/** Member-owned Phase-5 daily-summary preference. */

import { NextResponse } from "next/server";
import { requireMembership } from "@hire-operations-boundary";
import {
  getHireDigestPreference,
  UpdateHireDigestPreferenceSchema,
  updateHireDigestPreference,
  type HireDigestMemberView,
  type UpdateHireDigestPreferenceInput,
} from "@hire-digest";
import { composeHireApiRoute } from "../_lib/composeHireApiRoute";

export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

/** Deliberately narrow member DTO: no outbox, recipient, payload, or provider data. */
function serializeDigestPreference(view: HireDigestMemberView) {
  return {
    enabled: view.enabled,
    updatedAt: view.updatedAt?.toISOString() ?? null,
  };
}

export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: "rl:hire-digest-preference-read",
  },
  async handler(_request, { user }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email });
    const preference = await getHireDigestPreference(ctx);
    return NextResponse.json(serializeDigestPreference(preference), {
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  },
});

export const PATCH = composeHireApiRoute<UpdateHireDigestPreferenceInput>({
  schema: UpdateHireDigestPreferenceSchema,
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 20,
    keyPrefix: "rl:hire-digest-preference-write",
  },
  async handler(_request, { user, body }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email });
    const preference = await updateHireDigestPreference(ctx, body);
    return NextResponse.json(serializeDigestPreference(preference), {
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  },
});
