# Resume Template Pagination Contract

Every resume template renders through **one** paginator (`lib/resumePageBreaks.ts`
+ `lib/measureResumeSections.ts` for the live preview, and the mirrored inline
script in `services/pdfService.ts` for PDF export). Templates/layouts do **not**
compute page breaks — they only emit the DOM markers the paginator reads. Break
this contract and content clips, duplicates across pages, or silently drops.

> **Do not edit** `resumePageBreaks.ts`, `measureResumeSections.ts`,
> `pdfService.ts`, `ResumePreview.tsx`, or `ResumeSkillsSection.tsx` to make a new
> template work. If a template needs paginator changes, it is breaking the
> contract — fix the template instead.

## DOM marker contract

### Single-column families (Classic, Technical, Executive, Early Career, Career Change)
- Each logical section is a **leaf** `data-resume-section="<id>"` — never nest a
  `data-resume-section` inside another `data-resume-section`.
- The section title carries `data-resume-section-header="<visible title>"` with the
  **dynamic** title string (not a literal), so continuation overlays repeat the
  right heading.
- Splittable lists put `data-resume-section-unit` on **each atomic entry**: every
  experience job, education row, project, certification, and skill category.
- **Never** put `data-resume-section-unit` on individual skill *items* inside a
  category — nested units corrupt measurement and the category↔truncation index
  mapping (the Career Change regression).
- Long single blocks (summary, custom sections) are **block sections** with no
  units; continuation headers resolve via section-range lookup.
- An oversized experience/project entry is split *inside the unit* by the planner —
  do not pre-truncate it.

### Sidebar family (Creative + variants)
- Exactly **one** outer wrapper carries `data-resume-section="body"` **and**
  `data-resume-columns` on the flex row. The paginator measures it as one atomic
  height-sliced block so the sidebar and main column advance together.
- Sidebar sections (contact, skills, certs) and main sections live **inside** that
  wrapper. Do **not** mark them as sibling top-level sections — that re-introduces
  the linearized-column bug.
- A sidebar family has **coarser** pagination than single-column (height-slice, no
  per-category continuation pages, no skills truncation). That is expected.

### Skills (all families)
- Always render skills through `ResumeSkillsSection` (never a hand-rolled list).
  It owns the category markers and the `+N more` truncation that keeps the live
  preview and the PDF in sync (`applySkillTruncationForPdf` + the page-context
  provider). Hand-rolling breaks truncation parity.

## Theme / variant rules
- A variant is a **config object**, not a new file. Add layout structure to the
  family layout; add look to the theme.
- **Colors as Tailwind classes**, not inline `style={{ color }}`. The PDF uses a
  precompiled Tailwind bundle (`styles/resume-pdf-css.json`); a class string in a
  theme file is picked up by the build scanner, an inline style only works by luck.
- **Color-only variants** (accent swap) are geometry-neutral — no pagination
  re-verification needed.
- **Density/spacing variants** (tighter gaps, smaller text, "compact/dense") DO
  change measured heights and therefore page breaks — they require the same
  preview+PDF page-count verification as a new layout, even though "no code
  changed".

## Verification gate (before shipping any template or variant)
1. **Legacy parity** — `vitest run modules/resume/components/templates/__tests__/legacyTemplateParity.test.tsx`.
   Existing IDs must stay byte-identical to the committed pre-refactor baseline
   (modulo cosmetic class-token order). A change here means an existing resume
   re-paginates. If a change is *intended*, regenerate the baseline from the
   previous `main` and note it in the PR.
2. **Markers** — a render test asserts the marker contract above for the family
   (see `lib/__tests__/*LayoutMarkers.test.tsx`).
3. **Full suite** — `npm run test:run -- modules/resume`.
4. **Manual PDF** — export a long resume (long skills after education; a long
   single experience entry; a long summary) and confirm the **PDF page count and
   section boundaries match the preview** — no clipping, no duplicated headers. For
   a sidebar variant, confirm the columns advance together. (No automated headless
   render exists yet; this step is manual.)

## How the legacy parity baseline was made
`legacyTemplateParity.test.tsx` renders each legacy ID via `renderToStaticMarkup`
with the inlined `parityFixture`, normalizes Tailwind class-token order, and
snapshots it. The committed snapshot was generated from `origin/main` *before* the
family refactor, so it is the ground truth for "unchanged".
