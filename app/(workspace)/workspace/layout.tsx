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
import { useEffect, useRef, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import {
  Blocks,
  BriefcaseBusiness,
  Building2,
  ChartNoAxesCombined,
  ClipboardClock,
  LayoutDashboard,
  Menu,
  Settings2,
  UserRoundCog,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { clearAllInterviewStorage } from "@shared/storageKeys";

interface HireMemberSessionView {
  authenticated: boolean;
  member?: { name: string; email: string; role: "admin" | "member" };
}

interface HireWorkspaceBrandView {
  name: string;
  companyLogo: { updatedAt: string } | null;
}

interface WorkspaceNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}

interface WorkspaceNavGroup {
  label: string;
  items: WorkspaceNavItem[];
}

const NAV_GROUPS: WorkspaceNavGroup[] = [
  {
    label: "Work",
    items: [
      { href: "/workspace/overview", label: "Overview", icon: LayoutDashboard },
      { href: "/workspace/jobs", label: "Jobs", icon: BriefcaseBusiness },
      { href: "/workspace/candidates", label: "Candidates", icon: UsersRound },
    ],
  },
  {
    label: "Insights",
    items: [
      { href: "/workspace/reports", label: "Reports", icon: ChartNoAxesCombined },
      { href: "/workspace/audit", label: "Audit", icon: ClipboardClock },
    ],
  },
  {
    label: "Company",
    items: [
      { href: "/workspace/departments", label: "Departments", icon: Building2 },
      { href: "/workspace/members", label: "Team", icon: UserRoundCog },
      { href: "/workspace/settings", label: "Settings", icon: Settings2 },
      {
        href: "/workspace/modules",
        label: "Modules",
        icon: Blocks,
        adminOnly: true,
      },
    ],
  },
];

const MOBILE_NAV_ID = "workspace-mobile-navigation";

function isActiveWorkspacePath(pathname: string | null, href: string) {
  return pathname === href || pathname?.startsWith(`${href}/`);
}

function focusableElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

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
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileDrawerRef = useRef<HTMLElement>(null);

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

  useEffect(() => {
    if (!mobileOpen) return;

    const drawer = mobileDrawerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    window.requestAnimationFrame(() => {
      focusableElements(drawer ?? document.body)[0]?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
        window.requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
        return;
      }

      if (event.key !== "Tab" || !drawer) return;
      const focusable = focusableElements(drawer);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobileOpen]);

  const closeMobileNavigation = () => {
    setMobileOpen(false);
    window.requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
  };

  const nav = (
    <nav aria-label="Workspace navigation" className="flex-1 px-3 py-4">
      <ul className="space-y-5">
        {NAV_GROUPS.map((group) => (
          <li key={group.label}>
            <p className="px-3 pb-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-[#71767b]">
              {group.label}
            </p>
            <ul aria-label={group.label} className="space-y-1">
              {group.items
                .filter(
                  (item) =>
                    !item.adminOnly || hireSession?.member?.role === "admin",
                )
                .map((item) => {
                  const active = isActiveWorkspacePath(pathname, item.href);
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        onClick={() => setMobileOpen(false)}
                        className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                          active
                            ? "bg-indigo-50 text-indigo-700"
                            : "text-[#536471] hover:bg-gray-50 hover:text-[#0f1419]"
                        }`}
                      >
                        <Icon
                          aria-hidden="true"
                          className="h-4 w-4 shrink-0"
                          strokeWidth={1.8}
                        />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
            </ul>
          </li>
        ))}
      </ul>
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
          ref={mobileMenuButtonRef}
          type="button"
          aria-label="Menu"
          aria-controls={MOBILE_NAV_ID}
          aria-expanded={mobileOpen}
          aria-haspopup="dialog"
          onClick={() => setMobileOpen((v) => !v)}
          className="rounded-lg p-2 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <Menu aria-hidden="true" className="h-5 w-5" />
        </button>
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close navigation menu"
            onClick={closeMobileNavigation}
            className="absolute inset-0 h-full w-full bg-slate-950/35"
          />
          <aside
            ref={mobileDrawerRef}
            id={MOBILE_NAV_ID}
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-mobile-navigation-title"
            className="absolute inset-y-0 right-0 flex w-[min(20rem,88vw)] flex-col overflow-y-auto bg-white shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-[#e1e8ed] px-5 py-4">
              <h2
                id="workspace-mobile-navigation-title"
                className="font-semibold text-[#0f1419]"
              >
                Workspace menu
              </h2>
              <button
                type="button"
                aria-label="Close menu"
                onClick={closeMobileNavigation}
                className="rounded-lg p-2 text-[#536471] hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <X aria-hidden="true" className="h-5 w-5" />
              </button>
            </div>
            {nav}
            {userBlock}
          </aside>
        </div>
      )}

      <main className="md:pl-60">
        <div className="p-4 md:p-8 max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
