'use client'

/**
 * Bulk resume upload (Phase 2 PR-2) — the client half of the per-file
 * atomic intake design: each file is ONE request to
 * /api/workspace/jobs/[jobId]/intake, fanned out at small concurrency with
 * individual retries, so a deploy mid-batch or one corrupt PDF costs
 * exactly that file (no Inngest by design — founder decision 2026-08-09).
 *
 * Per-file states mirror the endpoint's contract:
 *   - 422 NO_EMAIL → inline fix-up row (type the email, retry with override)
 *   - createdApplication:false → "already in pipeline" (idempotent re-upload)
 *   - seenBefore[] → chips linking the person's other applications
 *   - resumeMatch → JD-match score chip (null score = unscored, still added)
 */

import { useRef, useState } from 'react'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'
import { scoreBand } from '@shared/ui/ScoreBar'

const MAX_BATCH = 20
const CONCURRENCY = 3
const ACCEPT = '.pdf,.docx,.txt'

interface SeenBefore {
  jobId: string
  jobTitle: string
  stage: string
}

interface FileRow {
  key: string
  file: File
  status: 'queued' | 'uploading' | 'done' | 'needs_email' | 'error'
  /** Server-extracted name shown on the fix-up row. */
  extractedName?: string | null
  /** IDENTITY_CONFLICT explanation — email belongs to someone else. */
  conflictNote?: string
  emailFix?: string
  /** Override carried through the queue on a retry/fix-up submission. */
  pendingOverride?: string
  error?: string
  result?: {
    candidateName: string
    candidateEmail: string
    createdApplication: boolean
    score: number | null
    seenBefore: SeenBefore[]
  }
}

function scoreVariant(score: number): 'success' | 'caution' | 'danger' {
  const band = scoreBand(score)
  return band === 'strong' ? 'success' : band === 'ok' ? 'caution' : 'danger'
}

