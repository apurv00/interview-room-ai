"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import Button from "@shared/ui/Button";
import Input from "@shared/ui/Input";
import StateView from "@shared/ui/StateView";
import CompanyIdentityCard from "../overview/CompanyIdentityCard";

interface WorkspaceSettingsView {
  name: string;
  companyDescription: string | null;
  companyLogo: { updatedAt: string } | null;
  guestAuthMode: "magic_link" | "otp";
  lifecycleState: "active" | "deletion_pending";
  purgeAfter: string | null;
  deletedByName: string | null;
}

interface CurrentMembership {
  id: string;
  email: string;
  role: "admin" | "member";
  directAccount: boolean;
}

interface MemberIdentity {
  id: string;
}

function formatLongDate(value: string | null): string {
  if (!value) return "the end of the recovery period";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(
    new Date(value),
  );
}

export default function WorkspaceSettings() {
  const [workspace, setWorkspace] = useState<WorkspaceSettingsView | null>(null);
  const [membership, setMembership] = useState<CurrentMembership | null>(null);
  const [members, setMembers] = useState<MemberIdentity[] | null>(null);
  const [guestAuthMode, setGuestAuthMode] = useState<"magic_link" | "otp">(
    "magic_link",
  );
  const [savingMode, setSavingMode] = useState(false);
  const [modeNotice, setModeNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false);
  const [deleteOperationId, setDeleteOperationId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [restoreOperationId, setRestoreOperationId] =
    useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [selfDeleteOpen, setSelfDeleteOpen] = useState(false);
  const [selfDeleteEmail, setSelfDeleteEmail] = useState("");
  const [selfDeleteWorkspaceName, setSelfDeleteWorkspaceName] = useState("");
  const [selfDeleteWorkspaceAcknowledged, setSelfDeleteWorkspaceAcknowledged] =
    useState(false);
  const [selfDeleteOperationId, setSelfDeleteOperationId] =
    useState<string | null>(null);
  const [selfDeleting, setSelfDeleting] = useState(false);
  const [selfDeleteError, setSelfDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [membersResponse, workspaceResponse] = await Promise.all([
        fetch("/api/workspace/members", { cache: "no-store" }),
        fetch("/api/workspace", { cache: "no-store" }),
      ]);
      const [membersData, workspaceData] = await Promise.all([
        membersResponse.json().catch(() => ({})),
        workspaceResponse.json().catch(() => ({})),
      ]);
      if (
        !workspaceResponse.ok ||
        !workspaceData.workspace ||
        !workspaceData.membership
      ) {
        throw new Error(workspaceData.error);
      }

      const nextWorkspace = workspaceData.workspace as WorkspaceSettingsView;
      setWorkspace(nextWorkspace);
      setMembership(workspaceData.membership as CurrentMembership);
      setGuestAuthMode(nextWorkspace.guestAuthMode);

      if (nextWorkspace.lifecycleState === "deletion_pending") {
        // Normal member reads intentionally close after the lifecycle tombstone;
        // the workspace read remains available solely for recovery.
        setMembers([]);
        return;
      }
      if (!membersResponse.ok || !Array.isArray(membersData.members)) {
        throw new Error(membersData.error);
      }
      setMembers(membersData.members as MemberIdentity[]);
    } catch {
      setError("Could not load workspace settings.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveMode(mode: "magic_link" | "otp") {
    setSavingMode(true);
    setModeNotice(null);
    const previous = guestAuthMode;
    setGuestAuthMode(mode);
    try {
      const response = await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guestAuthMode: mode }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setGuestAuthMode(previous);
        setModeNotice(data.error || "Could not save the setting.");
        return;
      }
      setModeNotice("Saved — applies to invites sent from now on.");
    } catch {
      setGuestAuthMode(previous);
      setModeNotice("Could not save the setting. Check your connection.");
    } finally {
      setSavingMode(false);
    }
  }

  async function deleteWorkspace() {
    if (!workspace) return;
    const operationId = deleteOperationId ?? crypto.randomUUID();
    setDeleteOperationId(operationId);
    setDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch("/api/workspace/lifecycle/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmationName: deleteConfirmation,
          acknowledgePermanentPurge: deleteAcknowledged,
          operationId,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setDeleteError(data.error || "Could not schedule workspace deletion.");
        return;
      }
      setWorkspace(data.workspace);
      setMembers([]);
      setDeleteConfirmation("");
      setDeleteAcknowledged(false);
    } catch {
      setDeleteError(
        "Could not schedule workspace deletion. Check your connection.",
      );
    } finally {
      setDeleting(false);
    }
  }

  async function restoreWorkspace() {
    const operationId = restoreOperationId ?? crypto.randomUUID();
    setRestoreOperationId(operationId);
    setRestoring(true);
    setRestoreError(null);
    try {
      const response = await fetch("/api/workspace/lifecycle/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setRestoreError(data.error || "Could not restore the workspace.");
        return;
      }
      setWorkspace(data.workspace);
      setRestoreOperationId(null);
      await load();
    } catch {
      setRestoreError("Could not restore the workspace. Check your connection.");
    } finally {
      setRestoring(false);
    }
  }

  async function deleteMyHireAccount() {
    if (!workspace || !membership) return;
    const operationId = selfDeleteOperationId ?? crypto.randomUUID();
    setSelfDeleteOperationId(operationId);
    setSelfDeleting(true);
    setSelfDeleteError(null);
    try {
      const response = await fetch("/api/hire-auth/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId,
          ...(membership.role === "admin"
            ? {
                workspaceConfirmationName: selfDeleteWorkspaceName,
                acknowledgeWorkspaceDeletion: selfDeleteWorkspaceAcknowledged,
              }
            : {}),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSelfDeleteError(data.error || "Could not delete your Hire account.");
        return;
      }
      window.location.href = "/hire-signin?account_deleted=1";
    } catch {
      setSelfDeleteError(
        "Could not delete your Hire account. Check your connection.",
      );
    } finally {
      setSelfDeleting(false);
    }
  }

  if (error) {
    return <StateView state="error" error={error} onRetry={() => void load()} />;
  }
  if (!workspace || !membership || members === null) {
    return <StateView state="loading" skeletonLayout="list" />;
  }

  if (workspace.lifecycleState === "deletion_pending") {
    return (
      <div id="data-privacy" className="mx-auto max-w-2xl space-y-6 scroll-mt-6">
        <div>
          <p className="text-sm font-medium text-indigo-700">Data &amp; privacy</p>
          <h1 className="mt-1 text-xl font-bold text-[#0f1419]">
            Workspace scheduled for deletion
          </h1>
          <p className="mt-2 text-sm text-[#536471]">
            {workspace.name} is locked. Team access and new hiring writes are
            blocked, and public apply links plus active guest sessions were
            revoked immediately.
          </p>
        </div>
        <div className="space-y-4 rounded-2xl border border-amber-300 bg-amber-50 p-6">
          <p className="text-sm text-amber-950">
            The workspace data remains recoverable through{" "}
            <strong>{formatLongDate(workspace.purgeAfter)}</strong>. After that
            date, jobs, candidates, and media are eligible for permanent purge.
          </p>
          {workspace.deletedByName ? (
            <p className="text-xs text-amber-900">
              Scheduled by {workspace.deletedByName}.
            </p>
          ) : null}
          {membership.role === "admin" ? (
            <Button onClick={() => void restoreWorkspace()} disabled={restoring}>
              {restoring ? "Restoring…" : "Restore workspace"}
            </Button>
          ) : (
            <p className="text-sm text-amber-950">
              Ask the workspace administrator to restore access before the
              recovery period ends.
            </p>
          )}
          {restoreError ? (
            <p className="text-sm text-[#f4212e]" role="alert">
              {restoreError}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  const hasDataPrivacyControls =
    membership.role === "admin" || membership.directAccount;

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm font-medium text-indigo-700">
          Workspace configuration
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-[#0f1419]">
          Settings
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[#536471]">
          Manage company identity, the candidate sign-in experience, and data
          lifecycle controls without mixing them into Team access.
        </p>
      </header>

      <nav
        aria-label="Settings sections"
        className="-mx-1 overflow-x-auto px-1 pb-1"
      >
        <ul className="flex min-w-max gap-2">
          <li>
            <a
              href="#company"
              className="block rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50"
            >
              Company
            </a>
          </li>
          {membership.role === "admin" ? (
            <li>
              <a
                href="#candidate-experience"
                className="block rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50"
              >
                Candidate experience
              </a>
            </li>
          ) : null}
          {hasDataPrivacyControls ? (
            <li>
              <a
                href="#data-privacy"
                className="block rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50"
              >
                Data &amp; privacy
              </a>
            </li>
          ) : null}
        </ul>
      </nav>

      <div id="company" className="scroll-mt-6">
        <CompanyIdentityCard
          initialWorkspace={workspace}
          membershipRole={membership.role}
        />
      </div>

      {membership.role === "admin" ? (
        <section
          id="candidate-experience"
          aria-labelledby="candidate-experience-title"
          className="scroll-mt-6 space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-6"
        >
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-indigo-700">
              Candidate experience
            </p>
            <h2
              id="candidate-experience-title"
              className="mt-1 text-lg font-semibold text-[#0f1419]"
            >
              Candidate verification on interview links
            </h2>
            <p className="mt-2 text-sm text-[#536471]">
              Applies to invites sent from now on — links already in candidates&apos;
              inboxes keep the mode they were sent with.
            </p>
          </div>
          <fieldset disabled={savingMode} className="space-y-3">
            <legend className="sr-only">Candidate verification method</legend>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="ws-guest-auth"
                checked={guestAuthMode === "magic_link"}
                onChange={() => void saveMode("magic_link")}
                className="mt-0.5"
              />
              <span>
                <strong>Magic link</strong> — the emailed link takes candidates
                straight to the consent screen and interview.
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="ws-guest-auth"
                checked={guestAuthMode === "otp"}
                onChange={() => void saveMode("otp")}
                className="mt-0.5"
              />
              <span>
                <strong>Email code</strong> — candidates additionally confirm a
                6-digit code emailed to them before starting.
              </span>
            </label>
          </fieldset>
          {modeNotice ? (
            <p
              className={`text-xs ${
                modeNotice.startsWith("Saved")
                  ? "text-emerald-600"
                  : "text-[#f4212e]"
              }`}
              aria-live="polite"
            >
              {modeNotice}
            </p>
          ) : null}
        </section>
      ) : null}

      {hasDataPrivacyControls ? (
        <section
          id="data-privacy"
          aria-labelledby="data-privacy-title"
          className="scroll-mt-6 space-y-5"
        >
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-indigo-700">
              Data &amp; privacy
            </p>
            <h2
              id="data-privacy-title"
              className="mt-1 text-lg font-semibold text-[#0f1419]"
            >
              Lifecycle controls
            </h2>
          </div>

          {membership.role === "admin" ? (
            <section
              className="space-y-4 rounded-2xl border border-red-200 bg-white p-6"
              aria-labelledby="delete-workspace-title"
            >
              <div>
                <h3
                  id="delete-workspace-title"
                  className="font-semibold text-[#0f1419]"
                >
                  Delete workspace
                </h3>
                <p className="mt-2 text-sm text-[#536471]">
                  Access and public apply links stop immediately. Data is retained
                  for a 30-day recovery period and is then eligible for permanent
                  purge.
                </p>
                <a
                  href="/api/workspace/export/candidates"
                  className="mt-3 inline-flex text-sm font-medium text-[#1d9bf0] hover:underline"
                  download
                >
                  Download candidates and statuses (CSV) before deleting
                </a>
              </div>
              <div className="max-w-xl space-y-3">
                <Input
                  label={`Type “${workspace.name}” to confirm`}
                  value={deleteConfirmation}
                  onChange={(event) => setDeleteConfirmation(event.target.value)}
                  autoComplete="off"
                />
                <label className="flex items-start gap-2 text-sm text-[#0f1419]">
                  <input
                    type="checkbox"
                    checked={deleteAcknowledged}
                    onChange={(event) =>
                      setDeleteAcknowledged(event.target.checked)
                    }
                    className="mt-0.5"
                  />
                  <span>
                    I understand that the workspace and all hiring data can be
                    permanently purged after the 30-day recovery period.
                  </span>
                </label>
              </div>
              {deleteError ? (
                <p className="text-sm text-[#f4212e]" role="alert">
                  {deleteError}
                </p>
              ) : null}
              <Button
                variant="danger"
                onClick={() => void deleteWorkspace()}
                disabled={
                  deleting ||
                  deleteConfirmation !== workspace.name ||
                  !deleteAcknowledged
                }
              >
                {deleting ? "Scheduling deletion…" : "Delete workspace"}
              </Button>
            </section>
          ) : null}

          {membership.directAccount ? (
            <section
              className="space-y-4 rounded-2xl border border-red-200 bg-white p-6"
              aria-labelledby="delete-hire-account-title"
            >
              <div>
                <h3
                  id="delete-hire-account-title"
                  className="font-semibold text-[#0f1419]"
                >
                  Delete my Hire account
                </h3>
                <p className="mt-2 text-sm text-[#536471]">
                  Your access and active sessions end immediately. Hiring
                  decisions, notes, and scorecards remain with your name snapshot
                  so the audit history stays true.
                </p>
              </div>

              {membership.role === "admin" &&
              members.some((member) => member.id !== membership.id) ? (
                <p className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
                  You are the workspace administrator. Transfer administrator
                  access to an active member on the{" "}
                  <Link
                    href="/workspace/members"
                    className="font-semibold underline"
                  >
                    Team page
                  </Link>{" "}
                  before deleting your account.
                </p>
              ) : selfDeleteOpen ? (
                <div className="max-w-xl space-y-3">
                  <Input
                    label={`Type “${membership.email}” to confirm`}
                    type="email"
                    value={selfDeleteEmail}
                    onChange={(event) => setSelfDeleteEmail(event.target.value)}
                    autoComplete="off"
                  />
                  {membership.role === "admin" ? (
                    <>
                      <p className="text-sm text-[#536471]">
                        As the sole administrator, deleting your account also
                        schedules this workspace for deletion. It is recoverable
                        for 30 days; jobs, candidates, and media are purged after
                        that period.
                      </p>
                      <Input
                        label={`Type “${workspace.name}” to schedule workspace deletion`}
                        value={selfDeleteWorkspaceName}
                        onChange={(event) =>
                          setSelfDeleteWorkspaceName(event.target.value)
                        }
                        autoComplete="off"
                      />
                      <label className="flex items-start gap-2 text-sm text-[#0f1419]">
                        <input
                          type="checkbox"
                          checked={selfDeleteWorkspaceAcknowledged}
                          onChange={(event) =>
                            setSelfDeleteWorkspaceAcknowledged(
                              event.target.checked,
                            )
                          }
                          className="mt-0.5"
                        />
                        <span>
                          I understand the workspace enters a 30-day deletion
                          period.
                        </span>
                      </label>
                    </>
                  ) : null}
                  {selfDeleteError ? (
                    <p className="text-sm text-[#f4212e]" role="alert">
                      {selfDeleteError}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="danger"
                      onClick={() => void deleteMyHireAccount()}
                      disabled={
                        selfDeleting ||
                        selfDeleteEmail.trim().toLowerCase() !==
                          membership.email.toLowerCase() ||
                        (membership.role === "admin" &&
                          (selfDeleteWorkspaceName !== workspace.name ||
                            !selfDeleteWorkspaceAcknowledged))
                      }
                    >
                      {selfDeleting ? "Deleting…" : "Delete my Hire account"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setSelfDeleteOpen(false);
                        setSelfDeleteError(null);
                      }}
                      disabled={selfDeleting}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="danger"
                  onClick={() => {
                    setSelfDeleteOpen(true);
                    setSelfDeleteEmail("");
                    setSelfDeleteWorkspaceName("");
                    setSelfDeleteWorkspaceAcknowledged(false);
                    setSelfDeleteOperationId(null);
                    setSelfDeleteError(null);
                  }}
                >
                  Delete my Hire account
                </Button>
              )}
            </section>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
