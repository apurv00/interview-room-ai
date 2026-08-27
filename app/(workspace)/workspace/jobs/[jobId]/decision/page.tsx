import type { Metadata } from "next";
import JobSubnav from "../JobSubnav";
import DecisionWorkspace from "./DecisionWorkspace";
import { decisionHandoff } from "./decisionHandoff";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Decision workspace — IPG Hire",
};

/**
 * URL candidate coordinates are only an initial handoff. The client must
 * rehydrate them through the member-only, same-job compare API before they
 * can become selected chips or evidence.
 */
export default async function DecisionWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { jobId } = await params;
  const query = searchParams ? await searchParams : {};
  const handoff = decisionHandoff(query.applicationId);
  return (
    <div className="space-y-6">
      <JobSubnav jobId={jobId} active="decisions" />
      <DecisionWorkspace
        jobId={jobId}
        initialApplicationIds={handoff.applicationIds}
        initialSelectionError={handoff.error}
      />
    </div>
  );
}
