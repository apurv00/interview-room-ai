import type { Metadata } from "next";
import JobSubnav from "../JobSubnav";
import ScreeningPanel from "./ScreeningPanel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Screening — IPG Hire",
};

function queryValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Screening is a stable job task route. A Candidates handoff supplies only a
 * server-owned snapshot identifier; application IDs in the browser are never
 * treated as an authoritative invite set.
 */
export default async function JobScreeningPage({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { jobId } = await params;
  const query = searchParams ? await searchParams : {};
  const selectionSnapshotId = queryValue(query.selectionSnapshotId);

  return (
    <div className="space-y-6">
      <JobSubnav jobId={jobId} active="screening" />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#0f1419]">
            Screening
          </h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[#536471]">
            Review a deterministic selection, document exceptions, and
            explicitly authorize a scheduled invitation batch. Screening never
            rejects candidates or moves their pipeline stage.
          </p>
        </div>
      </header>
      <ScreeningPanel
        key={jobId}
        jobId={jobId}
        selectionSnapshotId={selectionSnapshotId}
      />
    </div>
  );
}
