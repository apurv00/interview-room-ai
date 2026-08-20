# ADR 0040 — Bounded budgets for Hire interview integrity validation

Date: 2026-08-20

Status: accepted

## Context

Hire interviews now require a live camera and microphone plus full-screen
entry before an assessment begins. New V6 attempts also require an
entire-display share and continuously record that shared display for recruiter
review. During the interview, the runtime pauses for camera, microphone,
display-share, full-screen, or assessment-window interruptions and sends
neutral, timestamped validation evidence to the recruiter timeline.

The live-interview implementation adds two focused browser units to
`modules/interview`:

- `hooks/useHireInterviewIntegrityGate.ts`, which owns the Hire-only start,
  pause, and recheck state machine; and
- `utils/hireInterviewIntegrityReporter.ts`, which owns bounded, revision-safe
  client delivery of validation events;
- `utils/hireInterviewDisplayShare.ts`, which validates the browser-selected
  display surface; and
- `hooks/useHireDisplayRecorder.ts`, which keeps one bounded video recorder
  alive while an interrupted display share is replaced during a recheck.

It also extends the existing live interview engine and Hire multimodal capture
hook, and allows the existing media-recorder hook to accept video-only display
streams. Together these changes move the module from 29,319 to 30,968 counted
LOC, exceeding its 30,000 LOC tripwire by 968 LOC.

The versioned runtime-to-control contract in
`shared/contracts/hireMultimodalObservationBridge.ts` grows by 140 LOC to carry
the new evidence while retaining V1/V2 bridge compatibility. That moves
`shared` from 25,957 to 26,115 counted LOC, 115 above its original tripwire.

ADR 0006's structural recommendation remains: extract the legacy
post-interview analysis slice from `modules/interview` when that slice creates
the next broad pressure event. Moving these Hire-only browser units merely to
avoid a counter would create an artificial module boundary and more import
surface without reducing that known architectural pressure.

## Decision

Raise only the LOC ceilings, leaving file ceilings unchanged:

| Module | Previous | New | Measured after this change | Headroom |
| --- | ---: | ---: | ---: | ---: |
| `modules/interview` | 30,000 | 31,100 | 30,968 | 132 |
| `shared` | 26,000 | 26,200 | 26,115 | 85 |

The feature remains in its real ownership boundaries:

- live browser gate, display recorder, and reporter in `modules/interview`;
- versioned cross-surface wire contract in `shared`; and
- recruiter-only persistence and presentation in `modules/hire-multimodal`.

Validation evidence remains separate from interview scoring, candidate rank,
recommendations, decisions, and exports.

## Consequences

- CI continues to use tight early-warning budgets rather than treating either
  limit as open-ended.
- A further general-purpose increase to `modules/interview` should first
  revisit the ADR 0006 analysis extraction rather than add another numeric
  bump.
- The shared contract remains the single compatible source for runtime and
  control, avoiding duplicated versions of the integrity payload.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Move the new browser files into an unbudgeted Hire runtime folder | It disguises the growth, creates a new client/module boundary, and adds import/configuration churn without improving the live-interview architecture. |
| Extract ADR 0006's analysis slice in this feature | It is a separate, high-impact refactor unrelated to the required validation flow. |
| Compress code or weaken event/retry coverage | It would make time-sensitive assessment evidence harder to audit and test only to satisfy a line counter. |
