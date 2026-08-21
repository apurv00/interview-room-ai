# ADR 0045 — Hire evidence lifecycle and playback budget

Date: 2026-08-21

Status: accepted

## Context

The integrated Hire remediation closes two evidence-boundary gaps that cannot
remain local to one server surface. Runtime landmark capture now uses an
opaque, conditionally written object protocol whose temporary nonce authority
is carried through versioned engine-to-control contracts and erased only after
acknowledged sealing. Recruiter observation playback also needs a
digest-covered recorder-start offset so a control-plane event can be mapped to
the correct camera or display recording without guessing from wall-clock time.

Those cross-surface contracts take `shared` to 26,533 counted production LOC
and 182 files, 133 LOC above the ADR 0044 ceiling. Capturing the recorder
boundary and canonical integrity-clock offset takes `modules/interview` to
31,631 counted production LOC and 130 files, 31 LOC above the ADR 0042 ceiling.
Tests are excluded from both measurements.

## Decision

Raise only these two LOC ceilings:

- `shared`: 26,400 to 26,600, leaving 67 LOC of headroom;
- `modules/interview`: 31,600 to 31,700, leaving 69 LOC of headroom.

Keep the existing file ceilings unchanged at 182 and 142 respectively. The
Hire control module remains within its existing 28,100 LOC / 92-file ceiling,
so this decision does not increase it.

The additional shared code remains limited to validation and wire authority:
it does not introduce a general storage service or a second timeline. The
interview code records the MediaRecorder start boundary and transports that
measurement through the already-established integrity clock.

## Consequences

- Runtime landmark keys expose no candidate or session coordinate, and their
  nonce authority remains explicit and erasable across both deployment
  surfaces.
- Recruiter playback seeks only when a digest-covered recorder offset exists;
  legacy or pre-recorder events remain non-seekable rather than approximate.
- The two budgets retain less than 70 LOC of headroom and no new file-count
  allowance, so further cross-surface growth requires another explicit
  boundary decision.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Recompute landmark authority from public coordinates | It would make permanent sealed keys linkable after verified deletion. |
| Infer recorder alignment from wall-clock timestamps | Browser/media start latency makes the resulting recruiter seek nondeterministic. |
| Duplicate validators on runtime and control | The two surfaces could accept different key or clock semantics and reopen the exact boundary this remediation closes. |
| Remove validation/comments to fit the old ceilings | It would hide intentional security and evidence semantics instead of documenting the measured growth. |
