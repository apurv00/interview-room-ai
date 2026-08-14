import type { Metadata } from "next";
import DecisionWorkspace from "./DecisionWorkspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Decision workspace — IPG Hire",
};

/**
 * The page deliberately passes only the route coordinate to the client.
 * All candidate evidence is fetched through the member-only, safe DTO APIs.
 */
export default async function DecisionWorkspacePage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  return <DecisionWorkspace jobId={jobId} />;
}
