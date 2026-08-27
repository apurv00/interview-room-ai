import Link from "next/link";

export type JobWorkspaceSection =
  | "overview"
  | "candidates"
  | "screening"
  | "decisions"
  | "performance";

interface JobSubnavProps {
  jobId: string;
  active: JobWorkspaceSection;
}

const SECTIONS: Array<{
  id: JobWorkspaceSection;
  label: string;
  suffix: string;
}> = [
  { id: "overview", label: "Overview", suffix: "" },
  { id: "candidates", label: "Candidates", suffix: "/candidates" },
  { id: "screening", label: "Screening", suffix: "/screening" },
  { id: "decisions", label: "Decisions", suffix: "/decision" },
  { id: "performance", label: "Performance", suffix: "/performance" },
];

/** Keeps every job-level operating view reachable without returning to Jobs. */
export default function JobSubnav({ jobId, active }: JobSubnavProps) {
  const baseHref = `/workspace/jobs/${encodeURIComponent(jobId)}`;

  return (
    <nav aria-label="Job workspace" className="-mx-1 overflow-x-auto px-1 pb-1">
      <ul className="flex min-w-max gap-1 rounded-xl border border-[#e1e8ed] bg-white p-1">
        {SECTIONS.map((section) => {
          const isActive = section.id === active;
          return (
            <li key={section.id}>
              <Link
                href={`${baseHref}${section.suffix}`}
                aria-current={isActive ? "page" : undefined}
                className={`block rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                  isActive
                    ? "bg-indigo-50 text-indigo-700"
                    : "text-[#536471] hover:bg-gray-50 hover:text-[#0f1419]"
                }`}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
