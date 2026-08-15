import type { Metadata } from "next";
import JobsHealthPanel from "./JobsHealthPanel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Jobs health — IPG Hire",
};

export default function JobsHealthPage() {
  return <JobsHealthPanel />;
}
