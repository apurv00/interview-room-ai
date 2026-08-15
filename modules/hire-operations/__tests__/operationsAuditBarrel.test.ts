import { describe, expect, it, vi } from "vitest";

vi.mock("@hire", () => {
  throw new Error("Phase-5 operations must not load the broad @hire barrel");
});

import {
  HIRE_OPERATIONS_AUDIT_KINDS,
  HireOperationsAuditQuerySchema,
  parseHireOperationsAuditCursor,
  readHireWorkspaceAudit,
} from "@hire-operations";

describe("Phase-5 audit public boundary", () => {
  it("publishes a stable, focused read-only audit contract", () => {
    expect(HIRE_OPERATIONS_AUDIT_KINDS).toContain("report_ready");
    expect(HireOperationsAuditQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(parseHireOperationsAuditCursor).toBeTypeOf("function");
    expect(readHireWorkspaceAudit).toBeTypeOf("function");
  });
});
