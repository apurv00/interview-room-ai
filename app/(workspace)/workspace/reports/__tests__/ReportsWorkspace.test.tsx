import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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

import ReportsWorkspace, { __hireReportsWorkspace } from "../ReportsWorkspace";

const IDS = {
  report: "1".repeat(24),
  job: "2".repeat(24),
};
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jobsBody() {
  return {
    jobs: [
      {
        id: IDS.job,
        title: "Senior platform engineer",
        status: "open",
        jdText: "not read by the reports client",
        applicationCount: 4,
      },
    ],
  };
}

function reportView(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.report,
    reportKind: "pipeline_status",
    format: "pdf",
    status: "requested",
    requestedAt: "2026-08-15T10:00:00.000Z",
    expiresAt: "2026-08-22T10:00:00.000Z",
    readyAt: null,
    objectKey: "hire-report-exports/v1/private.pdf",
    reportSnapshot: { candidateEmail: "never-show@example.test" },
    failureCode: "storage_failed",
    downloadUrl: "https://storage.example/private.pdf",
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("crypto", { randomUUID: () => OPERATION_ID });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ReportsWorkspace", () => {
  it("shows only opaque lifecycle data and links to the existing authenticated CSV export", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/workspace/reports")
        return Promise.resolve(response({ reportExports: [reportView()] }));
      if (url === "/api/workspace/reports/job-options")
        return Promise.resolve(response(jobsBody()));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReportsWorkspace />);

    await screen.findByText("Pipeline status · PDF");
    expect(
      screen.getByRole("link", { name: "Download candidate CSV" }),
    ).toHaveAttribute("href", "/api/workspace/export/candidates");
    expect(screen.queryByText("never-show@example.test")).toBeNull();
    expect(screen.queryByText("hire-report-exports/v1/private.pdf")).toBeNull();
    expect(screen.queryByText("storage_failed")).toBeNull();
    expect(
      screen.queryByText("https://storage.example/private.pdf"),
    ).toBeNull();
    expect(__hireReportsWorkspace.reportExportFrom(reportView())).toEqual({
      id: IDS.report,
      reportKind: "pipeline_status",
      format: "pdf",
      status: "requested",
      requestedAt: "2026-08-15T10:00:00.000Z",
      expiresAt: "2026-08-22T10:00:00.000Z",
      readyAt: null,
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/workspace/jobs",
      expect.anything(),
    );
  });

  it("requests a job-scoped XLSX with only the operation coordinates and supports copying the operation id", async () => {
    let requestPayload: unknown;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/workspace/reports" && init?.method === "POST") {
        requestPayload = JSON.parse(String(init.body));
        return Promise.resolve(
          response(
            {
              reportExport: reportView({ format: "xlsx", status: "requested" }),
            },
            201,
          ),
        );
      }
      if (url === "/api/workspace/reports")
        return Promise.resolve(response({ reportExports: [] }));
      if (url === "/api/workspace/reports/job-options")
        return Promise.resolve(response(jobsBody()));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReportsWorkspace />);
    await screen.findByRole("button", { name: "Create pipeline PDF" });
    fireEvent.change(screen.getByLabelText("Scope"), {
      target: { value: "job" },
    });
    fireEvent.change(screen.getByLabelText("Format"), {
      target: { value: "xlsx" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create pipeline XLSX" }),
    );

    await waitFor(() => {
      expect(requestPayload).toEqual({
        scope: "job",
        jobId: IDS.job,
        format: "xlsx",
        operationId: OPERATION_ID,
      });
    });
    expect(screen.getByText(OPERATION_ID)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy operation ID" }));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(OPERATION_ID);
    });
    expect(screen.getByText("Pipeline status · XLSX")).toBeTruthy();
  });

  it("polls opaque status and downloads the ready artifact through the member route", async () => {
    const createObjectURL = vi.fn(() => "blob:local-private-download");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/workspace/reports")
        return Promise.resolve(
          response({ reportExports: [reportView({ format: "xlsx" })] }),
        );
      if (url === "/api/workspace/reports/job-options")
        return Promise.resolve(response(jobsBody()));
      if (url === `/api/workspace/reports/${IDS.report}`) {
        return Promise.resolve(
          response({
            reportExport: reportView({
              format: "xlsx",
              status: "ready",
              readyAt: "2026-08-15T10:01:00.000Z",
            }),
          }),
        );
      }
      if (url === `/api/workspace/reports/${IDS.report}/download`) {
        return Promise.resolve(
          new Response("PK-safe", {
            status: 200,
            headers: {
              "Content-Type":
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            },
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReportsWorkspace />);
    await screen.findByText("Pipeline status · XLSX");
    await screen.findByRole(
      "button",
      { name: "Download XLSX" },
      { timeout: 4_500 },
    );
    fireEvent.click(screen.getByRole("button", { name: "Download XLSX" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/workspace/reports/${IDS.report}/download`,
        { cache: "no-store" },
      );
    });
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:local-private-download");
    expect(anchorClick).toHaveBeenCalled();
  });
});
