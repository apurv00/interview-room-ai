import type { Metadata } from "next";
import AuditWorkspace from "./AuditWorkspace";

export const metadata: Metadata = {
  title: "Audit trail | IPG Hire",
};

export default function AuditPage() {
  return <AuditWorkspace />;
}
