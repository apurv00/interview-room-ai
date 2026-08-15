import { describe, expect, it } from "vitest";
import { HireOperationsAuditQuerySchema } from "../validators/hireOperations";

describe("Hire operations audit query validator", () => {
  it("uses a bounded, optional opaque cursor and a small default page", () => {
    expect(HireOperationsAuditQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(
      HireOperationsAuditQuerySchema.parse({
        cursor: "opaque-token",
        limit: "2",
      }),
    ).toEqual({ cursor: "opaque-token", limit: 2 });
  });

  it("rejects unknown, blank, and oversized audit query data", () => {
    expect(() =>
      HireOperationsAuditQuerySchema.parse({ cursor: " ", limit: 1 }),
    ).toThrow();
    expect(() =>
      HireOperationsAuditQuerySchema.parse({ cursor: "a".repeat(513) }),
    ).toThrow();
    expect(() =>
      HireOperationsAuditQuerySchema.parse({ limit: 101 }),
    ).toThrow();
    expect(() =>
      HireOperationsAuditQuerySchema.parse({ limit: 2, workspaceId: "other" }),
    ).toThrow();
  });
});
