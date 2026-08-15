import type { Metadata } from "next";
import OverviewWorkspace from "./OverviewWorkspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Overview — IPG Hire",
};

export default function OverviewPage() {
  return <OverviewWorkspace />;
}
