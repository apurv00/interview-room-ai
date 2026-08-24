import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import WorkspaceLayout from "../layout";

const router = { replace: vi.fn() };

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/workspace/overview",
  useRouter: () => router,
}));
vi.mock("next-auth/react", () => ({
  signOut: vi.fn(),
  useSession: () => ({
    data: { user: { email: "hr@example.com" } },
    status: "authenticated",
  }),
}));
vi.mock("@shared/storageKeys", () => ({ clearAllInterviewStorage: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  router.replace.mockReset();
});

describe("WorkspaceLayout navigation", () => {
  it("adds Overview as the member landing navigation item", async () => {
    let brand = {
      name: "Acme Hiring",
      companyLogo: { updatedAt: "2026-08-16T12:00:00.000Z" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              url === "/api/workspace"
                ? {
                    workspace: brand,
                  }
                : {
                    authenticated: true,
                    member: {
                      name: "Hiring Admin",
                      email: "member@example.com",
                      role: "admin",
                    },
                  },
            ),
          ),
        ),
      ),
    );

    render(
      <WorkspaceLayout>
        <div>Child content</div>
      </WorkspaceLayout>,
    );

    await waitFor(() =>
      expect(screen.getByText("member@example.com")).toBeTruthy(),
    );
    expect(
      screen.getAllByRole("link", { name: /Overview/ })[0],
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getAllByRole("link", { name: /Overview/ })[0],
    ).toHaveAttribute("href", "/workspace/overview");
    expect(screen.getAllByRole("link", { name: /Audit/ })[0]).toHaveAttribute(
      "href",
      "/workspace/audit",
    );
    expect(
      screen.getAllByRole("link", { name: /Departments/ })[0],
    ).toHaveAttribute("href", "/workspace/departments");
    expect(
      screen.getAllByRole("link", { name: "Settings" })[0],
    ).toHaveAttribute("href", "/workspace/settings");
    expect(
      screen.getAllByRole("link", { name: "Modules" })[0],
    ).toHaveAttribute("href", "/workspace/modules");
    expect(
      screen.getAllByRole("link", { name: /Acme Hiring/ })[0],
    ).toHaveAttribute("href", "/workspace/overview");
    expect(screen.getByAltText("Acme Hiring logo")).toHaveAttribute(
      "src",
      "/api/workspace/branding/logo?v=2026-08-16T12%3A00%3A00.000Z",
    );

    brand = {
      name: "Acme Operations",
      companyLogo: { updatedAt: "2026-08-16T13:00:00.000Z" },
    };
    window.dispatchEvent(new Event("hire-workspace-brand-updated"));

    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: /Acme Operations/ })[0]).toBeTruthy(),
    );
    expect(screen.getByAltText("Acme Operations logo")).toHaveAttribute(
      "src",
      "/api/workspace/branding/logo?v=2026-08-16T13%3A00%3A00.000Z",
    );

    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.getByText("Insights")).toBeTruthy();
    expect(screen.getByText("Company")).toBeTruthy();
  });

  it("exposes and focus-manages the mobile navigation dialog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              url === "/api/workspace"
                ? { workspace: { name: "Acme Hiring", companyLogo: null } }
                : {
                    authenticated: true,
                    member: {
                      name: "Hiring Admin",
                      email: "member@example.com",
                      role: "admin",
                    },
                  },
            ),
          ),
        ),
      ),
    );

    render(
      <WorkspaceLayout>
        <div>Child content</div>
      </WorkspaceLayout>,
    );

    const menuButton = screen.getByRole("button", { name: "Menu" });
    expect(menuButton).toHaveAttribute("aria-expanded", "false");
    expect(menuButton).toHaveAttribute(
      "aria-controls",
      "workspace-mobile-navigation",
    );

    fireEvent.click(menuButton);

    expect(menuButton).toHaveAttribute("aria-expanded", "true");
    const dialog = screen.getByRole("dialog", { name: "Workspace menu" });
    expect(dialog).toHaveAttribute("id", "workspace-mobile-navigation");
    const closeButton = screen.getByRole("button", { name: "Close menu" });
    await waitFor(() => expect(closeButton).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Workspace menu" })).toBeNull();
      expect(menuButton).toHaveAttribute("aria-expanded", "false");
      expect(menuButton).toHaveFocus();
    });
  });

  it("keeps Settings available but hides Modules from non-admin members", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              url === "/api/workspace"
                ? { workspace: { name: "Acme Hiring", companyLogo: null } }
                : {
                    authenticated: true,
                    member: {
                      name: "Hiring Member",
                      email: "member@example.com",
                      role: "member",
                    },
                  },
            ),
          ),
        ),
      ),
    );

    render(
      <WorkspaceLayout>
        <div>Child content</div>
      </WorkspaceLayout>,
    );

    await waitFor(() => expect(screen.getByText("member@example.com")).toBeTruthy());
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/workspace/settings",
    );
    expect(screen.queryByRole("link", { name: "Modules" })).toBeNull();
  });
});
