# ADR 0025: Jobs budget for evidence-attribution provenance

Date: 2026-07-22 · Status: accepted · Relates: Jobs audit A14, ADR 0024

## Context

Jobs audit phase A14 makes practice-evidence attribution reproducible instead
of inferring it from the latest active scoring configuration. The Jobs-owned
code records the exact model and scoring-config attempt for answer, code, and
design evidence; resolves mixed-attempt attribution; exposes bounded migration
and rollout verification; and requires the deployed staging commit to report
healthy before the provenance gate can succeed.

The phase adds one counted service file and takes `modules/jobs` to 74 files
and 19,225 counted lines, exceeding the 73-file / 19,000-line tripwire. Folding
the attribution resolver into a worker or CMS adapter would mix evidence
identity with orchestration or configuration authority. Removing the resolver,
migration checks, or exact-deployment verification would leave historical
records ambiguous or permit an unverified rollout.

## Decision

Raise `modules/jobs.maxLOC` from 19,000 to 20,000 and `maxFiles` from 73 to 75.
The limits leave one file and 775 lines of maintenance headroom. Tests remain
excluded under the existing budget policy; no A14 production code is excluded.

## Consequences

- CI accepts the complete A14 provenance contract and rollout evidence.
- Evidence identity remains in the Jobs domain that owns attribution policy.
- The small headroom keeps the file and LOC tripwires meaningful.
- The next material Jobs expansion must simplify or extract a coherent
  subsystem, or justify another explicit architecture decision.
