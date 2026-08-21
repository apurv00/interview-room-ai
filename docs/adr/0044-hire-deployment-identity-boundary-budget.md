# ADR 0044 — Hire deployment identity boundary budget

Date: 2026-08-21

Status: accepted

## Context

Hire control, Hire runtime, and B2C share one application artifact but must not
share deployment identity, Mongo databases, Inngest app IDs, browser origins,
or internal-service credentials. The existing readiness helper could silently
fall back to B2C for missing or malformed surface identity, and the raw Mongo
client used by NextAuth did not share Mongoose's pre-connect Hire database
fence.

The remediation adds one shared surface-identity resolver and one shared
pre-connect database assertion, then applies them consistently to middleware,
health, Inngest, Mongoose, and the raw Mongo client. It also makes build and
runtime identity independently observable. Counted `shared` production LOC
moves from 26,115 after ADR 0040 to 26,228, 28 above the existing ceiling.

## Decision

Raise only the `shared` LOC ceiling from 26,200 to 26,300. The measured value
is 26,228, leaving 72 LOC of headroom. Keep the file ceiling unchanged at 180;
the measured file count is exactly 180.

The two small boundaries remain separate because surface resolution is used
by middleware/readiness without importing database code, while both Mongo
drivers consume the database assertion. Combining either into a route or a
driver would recreate divergent deployment authority.

## Consequences

- Missing, malformed, whitespace-normalized, or colliding Hire deployment
  identities fail before worker sync, authentication persistence, or ordinary
  database access.
- CI retains a tight shared-module tripwire with 72 LOC and zero file-count
  headroom.
- Further shared-file growth requires consolidation or another explicit
  ownership decision.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Duplicate the database check in both clients | The two implementations could drift and reopen the pre-auth write path. |
| Put database parsing in the surface resolver | Middleware and health would inherit database-driver concerns and a broader import graph. |
| Shorten comments/tests to fit the old LOC number | It would hide intentional cross-surface authority rather than document it. |
