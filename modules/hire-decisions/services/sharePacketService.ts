import crypto from "crypto";
import mongoose, { type ClientSession } from "mongoose";
import { AppError, NotFoundError } from "@shared/errors";
import {
  HireApplication,
  HireCandidate,
  HireJob,
  HirePrivacyRequest,
  HireWorkspace,
  activeHireWorkspaceLifecycleFilter,
  withActiveHireWorkspaceWriteTransaction,
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
  claimNonTerminalHireApplicationDispatchFence,
  resolveWorkspaceWriteAuthority,
  decodeWorkspaceResourceCapability,
  encodeWorkspaceResourceCapability,
  type MembershipContext,
} from "@hire-decision-boundary";
import {
  HireExternalVerdict,
  HireSharePacket,
  type IHireSharePacket,
} from "@hire-decisions/models";
import {
  HIRE_EXTERNAL_VERDICT_RECOMMENDATIONS,
  type HireExternalVerdictRecommendation,
  type HireSharePacketSection,
  type HireSharePacketSnapshot,
} from "@hire-decisions/types";
import {
  buildHireDecisionView,
  buildSharePacketSnapshot,
  HireDecisionError,
} from "@hire-decisions/services/decisionAggregateService";
import { connectHireDecisionDB } from "@hire-decisions/services/hireDecisionBoundary";

export const SHARE_PACKET_EXPIRY_DAYS = 7;

const OBJECT_ID = /^[a-f0-9]{24}$/i;

const PUBLIC_PACKET_INACTIVE_CODES = new Set([
  "SHARE_PACKET_NOT_ACTIVE",
  "WORKSPACE_DELETION_PENDING",
  "MEMBER_REMOVED",
  "APPLICATION_NOT_ELIGIBLE",
  "CANDIDATE_PRIVACY_PENDING",
  "HIRE_CANDIDATE_PII_TOMBSTONED",
]);

export interface CreateSharePacketInput {
  applicationId: string;
  allowedSections: HireSharePacketSection[];
  operationId: string;
}

