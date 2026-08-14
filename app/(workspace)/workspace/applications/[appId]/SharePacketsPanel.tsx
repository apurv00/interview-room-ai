"use client";

import { useCallback, useEffect, useState } from "react";
import Badge from "@shared/ui/Badge";
import Button from "@shared/ui/Button";

type PacketSection = "candidate_brief" | "ai_assessments" | "human_scorecards";
type PacketStatus = "active" | "verdict_submitted" | "revoked";

interface SharePacketView {
  id: string;
  allowedSections: PacketSection[];
  status: PacketStatus;
  active: boolean;
  expiresAt: string;
  verdictSubmittedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const SECTIONS: Array<{ value: PacketSection; label: string; help: string }> = [
  {
    value: "candidate_brief",
    label: "Candidate brief",
    help: "Name, role, location, and experience when available.",
  },
  {
    value: "ai_assessments",
    label: "AI assessments",
    help: "Completed numeric summaries only; no transcript, media, or raw output.",
  },
  {
    value: "human_scorecards",
    label: "Human scorecard summary",
    help: "Recommendation counts and rubric distributions, not individual evidence.",
  },
];

function packetBadge(packet: SharePacketView): {
  label: string;
  variant: "default" | "primary" | "success" | "caution";
} {
  if (packet.status === "verdict_submitted")
    return { label: "verdict received", variant: "success" };
  if (packet.status === "revoked")
    return { label: "revoked", variant: "default" };
  if (new Date(packet.expiresAt).getTime() <= Date.now())
    return { label: "expired", variant: "caution" };
  return { label: "active", variant: "primary" };
}

async function responseError(
  response: Response,
  fallback: string,
): Promise<string> {
  const body = await response.json().catch(() => ({}));
  return typeof body.error === "string" ? body.error : fallback;
}

/**
 * Member-side creation is copy-only: only the initial POST result holds the
 * raw fragment capability. Every list/revoke refresh intentionally excludes
 * it, preserving hash-only server storage and a one-time copy experience.
 */
export default function SharePacketsPanel({
  applicationId,
  jobIsOpen,
  terminal,
}: {
  applicationId: string;
  jobIsOpen: boolean;
  terminal: boolean;
}) {
  const [packets, setPackets] = useState<SharePacketView[]>([]);
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [sections, setSections] = useState<PacketSection[]>(
    SECTIONS.map((section) => section.value),
  );
  const [operationId, setOperationId] = useState<string | null>(null);
  const [copyLink, setCopyLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canCreate = jobIsOpen && !terminal;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/workspace/applications/${applicationId}/share-packets`,
        {
          cache: "no-store",
        },
      );
      if (!response.ok) {
        setError(
          await responseError(response, "Could not load share packets."),
        );
        return;
      }
      const body = await response.json();
      setPackets(Array.isArray(body.sharePackets) ? body.sharePackets : []);
    } catch {
      setError("Something went wrong. Check your connection.");
    } finally {
      setLoading(false);
    }
  }, [applicationId]);

  useEffect(() => {
    if (!opened) return;
    void load();
  }, [load, opened]);

  function toggleSection(section: PacketSection) {
    setSections((current) =>
      current.includes(section)
        ? current.filter((item) => item !== section)
        : [...current, section],
    );
  }

  async function createPacket() {
    if (!canCreate || sections.length === 0) return;
    const commandId = operationId ?? crypto.randomUUID();
    setOperationId(commandId);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/workspace/applications/${applicationId}/share-packets`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            allowedSections: sections,
            operationId: commandId,
          }),
          cache: "no-store",
        },
      );
      if (!response.ok) {
        setError(
          await responseError(response, "Could not create a share packet."),
        );
        return;
      }
      const body = await response.json();
      if (typeof body.shareUrl === "string") {
        setCopyLink(body.shareUrl);
        setNotice(
          "Share packet created. Copy the secure link now; it cannot be recovered later.",
        );
      } else {
        setCopyLink(null);
        setNotice(
          "This request was already completed. The one-time link cannot be recovered; create a new packet if needed.",
        );
      }
      setOperationId(null);
      setShowCreate(false);
      await load();
    } catch {
      setError("Something went wrong. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  async function copyPacketLink() {
    if (!copyLink) return;
    try {
      await navigator.clipboard.writeText(copyLink);
      // The raw fragment capability exists only for this first copy action.
      // List and revoke responses never contain it, and it is removed from the
      // member view once the clipboard accepts it.
      setCopyLink(null);
      setNotice("Share link copied. The raw link is no longer shown.");
    } catch {
      setError("Clipboard access was blocked. Select and copy the link below.");
    }
  }

  async function revokePacket(packet: SharePacketView) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/workspace/share-packets/${packet.id}/revoke`,
        {
          method: "POST",
          cache: "no-store",
        },
      );
      if (!response.ok) {
        setError(
          await responseError(response, "Could not revoke this share packet."),
        );
        return;
      }
      setNotice("Share packet revoked.");
      if (copyLink) setCopyLink(null);
      await load();
    } catch {
      setError("Something went wrong. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-5"
      aria-labelledby="share-packets-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="share-packets-heading"
            className="text-sm font-semibold text-[#0f1419]"
          >
            Share packets
          </h2>
          <p className="mt-1 text-xs text-[#71767b]">
            Create an expiring, no-login evidence packet for one external
            verdict. Packets never send email automatically.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => setOpened((value) => !value)}
        >
          {opened ? "Hide packet manager" : "Manage share packets"}
        </Button>
      </div>

      {!canCreate && opened ? (
        <p className="text-xs text-[#71767b]">
          Share packets can be created only while this application and job are
          active.
        </p>
      ) : null}
      {!opened ? (
        <p className="text-xs text-[#71767b]">
          Open the packet manager to create, revoke, or review external-verdict
          packets.
        </p>
      ) : null}

      {opened ? (
        <>
          {canCreate ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => setShowCreate((value) => !value)}
            >
              {showCreate ? "Cancel packet" : "Create share packet"}
            </Button>
          ) : null}
          {error ? (
            <p className="text-sm text-[#f4212e]" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? <p className="text-sm text-emerald-700">{notice}</p> : null}

          {showCreate && canCreate ? (
            <div className="space-y-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
              <div>
                <h3 className="text-sm font-medium text-indigo-950">
                  Choose what to include
                </h3>
                <p className="mt-1 text-xs text-indigo-900">
                  The selected immutable snapshot is the only content the
                  recipient can see.
                </p>
              </div>
              <div className="space-y-3">
                {SECTIONS.map((section) => (
                  <label
                    key={section.value}
                    className="flex cursor-pointer items-start gap-3 rounded-lg bg-white/70 p-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={sections.includes(section.value)}
                      onChange={() => toggleSection(section.value)}
                      className="mt-0.5 h-4 w-4"
                    />
                    <span>
                      <span className="block font-medium text-[#0f1419]">
                        {section.label}
                      </span>
                      <span className="mt-0.5 block text-xs text-[#536471]">
                        {section.help}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <Button
                size="sm"
                disabled={busy || sections.length === 0}
                onClick={() => void createPacket()}
              >
                {busy ? "Creating…" : "Create copy-only link"}
              </Button>
            </div>
          ) : null}

          {copyLink ? (
            <div className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm">
              <p className="font-medium text-indigo-950">
                Copy this one-time share link now.
              </p>
              <code className="block break-all text-xs text-indigo-900">
                {copyLink}
              </code>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void copyPacketLink()}
              >
                Copy share link
              </Button>
            </div>
          ) : null}

          {loading ? (
            <p className="text-sm text-[#536471]" role="status">
              Loading share packets…
            </p>
          ) : packets.length === 0 ? (
            <p className="text-sm text-[#536471]">
              No share packets created yet.
            </p>
          ) : (
            <div className="space-y-3">
              {packets.map((packet) => {
                const chip = packetBadge(packet);
                return (
                  <div
                    key={packet.id}
                    className="space-y-3 rounded-xl border border-[#e1e8ed] p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-[#0f1419]">
                          External verdict packet
                        </p>
                        <p className="mt-1 text-xs text-[#71767b]">
                          Created {new Date(packet.createdAt).toLocaleString()}{" "}
                          · expires{" "}
                          {new Date(packet.expiresAt).toLocaleString()}
                          {packet.verdictSubmittedAt
                            ? ` · verdict received ${new Date(packet.verdictSubmittedAt).toLocaleString()}`
                            : ""}
                          {packet.revokedAt
                            ? ` · revoked ${new Date(packet.revokedAt).toLocaleString()}`
                            : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={chip.variant}>{chip.label}</Badge>
                        {packet.status === "active" &&
                        packet.active &&
                        canCreate ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void revokePacket(packet)}
                          >
                            Revoke packet
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <p className="text-xs text-[#536471]">
                      Includes:{" "}
                      {packet.allowedSections
                        .map(
                          (section) =>
                            SECTIONS.find((item) => item.value === section)
                              ?.label ?? section,
                        )
                        .join(", ")}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
