# ADR 0027: Shared budget for the payment foundation

Date: 2026-08-04 · Status: accepted · Relates: guarded Razorpay Test pilot

## Context

The payment foundation adds six counted files under `shared/`, taking the
module from 160 to 166 files while keeping it within the existing 25,000-line
limit:

- `SavedResume` and `savedResumeRepository` preserve the existing resume
  payload while providing the persistence boundary needed for resume limits.
- `planConfig` is the client-safe pricing and entitlement contract shared by
  pricing, CMS, checkout, and product surfaces.
- `pr7EntitlementRollout` and `pr8InterviewRollout` keep commercial activation
  behind compile-time-dark gates shared by those surfaces.
- `interviewAuthorityDigest` defines the cross-boundary integrity contract for
  future authoritative interview operations.

Moving these contracts into one product module would introduce reverse imports
or duplicate security and rollout rules. Merging unrelated contracts merely to
reduce file count would weaken their ownership boundaries. This decision does
not activate Live payments, interview quota enforcement, or paid-interview
consumption.

## Decision

Raise `shared` `maxFiles` from 160 to 167: six intentional counted additions
and one headroom slot. Keep `maxLOC` unchanged at 25,000. Tests under
`__tests__/` remain excluded by the existing budget script.

## Consequences

- CI accepts the intentional cross-domain payment foundation without changing
  application behavior.
- The next additional counted shared file still requires an explicit review.
- Removing this foundation must remove its shared files and lower the budget in
  the same change.
