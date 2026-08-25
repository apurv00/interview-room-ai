import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorkspaceSettings from "../WorkspaceSettings";

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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const activeWorkspace = {
  name: "Acme Hiring",
  signInSlug: "acme-hiring",
  companyDescription: "Acme builds reliable hiring software.",
  companyLogo: null,
  guestAuthMode: "magic_link" as const,
  lifecycleState: "active" as const,
  purgeAfter: null,
  deletedByName: null,
};

const adminMembership = {
  id: "111111111111111111111111",
  email: "admin@acme.com",
  role: "admin" as const,
  directAccount: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkspaceSettings", () => {
  it("groups company, candidate experience, and data controls and preserves the guest-mode PATCH", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/workspace" && init?.method === "PATCH") {
          expect(JSON.parse(String(init.body))).toEqual({ guestAuthMode: "otp" });
          return json({
            workspace: { ...activeWorkspace, guestAuthMode: "otp" },
            membership: adminMembership,
          });
        }
        if (url === "/api/workspace") {
          return json({ workspace: activeWorkspace, membership: adminMembership });
        }
        if (url === "/api/workspace/members") {
          return json({ members: [adminMembership] });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkspaceSettings />);

    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Company profile")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Company workspace" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Sign-in name")).toHaveValue("acme-hiring");
    expect(screen.getByLabelText("Sign-in name")).toHaveAttribute("readonly");
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input) === "/api/workspace" && init?.method === undefined,
      ),
    ).toHaveLength(1);
    expect(
      screen.getByRole("heading", {
        name: "Candidate verification on interview links",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Lifecycle controls" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Company" })).toHaveAttribute(
      "href",
      "#company",
    );
    expect(
      screen.getByRole("link", { name: "Candidate experience" }),
    ).toHaveAttribute("href", "#candidate-experience");
    expect(
      screen.getByRole("link", { name: "Data & privacy" }),
    ).toHaveAttribute("href", "#data-privacy");
    expect(screen.queryByText("Add a team member")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /Email code/ }));

    expect(
      await screen.findByText("Saved — applies to invites sent from now on."),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspace",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("keeps the workspace-deletion confirmation and idempotency payload unchanged", async () => {
    const operationId = "22222222-2222-4222-8222-222222222222";
    vi.stubGlobal("crypto", { randomUUID: () => operationId });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/workspace/lifecycle/delete") {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init.body))).toEqual({
            confirmationName: "Acme Hiring",
            acknowledgePermanentPurge: true,
            operationId,
          });
          return json({
            workspace: {
              ...activeWorkspace,
              lifecycleState: "deletion_pending",
              purgeAfter: "2026-09-22T00:00:00.000Z",
              deletedByName: "Hiring Admin",
            },
            membership: adminMembership,
          });
        }
        if (url === "/api/workspace") {
          return json({ workspace: activeWorkspace, membership: adminMembership });
        }
        if (url === "/api/workspace/members") {
          return json({ members: [adminMembership] });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkspaceSettings />);

    fireEvent.change(
      await screen.findByLabelText("Type “Acme Hiring” to confirm"),
      { target: { value: "Acme Hiring" } },
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /workspace and all hiring data can be permanently purged/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete workspace" }));

    expect(
      await screen.findByRole("heading", {
        name: "Workspace scheduled for deletion",
      }),
    ).toBeInTheDocument();
  });

  it("keeps personal deletion available to a direct member without exposing admin settings", async () => {
    const operationId = "33333333-3333-4333-8333-333333333333";
    vi.stubGlobal("crypto", { randomUUID: () => operationId });
    const member = {
      id: "333333333333333333333333",
      email: "member@acme.com",
      role: "member" as const,
      directAccount: true,
    };
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/hire-auth/account") {
          expect(init?.method).toBe("DELETE");
          expect(JSON.parse(String(init.body))).toEqual({ operationId });
          return json({ error: "Deletion held for test" }, 409);
        }
        if (url === "/api/workspace") {
          return json({ workspace: activeWorkspace, membership: member });
        }
        if (url === "/api/workspace/members") {
          return json({ members: [member] });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkspaceSettings />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete my Hire account" }),
    );
    fireEvent.change(screen.getByLabelText("Type “member@acme.com” to confirm"), {
      target: { value: "member@acme.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete my Hire account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Deletion held for test",
    );
    expect(
      screen.queryByRole("heading", {
        name: "Candidate verification on interview links",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete workspace" }),
    ).not.toBeInTheDocument();
  });

  it("keeps lifecycle recovery on Settings with the original restore payload", async () => {
    const operationId = "44444444-4444-4444-8444-444444444444";
    vi.stubGlobal("crypto", { randomUUID: () => operationId });
    let pending = true;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/workspace/lifecycle/restore") {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init.body))).toEqual({ operationId });
          pending = false;
          return json({ workspace: activeWorkspace, membership: adminMembership });
        }
        if (url === "/api/workspace") {
          return json({
            workspace: pending
              ? {
                  ...activeWorkspace,
                  lifecycleState: "deletion_pending",
                  purgeAfter: "2026-09-22T00:00:00.000Z",
                  deletedByName: "Hiring Admin",
                }
              : activeWorkspace,
            membership: adminMembership,
          });
        }
        if (url === "/api/workspace/members") {
          return pending
            ? json({ error: "Workspace is scheduled for deletion" }, 410)
            : json({ members: [adminMembership] });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkspaceSettings />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Restore workspace" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    });
  });
});