export default function BulkUploadPanel({
  jobId,
  onSettled,
}: {
  jobId: string
  /** Called once when every file in the current batch reaches a terminal state. */
  onSettled: () => void
}) {
  const [rows, setRows] = useState<FileRow[]>([])
  const inFlightRef = useRef(0)
  const queueRef = useRef<FileRow[]>([])
  // Mirror of `rows` for the batch-capacity check — synchronous, so two
  // quick selections can't both read a pre-append count.
  const rowsRef = useRef<FileRow[]>([])
  rowsRef.current = rows

  function patchRow(key: string, patch: Partial<FileRow>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  async function uploadOne(row: FileRow, overrideEmail?: string) {
    patchRow(row.key, { status: 'uploading', error: undefined })
    try {
      const form = new FormData()
      form.append('file', row.file)
      if (overrideEmail) form.append('email', overrideEmail)
      const res = await fetch(`/api/workspace/jobs/${jobId}/intake`, {
        method: 'POST',
        body: form,
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 422 && data.code === 'NO_EMAIL') {
        patchRow(row.key, { status: 'needs_email', extractedName: data.extractedName ?? null })
        return
      }
      if (res.status === 422 && data.code === 'IDENTITY_CONFLICT') {
        // The extracted email belongs to a different-looking person in the
        // pool — typing the email again is the recruiter's confirmation.
        patchRow(row.key, { status: 'needs_email', conflictNote: data.error })
        return
      }
      if (!res.ok) {
        patchRow(row.key, { status: 'error', error: data.error || `Upload failed (${res.status})` })
        return
      }
      patchRow(row.key, {
        status: 'done',
        result: {
          candidateName: data.candidate?.name ?? row.file.name,
          candidateEmail: data.candidate?.email ?? '',
          createdApplication: data.createdApplication !== false,
          score: data.resumeMatch?.score ?? null,
          seenBefore: Array.isArray(data.seenBefore) ? data.seenBefore : [],
        },
      })
    } catch {
      patchRow(row.key, { status: 'error', error: 'Network error — retry' })
    } finally {
      inFlightRef.current -= 1
      pump()
    }
  }

  /**
   * Single fixed-concurrency pump — EVERY intake request (initial upload,
   * retry, and fix-up submission) goes through here, so the cap of 3 holds
   * no matter how many rows are resubmitted at once (Codex P2 on #613).
   */
  function pump() {
    while (inFlightRef.current < CONCURRENCY && queueRef.current.length > 0) {
      const next = queueRef.current.shift()!
      inFlightRef.current += 1
      void uploadOne(next, next.pendingOverride)
    }
    if (inFlightRef.current === 0 && queueRef.current.length === 0) {
      onSettled()
    }
  }

  function enqueue(row: FileRow) {
    queueRef.current.push(row)
    pump()
  }

  function addFiles(list: FileList | null) {
    if (!list) return
    // Cap across the WHOLE active batch, not just this selection — picking a
    // second group before the first settles must not exceed MAX_BATCH paid
    // requests (Codex P2 on #613). rowsRef mirrors the current rows so the
    // capacity check does not depend on a stale render.
    const remaining = MAX_BATCH - rowsRef.current.length
    if (remaining <= 0) return
    const fresh: FileRow[] = Array.from(list)
      .slice(0, remaining)
      .map((file, i) => ({
        key: `${Date.now()}-${i}-${file.name}`,
        file,
        status: 'queued' as const,
      }))
    if (fresh.length === 0) return
    // Update the ref synchronously too, so a second selection in the same
    // tick sees the reduced remaining capacity before the re-render lands.
    rowsRef.current = [...rowsRef.current, ...fresh]
    setRows((prev) => [...prev, ...fresh])
    for (const row of fresh) enqueue(row)
  }

  function retry(row: FileRow, overrideEmail?: string) {
    // Back onto the queue with the override attached — never a direct
    // uploadOne, which would dodge the concurrency cap (Codex P2 on #613).
    patchRow(row.key, { status: 'queued', pendingOverride: overrideEmail, error: undefined })
    enqueue({ ...row, status: 'queued', pendingOverride: overrideEmail })
  }

  return (
    <div className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-4">
      <div>
        <p className="text-sm font-medium text-[#0f1419]">Bulk upload résumés</p>
        <p className="text-xs text-[#71767b] mt-0.5">
          PDF, DOCX or TXT — up to {MAX_BATCH} at a time, 10MB each. Each CV is parsed,
          matched against the JD, and added to this job&apos;s pipeline. People already in
          your workspace are merged by email, never duplicated.
        </p>
      </div>

      <label className="block border-2 border-dashed border-[#e1e8ed] rounded-2xl p-6 text-center cursor-pointer hover:border-[#2563eb]/40 transition-colors">
        <input
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <span className="text-sm text-[#536471]">
          Drop files here or <span className="text-[#2563eb] font-medium">browse</span>
        </span>
      </label>

      {rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.key}
              className="border border-[#e1e8ed] rounded-xl px-3 py-2 text-sm flex flex-col gap-1.5"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate font-medium text-[#0f1419]">{row.file.name}</span>
                <span className="ml-auto shrink-0">
                  {row.status === 'queued' && <Badge>queued</Badge>}
                  {row.status === 'uploading' && <Badge variant="caution">processing…</Badge>}
                  {row.status === 'error' && <Badge variant="danger">failed</Badge>}
                  {row.status === 'needs_email' && <Badge variant="caution">needs email</Badge>}
                  {row.status === 'done' && row.result && (
                    <span className="flex items-center gap-1.5">
                      {row.result.score != null ? (
                        <Badge variant={scoreVariant(row.result.score)} dot>
                          JD match {row.result.score}
                        </Badge>
                      ) : (
                        <Badge>unscored</Badge>
                      )}
                      {!row.result.createdApplication && <Badge>already in pipeline</Badge>}
                    </span>
                  )}
                </span>
              </div>

              {row.status === 'done' && row.result && (
                <div className="text-xs text-[#71767b]">
                  {row.result.candidateName} · {row.result.candidateEmail}
                  {row.result.seenBefore.length > 0 && (
                    <span className="ml-2">
                      Seen before:{' '}
                      {row.result.seenBefore.map((s) => `${s.jobTitle} (${s.stage})`).join(', ')}
                    </span>
                  )}
                </div>
              )}

              {row.status === 'error' && (
                <div className="flex items-center gap-2 text-xs text-[#f4212e]">
                  <span>{row.error}</span>
                  <button
                    type="button"
                    onClick={() => retry(row)}
                    className="text-[#2563eb] font-medium"
                  >
                    Retry
                  </button>
                </div>
              )}

              {row.status === 'needs_email' && (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (row.emailFix?.trim()) retry(row, row.emailFix.trim())
                  }}
                >
                  <span className="text-xs text-[#71767b] shrink-0">
                    {row.conflictNote
                      ? `${row.conflictNote} — confirm or correct:`
                      : `No email found${row.extractedName ? ` for ${row.extractedName}` : ''} — add it:`}
                  </span>
                  <input
                    type="email"
                    required
                    value={row.emailFix ?? ''}
                    onChange={(e) => patchRow(row.key, { emailFix: e.target.value })}
                    placeholder="candidate@email.com"
                    className="flex-1 min-w-0 px-2 py-1 border border-[#e1e8ed] rounded-lg bg-[#f8fafc] text-xs"
                  />
                  <Button type="submit">Add</Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
