# ADR 0038 — Private Hire workspace branding boundary

Date: 2026-08-16

Status: accepted

## Context

Hire needs one company description and optional logo per workspace. The
description is canonical workspace metadata captured during onboarding and is
reused as context for new job descriptions. A logo is a private dashboard
identity asset, not candidate media: candidate-object retention, access, and
purge policies must never be reused for it.

`modules/hire` is already at its deliberate 90-file budget. Folding object
validation, R2 storage, and lifecycle cleanup into that module would either
exceed the tripwire or blur the boundary between hiring records and branding
objects.

## Decision

Create `modules/hire-branding` with the `@hire-branding` alias and an initial
budget of **2,000 counted LOC / 8 counted files**.

- The Hire workspace model remains the canonical owner of safe metadata only:
  description and logo MIME/size/timestamp. It never stores logo bytes.
- Branding owns the deterministic private R2 object key, MIME and magic-byte
  validation, bounded upload/download, and a narrow storage port.
- Every logo read is member-authorized through the Hire control route; no R2
  URL or object key is serialized to a browser. Writes require a workspace
  admin.
- The existing workspace hard purge deletes the one deterministic branding key
  under its lifecycle lease. Replacements overwrite that key, so no orphaned
  generations accumulate.

## Consequences

- PNG, JPEG, and WebP are the only accepted logo formats; SVG and arbitrary
  candidate uploads cannot enter this boundary.
- New job requirement versions copy the workspace description into their
  existing immutable historical snapshot field. There is no job-level company
  description editor or mutable job metadata.
- Any request for public logo delivery, multi-asset branding, image
  transforms, or a CDN must be designed as a separate privacy and retention
  decision rather than extending this private identity boundary.
