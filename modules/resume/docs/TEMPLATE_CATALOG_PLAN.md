# Resume Template Catalog Plan

## Goal

Grow from a flat list of templates to family-based variants without breaking:

- existing saved `template` IDs
- preview/PDF pagination parity
- skills truncation behavior
- Creative two-column pagination contract

## Current Baseline

- 10 legacy template IDs in production (`professional`, `technical`, `creative`, ...).
- `ResumePreview` and `pdfService` both depend on consistent DOM markers.
- `ResumeSkillsSection` is the only supported way to render truncation-safe skills.
- Two-column layouts must use `data-resume-columns` on the outer flex wrapper.

## Pagination Contract (Non-negotiable)

Each template/family layout must emit these markers correctly:

- `data-resume-section="<id>"` per logical section
- `data-resume-section-header="<Title>"` for repeatable continuation headers
- `data-resume-section-unit` for splittable items (jobs, degrees, projects, cert rows, skill categories)
- no nested skill-item units inside a category
- sidebar layouts: top-level `data-resume-columns` wrapper

## Family Direction

Planned catalog families:

1. Classic
2. Technical
3. Sidebar
4. Executive
5. Early Career
6. Career Change

Legacy IDs remain valid and map into one of the above families.

## Phases

### Phase 0 - Safety Rails

- Keep current renderer contracts unchanged.
- Document required markers and known pagination pitfalls.
- Add/maintain tests for section breaks, continuation headers, skills truncation, and columns.

### Phase 1 - Scaffolding (done)

- Add `templateFamilies.ts` with family + variant mapping for all existing IDs.
- Template picker + builder grouped by family.

### Phase 2 - Classic + Technical composers (in progress)

- `classicThemes.tsx` — professional, minimalist, federal, classic-navy.
- `template-primitives/*` — shared sections + federal-specific blocks.
- `ClassicLayout` — classic family composer (4 variants).
- `TechnicalLayout` + `technicalThemes.tsx` — technical family (skills-first).
- Legacy shims: professional, minimalist, federal, technical.
- New picker entry: `classic-navy` (config-only variant, no new layout file).
- `classicLayoutMarkers.test.tsx` — pagination DOM contract smoke tests.

### Phase 3 - Remaining family composers

- `SidebarLayout` (creative + future sidebar variants, `data-resume-columns`).
- `ExecutiveLayout`, `EarlyCareerLayout`, `CareerChangeLayout`.
- `StartupLayout` (custom section routing for side projects / interests).

### Phase 4 - Variant Expansion

- Add new variants as config + theme tokens rather than copy-paste template files.
- Validate preview/PDF parity before publishing each variant.

## Immediate Next Steps

1. Export family metadata from `modules/resume/index.ts`.
2. Add a non-breaking UI tag in template picker showing each template family.
3. Start Classic family composer extraction from `ProfessionalTemplate` + `MinimalistTemplate`.
