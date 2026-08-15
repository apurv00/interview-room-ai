import { describe, expect, it } from "vitest";
import { UpdateHireDigestPreferenceSchema } from "../validators/hireDigest";

describe("Hire digest preference validator", () => {
  it("accepts only the explicit enabled boolean", () => {
    expect(UpdateHireDigestPreferenceSchema.parse({ enabled: true })).toEqual({
      enabled: true,
    });
    expect(UpdateHireDigestPreferenceSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
  });

  it("rejects coercion and all recipient, outbox, and payload fields", () => {
    for (const value of [
      { enabled: "true" },
      { enabled: true, recipientEmail: "member@example.com" },
      { enabled: false, outboxId: "outbox" },
      { enabled: true, payload: { candidateName: "private" } },
    ]) {
      expect(() => UpdateHireDigestPreferenceSchema.parse(value)).toThrow();
    }
  });
});
