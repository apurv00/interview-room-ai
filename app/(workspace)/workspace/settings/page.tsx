import type { Metadata } from "next";
import WorkspaceSettings from "./WorkspaceSettings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Settings — IPG Hire",
};

export default function WorkspaceSettingsPage() {
  return <WorkspaceSettings />;
}
