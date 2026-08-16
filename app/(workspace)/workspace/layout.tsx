"use client";

/* eslint-disable @next/next/no-img-element -- the private member logo endpoint requires the browser session, which the image optimizer cannot forward. */

/**
 * IPG Hire v2 member shell — sidebar layout for the workspace surface
 * (/workspace/* on www, and the whole hire.* subdomain via the middleware
 * rewrite). On www the middleware auth-gates /workspace directly; on the
 * hire subdomain the PRE-REWRITE pathname (e.g. "/", "/jobs") can be in the
 * public allowlist, so this shell owns the signed-out redirect. Workspace
 * membership is enforced per-request by the API layer (requireMembership).
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { clearAllInterviewStorage } from "@shared/storageKeys";

interface HireMemberSessionView {
  authenticated: boolean;
  member?: { name: string; email: string; role: "admin" | "member" };
}

interface HireWorkspaceBrandView {
  name: string;
  companyLogo: { updatedAt: string } | null;
}

const NAV = [
  { href: "/workspace/overview", label: "Overview", icon: "◫" },
  { href: "/workspace/audit", label: "Audit", icon: "◷" },
  { href: "/workspace/reports", label: "Reports", icon: "▤" },
  { href: "/workspace/jobs", label: "Jobs", icon: "📋" },
  { href: "/workspace/departments", label: "Departments", icon: "◩" },
  { href: "/workspace/candidates", label: "Candidates", icon: "👥" },
  { href: "/workspace/members", label: "Team", icon: "🧑‍💼" },
];

export default function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, status } = useSession();
  const [hireSession, setHireSession] = useState<HireMemberSessionView | null>(
    null,
  );
  const [workspaceBrand, setWorkspaceBrand] =
    useState<HireWorkspaceBrandView | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    let live = true;
    void fetch("/api/hire-auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((value: HireMemberSessionView) => {
        if (live) setHireSession(value);
      })
      .catch(() => {
        if (live) setHireSession({ authenticated: false });
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    const loadBrand = () => {
      void fetch("/api/workspace", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((value: { workspace?: HireWorkspaceBrandView | null } | null) => {
          if (live && value?.workspace) setWorkspaceBrand(value.workspace);
        })
        .catch(() => undefined);
    };
    loadBrand();
    window.addEventListener("hire-workspace-brand-updated", loadBrand);
    return () => {
      live = false;
      window.removeEventListener("hire-workspace-brand-updated", loadBrand);
    };
  }, [pathname]);

  useEffect(() => {
    if (status === "unauthenticated" && hireSession?.authenticated === false) {
      router.replace("/hire-signin");
    }
  }, [status, hireSession, router, pathname]);

  const nav = (
    <nav className="flex-1 px-3 py-4 space-y-1">
      {NAV.map((item) => {
        const active = pathname?.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setMobileOpen(false)}
            className={`flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
              active
                ? "bg-indigo-50 text-indigo-700"
                : "text-[#536471] hover:bg-gray-50 hover:text-[#0f1419]"
            }`}
          >
            <span aria-hidden>{item.icon}</span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  const companyName = workspaceBrand?.name || "IPG Hire";
  const companyLogoSrc = workspaceBrand?.companyLogo?.updatedAt
    ? `/api/workspace/branding/logo?v=${encodeURIComponent(
        workspaceBrand.companyLogo.updatedAt,
      )}`
    : null;

  const brand = (
    <div className="px-5 py-5 border-b border-[#e1e8ed]">
      <Link href="/workspace/overview" className="flex items-center gap-3">
        {companyLogoSrc ? (
          <img
            src={companyLogoSrc}
            alt={`${companyName} logo`}
            className="h-9 w-9 shrink-0 rounded-lg border border-[#e1e8ed] bg-white object-contain"
          />
        ) : (
          <span
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-sm font-bold text-indigo-700"
          >
            {companyName.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate text-lg font-bold text-[#0f1419]">
            {companyName}
          </span>
          <span className="block text-xs text-[#71767b]">Hiring workspace</span>
        </span>
      </Link>
    </div>
  );

  const userBlock = (
    <div className="px-5 py-4 border-t border-[#e1e8ed] text-sm">
      <p className="truncate text-[#0f1419]">
        {hireSession?.member?.email ?? session?.user?.email ?? ""}
      </p>
      <button
        onClick={async () => {
          // Shared-browser privacy: scrub account-bound state BEFORE the
          // session ends (same contract as AppShell/Resume; pinned by
          // shared/layout/__tests__/signOutStorage.test.tsx).
          await clearAllInterviewStorage();
          await fetch("/api/hire-auth/signout", { method: "POST" }).catch(
            () => undefined,
          );
          if (session?.user) {
            await signOut({ callbackUrl: "/hire-signin" });
          } else {
            window.location.assign("/hire-signin");
          }
        }}
        className="mt-1 text-xs text-[#71767b] hover:text-[#f4212e] transition-colors"
      >
        Sign out
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#f8fafc]">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-60 flex-col bg-white border-r border-[#e1e8ed] z-30">
        {brand}
        {nav}
        {userBlock}
      </aside>

      {/* Mobile header + drawer */}
      <div className="md:hidden sticky top-0 z-30 bg-white border-b border-[#e1e8ed] flex items-center justify-between px-4 py-3">
        <Link
          href="/workspace/overview"
          className="flex min-w-0 items-center gap-2 font-bold text-[#0f1419]"
        >
          {companyLogoSrc ? (
            <img
              src={companyLogoSrc}
              alt=""
              className="h-7 w-7 shrink-0 rounded-md border border-[#e1e8ed] bg-white object-contain"
            />
          ) : null}
          <span className="truncate">{companyName}</span>
        </Link>
        <button
          aria-label="Menu"
          onClick={() => setMobileOpen((v) => !v)}
          className="px-2 py-1 text-xl"
        >
          ☰
        </button>
      </div>
      {mobileOpen && (
        <div className="md:hidden bg-white border-b border-[#e1e8ed]">
          {nav}
          {userBlock}
        </div>
      )}

      <main className="md:pl-60">
        <div className="p-4 md:p-8 max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
