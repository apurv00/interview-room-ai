# ADR 0013 — Shared module budget bump: Azure TTS adapter

**Date:** 2026-06-24
**PR:** #463
**Status:** Accepted

## Context

`scripts/check-module-size.mjs` caps `shared/` at 134 counted `.ts/.tsx` files as
a code-sprawl tripwire. Feedback #4 (opt-in Indian-accent interviewer voice) adds
the Azure AI Speech TTS adapter `shared/services/providers/azureTTS.ts`, which
sits alongside the existing provider adapters (openai / anthropic / groq / …) in
`shared/services/providers/`. That is one new counted file, tripping the count to
135 (> 134). Its paired test `__tests__/azureTTS.test.ts` is **not** counted —
`countFiles` skips `__tests__/`.

## Decision

Bump `shared` `maxFiles` 134 → 136 (+1 for `azureTTS.ts`, +1 headroom). LOC is
unaffected and well under budget (~13.8k / 25k) — this is a count-shape change,
not bloat.

## Alternatives considered

- **Relocate the adapter into a domain module** — rejected. TTS is a cross-cutting
  shared service consumed by the `app/api/tts/*` route handlers (the same place
  the Deepgram path lives), exactly like the other provider adapters already in
  `shared/services/providers/`. Moving it would create a module cycle.
- **Inline the adapter into the route** — rejected. It is shared by both the
  streaming and buffered TTS routes and is unit-tested in isolation
  (`buildSsml` XML-escaping).

## Consequences

+1 headroom keeps the tripwire tight; the next `shared/` file addition should
reassess rather than reflexively re-bump.