export interface SharePacketMemberView {
  id: string;
  allowedSections: HireSharePacketSection[];
  status: "active" | "verdict_submitted" | "revoked";
  active: boolean;
  expiresAt: Date;
  verdictSubmittedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface CreateSharePacketResult {
  packet: SharePacketMemberView;
  /** Present only for the first successful create; the raw secret is never stored. */
  shareUrl: string | null;
  created: boolean;
}

export interface SharePacketBootstrapView {
  snapshot: HireSharePacketSnapshot;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requireObjectId(
  value: string,
  label: string,
): mongoose.Types.ObjectId {
  if (!OBJECT_ID.test(value))
    throw new AppError(`Invalid ${label}`, 400, "INVALID_ID");
  return new mongoose.Types.ObjectId(value);
}

function memberName(ctx: MembershipContext): string {
  return ctx.membership.name || ctx.membership.email;
}

function inactivePacketError(): AppError {
  return new AppError(
    "The share packet is no longer active",
    410,
    "SHARE_PACKET_NOT_ACTIVE",
  );
}

function isPublicPacketInactiveError(error: unknown): boolean {
  return (
    error instanceof AppError && PUBLIC_PACKET_INACTIVE_CODES.has(error.code)
  );
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

function publicPacketUrl(
  workspaceId: string,
  packetId: string,
  secret: string,
): string {
  const origin = (
    process.env.HIRE_PUBLIC_URL || "https://hire.interviewprep.guru"
  ).replace(/\/$/, "");
  const capability = encodeWorkspaceResourceCapability(
    workspaceId,
    packetId,
    secret,
  );
  return `${origin}/share-packet/${packetId}#packet=${encodeURIComponent(capability)}`;
}

function tally(value: Record<HireExternalVerdictRecommendation, number>) {
  return {
    strong_yes: value.strong_yes,
    yes: value.yes,
    no: value.no,
    strong_no: value.strong_no,
  };
}

/** Explicit output pick: a public packet never spreads its Mongoose document. */
function serializePublicSnapshot(
  packet: Pick<IHireSharePacket, "allowedSections" | "snapshot">,
): HireSharePacketSnapshot {
  const allowed = new Set(packet.allowedSections);
  const snapshot = packet.snapshot;
  return {
    version: 1,
    ...(allowed.has("candidate_brief") && snapshot.candidateBrief
      ? {
          candidateBrief: {
            candidateName: snapshot.candidateBrief.candidateName,
            jobTitle: snapshot.candidateBrief.jobTitle,
            ...(snapshot.candidateBrief.location
              ? { location: snapshot.candidateBrief.location }
              : {}),
            ...(snapshot.candidateBrief.experienceYears !== undefined
              ? { experienceYears: snapshot.candidateBrief.experienceYears }
              : {}),
          },
        }
      : {}),
    ...(allowed.has("ai_assessments") && snapshot.aiAssessments
      ? {
          aiAssessments: snapshot.aiAssessments.map((assessment) => ({
            completedAt: assessment.completedAt,
            overallScore: assessment.overallScore,
            ...(assessment.recommendation
              ? { recommendation: assessment.recommendation }
              : {}),
            ...(assessment.confidence
              ? { confidence: assessment.confidence }
              : {}),
            dimensions: assessment.dimensions.map((dimension) => ({
              key: dimension.key,
              ...(dimension.label ? { label: dimension.label } : {}),
              score: dimension.score,
            })),
          })),
        }
      : {}),
    ...(allowed.has("human_scorecards") && snapshot.humanScorecards
      ? {
          humanScorecards: {
            total: {
              count: snapshot.humanScorecards.total.count,
              recommendations: tally(
                snapshot.humanScorecards.total.recommendations,
              ),
              dimensions: snapshot.humanScorecards.total.dimensions.map(
                (dimension) => ({ ...dimension }),
              ),
            },
            member: {
              count: snapshot.humanScorecards.member.count,
              recommendations: tally(
                snapshot.humanScorecards.member.recommendations,
              ),
              dimensions: snapshot.humanScorecards.member.dimensions.map(
                (dimension) => ({ ...dimension }),
              ),
            },
            kit: {
              count: snapshot.humanScorecards.kit.count,
              recommendations: tally(
                snapshot.humanScorecards.kit.recommendations,
              ),
              dimensions: snapshot.humanScorecards.kit.dimensions.map(
                (dimension) => ({ ...dimension }),
              ),
            },
          },
        }
      : {}),
  };
}

function serializeMemberPacket(
  packet: Pick<
    IHireSharePacket,
    | "_id"
    | "allowedSections"
    | "status"
    | "active"
    | "expiresAt"
    | "verdictSubmittedAt"
    | "revokedAt"
    | "createdAt"
  >,
): SharePacketMemberView {
  return {
    id: packet._id.toString(),
    allowedSections: [...packet.allowedSections],
    status: packet.status,
    active: packet.active,
    expiresAt: packet.expiresAt,
    verdictSubmittedAt: packet.verdictSubmittedAt ?? null,
    revokedAt: packet.revokedAt ?? null,
    createdAt: packet.createdAt,
  };
}

async function assertPacketScopes(input: {
  packet: IHireSharePacket;
  now: Date;
  session: ClientSession;
}): Promise<void> {
  // Reads stay sequential in a transaction: Mongoose does not allow
  // parallel queries on the same transaction session.
  const workspace = await HireWorkspace.exists({
    _id: input.packet.workspaceId,
    ...activeHireWorkspaceLifecycleFilter(),
  }).session(input.session);
  const job = await HireJob.exists({
    _id: input.packet.jobId,
    workspaceId: input.packet.workspaceId,
    status: "open",
  }).session(input.session);
  const application = await HireApplication.exists({
    _id: input.packet.applicationId,
    workspaceId: input.packet.workspaceId,
    jobId: input.packet.jobId,
    candidateId: input.packet.candidateId,
    stage: { $nin: ["hired", "rejected", "withdrawn"] },
  }).session(input.session);
  const privacy = await HirePrivacyRequest.exists({
    workspaceId: input.packet.workspaceId,
    candidateId: input.packet.candidateId,
    live: true,
  }).session(input.session);
  if (!workspace || !job || !application || privacy)
    throw inactivePacketError();

  await claimHireCandidatePiiWriteFence({
    workspaceId: input.packet.workspaceId,
    candidateId: input.packet.candidateId,
    session: input.session,
  });
  await claimNonTerminalHireApplicationDispatchFence({
    workspaceId: input.packet.workspaceId,
    applicationId: input.packet.applicationId,
    jobId: input.packet.jobId,
    candidateId: input.packet.candidateId,
    now: input.now,
    session: input.session,
  });
}

async function loadActivePacket(input: {
  packetId: string;
  capability: string;
  now: Date;
  session: ClientSession;
}): Promise<{ packet: IHireSharePacket; secret: string } | null> {
  if (!OBJECT_ID.test(input.packetId)) return null;
  const capability = decodeWorkspaceResourceCapability(input.capability);
  if (!capability || capability.resourceId !== input.packetId.toLowerCase())
    return null;
  const packet = await HireSharePacket.findOne(
    {
      _id: input.packetId,
      workspaceId: capability.workspaceId,
      secretHash: sha256(capability.secret),
      active: true,
      status: "active",
      expiresAt: { $gt: input.now },
      revokedAt: { $exists: false },
    },
    null,
    { session: input.session },
  ).select("+secretHash");
  if (!packet) return null;
  return { packet, secret: capability.secret };
}

function sameSections(
  left: readonly HireSharePacketSection[],
  right: readonly HireSharePacketSection[],
): boolean {
  return (
    left.length === right.length &&
    left.every((section) => right.includes(section))
  );
}

/**
 * An idempotency retry must never reconstruct a raw capability. Both the
 * ordinary read and the duplicate-key recovery use this narrow result so a
 * concurrent create remains a safe copy-once operation.
 */
function existingCreateResult(input: {
  packet: IHireSharePacket;
  applicationId: mongoose.Types.ObjectId;
  allowedSections: HireSharePacketSection[];
}): CreateSharePacketResult {
  if (
    input.packet.applicationId.toString() !== input.applicationId.toString() ||
    !sameSections(input.packet.allowedSections, input.allowedSections)
  ) {
    throw new AppError(
      "That operation id was used for another share packet",
      409,
      "OPERATION_ID_REUSED",
    );
  }
  return {
    packet: serializeMemberPacket(input.packet),
    shareUrl: null,
    created: false,
  };
}

/**
 * Create a copy-only member link. No outbox, delivery record, provider call,
 * or persistent raw capability is involved in this flow.
 */
export async function createSharePacket(
  ctx: MembershipContext,
  input: CreateSharePacketInput,
): Promise<CreateSharePacketResult> {
  await connectHireDecisionDB();
  const applicationId = requireObjectId(input.applicationId, "application id");
  let decision;
  try {
    decision = await buildHireDecisionView({
      workspaceId: ctx.workspace._id.toString(),
      applicationId: applicationId.toString(),
    });
  } catch (error) {
    if (error instanceof HireDecisionError)
      throw new NotFoundError("Application");
    throw error;
  }
  if (
    decision.coordinates.workspaceId !== ctx.workspace._id.toString() ||
    decision.coordinates.applicationId !== applicationId.toString()
  ) {
    throw new NotFoundError("Application");
  }

  const now = new Date();
  const packetId = new mongoose.Types.ObjectId();
  const rawSecret = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(
    now.getTime() + SHARE_PACKET_EXPIRY_DAYS * 86_400_000,
  );
  try {
    return await withActiveHireWorkspaceWriteTransaction(
      ctx.workspace._id,
      ctx.membership._id,
      async (session) => {
        const existing = await HireSharePacket.findOne(
          {
            workspaceId: ctx.workspace._id,
            creationOperationId: input.operationId,
          },
          null,
          { session },
        );
        if (existing) {
          // The raw possession secret is intentionally unrecoverable after
          // the first response. This preserves hash-only storage instead of
          // weakening it for retry convenience.
          return existingCreateResult({
            packet: existing,
            applicationId,
            allowedSections: input.allowedSections,
          });
        }

        const application = await HireApplication.findOne(
          {
            _id: applicationId,
            workspaceId: ctx.workspace._id,
          },
          null,
          { session },
        );
        if (!application) throw new NotFoundError("Application");
        if (
          application.jobId.toString() !== decision.coordinates.jobId ||
          application.candidateId.toString() !==
            decision.coordinates.candidateId
        ) {
          throw new AppError(
            "The application changed while creating this packet",
            409,
            "APPLICATION_RACE",
          );
        }
        const jobClaim = await HireJob.updateOne(
          {
            _id: application.jobId,
            workspaceId: ctx.workspace._id,
            status: "open",
          },
          { $inc: { intakeWriteVersion: 1 } },
          { session },
        );
        if (jobClaim.matchedCount !== 1) {
          throw new AppError(
            "Share packets require an open job",
            409,
            "JOB_NOT_OPEN",
          );
        }
        const candidate = await HireCandidate.exists({
          _id: application.candidateId,
          workspaceId: ctx.workspace._id,
        }).session(session);
        if (!candidate) throw new NotFoundError("Application");
        const privacy = await HirePrivacyRequest.exists({
          workspaceId: ctx.workspace._id,
          candidateId: application.candidateId,
          live: true,
        }).session(session);
        if (privacy) {
          throw new AppError(
            "A candidate privacy request is in progress",
            409,
            "CANDIDATE_PRIVACY_PENDING",
          );
        }
        await claimHireCandidatePiiWriteFence({
          workspaceId: ctx.workspace._id,
          candidateId: application.candidateId,
          session,
        });
        await claimNonTerminalHireApplicationDispatchFence({
          workspaceId: ctx.workspace._id,
          applicationId: application._id,
          jobId: application.jobId,
          candidateId: application.candidateId,
          now,
          session,
        });

        const snapshot = buildSharePacketSnapshot(
          decision,
          input.allowedSections,
        );
        const [created] = await HireSharePacket.create(
          [
            {
              _id: packetId,
              workspaceId: ctx.workspace._id,
              applicationId: application._id,
              jobId: application.jobId,
              candidateId: application.candidateId,
              creationOperationId: input.operationId,
              secretHash: sha256(rawSecret),
              allowedSections: input.allowedSections,
              snapshot,
              active: true,
              status: "active",
              expiresAt,
            },
          ],
          { session },
        );
        return {
          packet: serializeMemberPacket(created),
          shareUrl: publicPacketUrl(
            ctx.workspace._id.toString(),
            packetId.toString(),
            rawSecret,
          ),
          created: true,
        };
      },
    );
  } catch (error) {
    // Mongo may surface a unique-index collision instead of retrying a
    // transaction whose concurrent peer just committed the same operation.
    // Re-read only the immutable, workspace-scoped idempotency record; never
    // expose or regenerate the raw possession secret.
    if (isDuplicateKey(error)) {
      const existing = await HireSharePacket.findOne({
        workspaceId: ctx.workspace._id,
        creationOperationId: input.operationId,
      });
      if (existing) {
        return existingCreateResult({
          packet: existing,
          applicationId,
          allowedSections: input.allowedSections,
        });
      }
    }
    if (error instanceof HireCandidatePiiTombstoneError) {
      throw new AppError(
        "Candidate personal data is unavailable",
        410,
        "HIRE_CANDIDATE_PII_TOMBSTONED",
      );
    }
    throw error;
  }
}

/** List member-visible packet state without an immutable snapshot or secret. */
export async function listSharePackets(
  ctx: MembershipContext,
  applicationId: string,
): Promise<SharePacketMemberView[]> {
  await connectHireDecisionDB();
  const id = requireObjectId(applicationId, "application id");
  const application = await HireApplication.exists({
    _id: id,
    workspaceId: ctx.workspace._id,
  });
  if (!application) throw new NotFoundError("Application");
  const packets = await HireSharePacket.find({
    workspaceId: ctx.workspace._id,
    applicationId: id,
  }).sort({ createdAt: -1 });
  return packets.map((packet) => serializeMemberPacket(packet));
}

/** Member-only revocation. It never contacts email, the AI runtime, or B2C. */
export async function revokeSharePacket(
  ctx: MembershipContext,
  packetId: string,
): Promise<SharePacketMemberView> {
  await connectHireDecisionDB();
  const id = requireObjectId(packetId, "share packet id");
  const now = new Date();
  const packet = await withActiveHireWorkspaceWriteTransaction(
    ctx.workspace._id,
    ctx.membership._id,
    async (session) => {
      const updated = await HireSharePacket.findOneAndUpdate(
        {
          _id: id,
          workspaceId: ctx.workspace._id,
          active: true,
          status: "active",
          revokedAt: { $exists: false },
        },
        {
          $set: {
            active: false,
            status: "revoked",
            revokedAt: now,
            revokedByMemberId: ctx.membership._id,
            revokedByName: memberName(ctx),
            revocationReason: "Recruiter revoked the share packet",
          },
        },
        { new: true, session },
      );
      if (!updated) throw new NotFoundError("Active share packet");
      return updated;
    },
  );
  return serializeMemberPacket(packet);
}

/**
 * Fixed bootstrap output for a public packet. The packet row itself is
 * conditionally touched after all privacy/lifecycle fences so a stale public
 * page cannot disclose a snapshot after a revocation or terminal decision.
 */
export async function bootstrapSharePacket(input: {
  packetId: string;
  capability: string;
}): Promise<SharePacketBootstrapView | null> {
  await connectHireDecisionDB();
  if (!OBJECT_ID.test(input.packetId)) return null;
  const decoded = decodeWorkspaceResourceCapability(input.capability);
  if (!decoded || decoded.resourceId !== input.packetId.toLowerCase())
    return null;
  const workspaceId = new mongoose.Types.ObjectId(decoded.workspaceId);
  const authorityMemberId = await resolveWorkspaceWriteAuthority(workspaceId);
  if (!authorityMemberId) return null;
  const now = new Date();
  try {
    return await withActiveHireWorkspaceWriteTransaction(
      workspaceId,
      authorityMemberId,
      async (session) => {
        const active = await loadActivePacket({ ...input, now, session });
        if (!active) throw inactivePacketError();
        await assertPacketScopes({ packet: active.packet, now, session });
        // Conditional packet claim serializes bootstrap with member revoke and
        // verdict consumption. `updatedAt` is a schema-owned mutex only.
        const claimed = await HireSharePacket.updateOne(
          {
            _id: active.packet._id,
            workspaceId: active.packet.workspaceId,
            secretHash: sha256(active.secret),
            active: true,
            status: "active",
            expiresAt: { $gt: now },
            revokedAt: { $exists: false },
          },
          { $set: { updatedAt: now } },
          { session, timestamps: false },
        );
        if (claimed.matchedCount !== 1) throw inactivePacketError();
        return { snapshot: serializePublicSnapshot(active.packet) };
      },
    );
  } catch (error) {
    if (
      error instanceof HireCandidatePiiTombstoneError ||
      isPublicPacketInactiveError(error)
    )
      return null;
    throw error;
  }
}

/**
 * Atomically consumes a public capability before persisting its one external
 * verdict. Every public lifecycle and PII fence is held in the same
 * transaction; a stale bootstrap never authorizes a later verdict.
 */
export async function submitExternalVerdict(input: {
  packetId: string;
  capability: string;
  recommendation: HireExternalVerdictRecommendation;
  comment?: string;
}): Promise<{ state: "submitted" } | null> {
  await connectHireDecisionDB();
  if (
    !OBJECT_ID.test(input.packetId) ||
    !HIRE_EXTERNAL_VERDICT_RECOMMENDATIONS.includes(input.recommendation)
  )
    return null;
  const decoded = decodeWorkspaceResourceCapability(input.capability);
  if (!decoded || decoded.resourceId !== input.packetId.toLowerCase())
    return null;
  const comment = input.comment?.trim();
  if (comment !== undefined && (!comment || comment.length > 2_000))
    return null;
  const workspaceId = new mongoose.Types.ObjectId(decoded.workspaceId);
  const authorityMemberId = await resolveWorkspaceWriteAuthority(workspaceId);
  if (!authorityMemberId) return null;
  const now = new Date();
  try {
    await withActiveHireWorkspaceWriteTransaction(
      workspaceId,
      authorityMemberId,
      async (session) => {
        const active = await loadActivePacket({ ...input, now, session });
        if (!active) throw inactivePacketError();
        await assertPacketScopes({ packet: active.packet, now, session });

        // This conditional update is deliberately before verdict creation. A
        // missed consume throws and aborts the transaction rather than leaving
        // orphan external evidence after a competing revoke/verdict wins.
        const consumed = await HireSharePacket.updateOne(
          {
            _id: active.packet._id,
            workspaceId: active.packet.workspaceId,
            secretHash: sha256(active.secret),
            active: true,
            status: "active",
            expiresAt: { $gt: now },
            revokedAt: { $exists: false },
          },
          {
            $set: {
              active: false,
              status: "verdict_submitted",
              verdictSubmittedAt: now,
            },
          },
          { session },
        );
        if (consumed.matchedCount !== 1) throw inactivePacketError();

        await HireExternalVerdict.create(
          [
            {
              workspaceId: active.packet.workspaceId,
              applicationId: active.packet.applicationId,
              jobId: active.packet.jobId,
              candidateId: active.packet.candidateId,
              packetId: active.packet._id,
              recommendation: input.recommendation,
              ...(comment ? { comment } : {}),
              submittedAt: now,
            },
          ],
          { session },
        );
      },
    );
    return { state: "submitted" };
  } catch (error) {
    if (
      error instanceof HireCandidatePiiTombstoneError ||
      isPublicPacketInactiveError(error) ||
      isDuplicateKey(error)
    )
      return null;
    throw error;
  }
}

export const __sharePacket = {
  publicPacketUrl,
  serializeMemberPacket,
  serializePublicSnapshot,
  sha256,
  sameSections,
  existingCreateResult,
};
