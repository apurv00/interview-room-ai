import type { Metadata } from "next";
import JobSubnav from "../JobSubnav";
import JobPerformancePanel from "./JobPerformancePanel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Job performance — IPG Hire",
};

export default async function JobPerformancePage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  return (
    <div className="space-y-6">
      <JobSubnav jobId={jobId} active="performance" />
      <JobPerformancePanel jobId={jobId} />
    </div>
  );
}
