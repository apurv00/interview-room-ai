"use client";

/* eslint-disable @next/next/no-img-element -- the private member logo endpoint requires the browser session, which the image optimizer cannot forward. */

import { useCallback, useEffect, useState } from "react";
import Button from "@shared/ui/Button";

const LOGO_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const LOGO_MAX_BYTES = 512 * 1024;

type WorkspaceIdentity = {
  name: string;
  companyDescription: string | null;
  companyLogo: { updatedAt: string } | null;
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected logo."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Could not read the selected logo."));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export default function CompanyIdentityCard() {
  const [workspace, setWorkspace] = useState<WorkspaceIdentity | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/workspace", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.workspace) return;
      setWorkspace(data.workspace as WorkspaceIdentity);
      setIsAdmin(data.membership?.role === "admin");
    } catch {
      // The operational dashboard remains usable if the optional identity
      // card cannot load. It must not turn a cosmetic read into a blocker.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function uploadLogo() {
    if (!logoFile) return;
    setUploading(true);
    setError(null);
    setMessage(null);
    try {
      const dataUrl = await readFileAsDataUrl(logoFile);
      const response = await fetch("/api/workspace/branding/logo", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.workspace) {
        setError(data.error || "Could not upload the company logo.");
        return;
      }
      setWorkspace(data.workspace as WorkspaceIdentity);
      setLogoFile(null);
      setMessage("Company logo saved.");
      window.dispatchEvent(new Event("hire-workspace-brand-updated"));
    } catch {
      setError("Could not upload the company logo. Check your connection and try again.");
    } finally {
      setUploading(false);
    }
  }

  if (!workspace) return null;

  const logoSrc = workspace.companyLogo?.updatedAt
    ? `/api/workspace/branding/logo?v=${encodeURIComponent(
        workspace.companyLogo.updatedAt,
      )}`
    : null;

  return (
    <section
      aria-labelledby="company-identity-title"
      className="rounded-2xl border border-[#e1e8ed] bg-white p-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        {logoSrc ? (
          <img
            src={logoSrc}
            alt={`${workspace.name} logo`}
            className="h-16 w-16 shrink-0 rounded-xl border border-[#e1e8ed] bg-white object-contain"
          />
        ) : (
          <div
            aria-hidden
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-xl font-bold text-indigo-700"
          >
            {workspace.name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-indigo-700">
            Company profile
          </p>
          <h2
            id="company-identity-title"
            className="mt-1 truncate text-lg font-semibold text-[#0f1419]"
          >
            {workspace.name}
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[#536471]">
            {workspace.companyDescription ||
              "Your company description will appear here and inform new job descriptions."}
          </p>
        </div>
      </div>

      {isAdmin ? (
        <div className="mt-5 border-t border-[#eef2f7] pt-4">
          <label
            htmlFor="company-logo-replace"
            className="block text-sm font-medium text-[#0f1419]"
          >
            {logoSrc ? "Replace company logo" : "Add company logo"}
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              id="company-logo-replace"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0] ?? null;
                setMessage(null);
                if (!file) {
                  setLogoFile(null);
                  return;
                }
                if (!LOGO_CONTENT_TYPES.has(file.type) || file.size > LOGO_MAX_BYTES) {
                  event.currentTarget.value = "";
                  setLogoFile(null);
                  setError("Choose a PNG, JPEG, or WebP logo that is 512 KB or smaller.");
                  return;
                }
                setError(null);
                setLogoFile(file);
              }}
              className="block min-w-0 flex-1 text-sm text-[#536471] file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-indigo-700 hover:file:bg-indigo-100"
            />
            <Button
              type="button"
              variant="secondary"
              disabled={!logoFile || uploading}
              onClick={() => void uploadLogo()}
            >
              {uploading ? "Uploading…" : "Save logo"}
            </Button>
          </div>
          <p className="mt-2 text-xs text-[#71767b]">
            PNG, JPEG, or WebP up to 512 KB. This logo is private to your hiring workspace.
          </p>
          {error ? <p className="mt-2 text-xs text-[#f4212e]">{error}</p> : null}
          {message ? <p className="mt-2 text-xs text-emerald-700">{message}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
