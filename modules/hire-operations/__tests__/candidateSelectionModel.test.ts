import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { HireCandidateSelectionSnapshot } from "../models/HireCandidateSelectionSnapshot";

const oid = (value: string) => new mongoose.Types.ObjectId(value);

describe("HireCandidateSelectionSnapshot model", () => {
  it("is immutable, bounded, contains no candidate PII, and does not auto-index", () => {
    expect(HireCandidateSelectionSnapshot.schema.options.autoIndex).toBe(false);
    expect(HireCandidateSelectionSnapshot.schema.options.autoCreate).toBe(false);
    expect(HireCandidateSelectionSnapshot.schema.path("entries")).toBeDefined();
    for (const forbidden of [
      "candidateId",
      "candidateName",
      "email",
      "resumeText",
      "evidence",
      "capability",
      "queryFingerprint",
    ]) {
      expect(HireCandidateSelectionSnapshot.schema.path(forbidden)).toBeUndefined();
    }
  });

  it("declares the exact scoped lookup and TTL indexes for explicit preparation", () => {
    expect(HireCandidateSelectionSnapshot.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { workspaceId: 1, jobId: 1, memberId: 1, expiresAt: 1, _id: 1 },
          expect.objectContaining({
            name: "workspaceId_1_jobId_1_memberId_1_expiresAt_1__id_1",
          }),
        ],
        [
          { expiresAt: 1 },
          expect.objectContaining({ name: "expiresAt_1", expireAfterSeconds: 0 }),
        ],
      ]),
    );
  });

  it("rejects a count that does not match the immutable entries", async () => {
    const model = new HireCandidateSelectionSnapshot({
      workspaceId: oid("111111111111111111111111"),
      jobId: oid("222222222222222222222222"),
      memberId: oid("333333333333333333333333"),
      mode: "explicit",
      entries: [
        {
          applicationId: oid("444444444444444444444444"),
          expectedStage: "new",
        },
      ],
      count: 2,
      description: "This page · 1 candidate",
      expiresAt: new Date("2026-08-25T12:15:00.000Z"),
    });
    await expect(model.validate()).rejects.toThrow("Selection count");
  });
});
