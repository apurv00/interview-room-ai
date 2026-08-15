import type { Metadata } from "next";
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
  return <JobPerformancePanel jobId={jobId} />;
}
