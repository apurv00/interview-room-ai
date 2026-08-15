"use client";

import { useCallback, useEffect, useState } from "react";
import {
  digestPreferenceFrom,
  type DigestPreferenceView,
} from "./digestPreferenceView";

const DIGEST_PREFERENCE_ENDPOINT = "/api/workspace/digest-preference";

async function readDigestPreference(
  response: Response,
  failureMessage: string,
): Promise<DigestPreferenceView> {
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(failureMessage);
  const preference = digestPreferenceFrom(value);
  if (!preference) {
    throw new Error("The daily summary preference response was not valid.");
  }
  return preference;
}

function updatedLabel(value: string | null): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** Small, member-owned opt-in control; it never reads delivery/outbox state. */
export default function DigestPreferenceControl() {
  const [preference, setPreference] = useState<DigestPreferenceView | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(DIGEST_PREFERENCE_ENDPOINT, {
        cache: "no-store",
      });
      setPreference(
        await readDigestPreference(
          response,
          "Could not load the daily summary preference.",
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load the daily summary preference.",
      );
    }
  }, []);

  const update = useCallback(async () => {
    if (!preference || saving) return;
    setError(null);
    setSaving(true);
    try {
      const response = await fetch(DIGEST_PREFERENCE_ENDPOINT, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !preference.enabled }),
        cache: "no-store",
      });
      setPreference(
        await readDigestPreference(
          response,
          "Could not update the daily summary preference.",
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update the daily summary preference.",
      );
    } finally {
      setSaving(false);
    }
  }, [preference, saving]);

  useEffect(() => {
    void load();
  }, [load]);

  const updated = preference ? updatedLabel(preference.updatedAt) : null;

  return (
    <section
      className="rounded-2xl border border-[#e1e8ed] bg-white p-5"
      aria-labelledby="daily-summary-settings-title"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2
            id="daily-summary-settings-title"
            className="text-base font-semibold text-[#0f1419]"
          >
            Daily hiring summary
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-[#536471]">
            Daily email summaries are off by default. When enabled, they contain
            only aggregate hiring counts and can be turned off here at any time.
          </p>
          {preference ? (
            <p className="mt-2 text-sm text-[#536471]" aria-live="polite">
              Daily summary emails are currently{" "}
              {preference.enabled ? "on" : "off"}
              {updated ? ` · Updated ${updated}` : ""}.
            </p>
          ) : error ? (
            <p className="mt-2 text-sm text-red-700" role="alert">
              {error}
            </p>
          ) : (
            <p className="mt-2 text-sm text-[#536471]" aria-live="polite">
              Loading preference…
            </p>
          )}
          {error && preference ? (
            <p className="mt-2 text-sm text-red-700" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        {preference ? (
          <button
            type="button"
            onClick={() => void update()}
            disabled={saving}
            aria-pressed={preference.enabled}
            className="shrink-0 rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving
              ? "Saving…"
              : preference.enabled
                ? "Turn off daily summary"
                : "Turn on daily summary"}
          </button>
        ) : error ? (
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50"
          >
            Retry
          </button>
        ) : null}
      </div>
    </section>
  );
}
