/**
 * Deliberately narrow selector data for the reports surface.
 *
 * The general jobs endpoint includes operational fields such as close notes
 * and requirement settings. The Reports client needs none of those fields,
 * so it must never fetch that broader response merely to populate a select.
 */

import { NextResponse } from "next/server";
import { HireJob } from "@hire-decision-boundary";
import { requireMembership } from "@hire/services/workspaceService";
import { HireOnboardingTestDrive } from "@/modules/hire-onboarding/models";
import { composeHireApiRoute } from "../../_lib/composeHireApiRoute";

export const dynamic = "force-dynamic";

type JobOptionRow = {
  _id: { toString(): string };
  title: string;
  status: "open" | "on_hold" | "closed";
};

type TestDriveRow = {
  jobId: { toString(): string };
};

/**
 * Returns the exact three fields used by the report-scope picker. Synthetic
 * onboarding jobs stay out of the picker just as they stay out of operations
 * and report aggregates.
 */
export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: "rl:hire-report-job-options",
  },
  async handler(_req, { user }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email });
    const testDrives = (await HireOnboardingTestDrive.find({
      workspaceId: ctx.workspace._id,
      excludeFromAggregates: true,
    })
      .select("jobId")
      .lean()) as TestDriveRow[];
    const excludedJobIds = new Set(
      testDrives.map((testDrive) => testDrive.jobId.toString()),
    );
    const jobs = (await HireJob.find({ workspaceId: ctx.workspace._id })
      .select("_id title status")
      .sort({ title: 1, _id: 1 })
      .lean()) as JobOptionRow[];

    return NextResponse.json(
      {
        jobs: jobs
          .filter((job) => !excludedJobIds.has(job._id.toString()))
          .map((job) => ({
            id: job._id.toString(),
            title: job.title,
            status: job.status,
          })),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  },
});
