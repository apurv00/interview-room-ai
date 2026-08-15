/**
 * Member-only, intentionally narrow candidates for a deliberate decision
 * comparison. The full pipeline is never returned to this client surface.
 */

import { NextResponse } from "next/server";
import { getJobPipeline, requireMembership } from "@hire";
import { composeHireApiRoute } from "../../../../_lib/composeHireApiRoute";

interface DecisionComparisonCandidate {
  applicationId: string;
  candidateName: string;
}

function comparisonCandidatesFromPipeline(
  pipeline: Awaited<ReturnType<typeof getJobPipeline>>,
): DecisionComparisonCandidate[] {
  const candidates = new Map<string, DecisionComparisonCandidate>();

  for (const entry of pipeline.entries) {
    const applicationId = entry.application._id.toString();
    const candidateName = entry.candidate?.name.trim();

    // A privacy-purged candidate has no safe display identity. Do not
    // manufacture one from the application or any other pipeline field.
    if (!applicationId || !candidateName || candidates.has(applicationId)) {
      continue;
    }

    candidates.set(applicationId, { applicationId, candidateName });
  }

  // `getJobPipeline` has an internal rank-oriented ordering. This endpoint is
  // deliberately alphabetical so that rank is neither returned nor implied by
  // item order in a comparison picker.
  return Array.from(candidates.values()).sort(
    (left, right) =>
      left.candidateName.localeCompare(right.candidateName) ||
      left.applicationId.localeCompare(right.applicationId),
  );
}

export const dynamic = "force-dynamic";

export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: "rl:hire-decision-candidates",
  },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email });
    const pipeline = await getJobPipeline(ctx, params.jobId);

    return NextResponse.json(
      { candidates: comparisonCandidatesFromPipeline(pipeline) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  },
});
