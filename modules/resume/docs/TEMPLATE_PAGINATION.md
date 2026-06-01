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

### Single-column families (Classic, Modern, Technical, Executive, Early Career, Career Change)
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

## Line-boundary break snapping

Page breaks inside content are **snapped to a text-line boundary** so a break
never bisects a visual line. The planner (`resumePageBreaks.ts`) calls
`snapToLine(rawBreak, pageStart, lineTops)`; `lineTops` are per-line top offsets
gathered by `collectLineTops` (via `Range.getClientRects`) in
`measureResumeSections.ts`, and the same logic is mirrored in the inline PDF
script in `pdfService.ts`. This applies to every in-content break:
oversized-unit slices and block-section slices. Unit-boundary breaks are NOT
snapped — they stay at the next unit's top so an atomic entry is never split
across pages; the few-px trailing-line leak that produces is masked instead (see
below).

Two complementary mechanisms keep a continuation page from showing a half-line:

1. **Line-snap** (`snapToLine`) for in-content slices (oversized units, block
   sections incl. the columnar Sidebar body) — the break lands on a line top.
2. **Opaque continuation-header band** — the repeated header overlay is a
   full-width opaque white band, so the re-shown `[breakTop−headerHeight,
   breakTop]` slice is masked rather than bleeding through.

- **Single-column families**: strict — no VISIBLE line straddles a continuation
  page top.
- **Sidebar (columnar)**: also strict in practice. The body is one height-sliced
  block with no repeated header; the block-loop `snapToLine` lands the slice on a
  line boundary, so no visible line is cut. (The two columns' lines need not
  align because there is no header band to leak through here — the slice itself is
  the page boundary.) Regression-locked for **all three Sidebar variants**
  (`creative`, `sidebar-slate`, `sidebar-violet`) by
  `services/__tests__/paginationLineSnap.e2e.test.ts`.

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
4. **PDF render** — `npm run test:pdf` (opt-in, real Chromium) renders the exported
   PDF HTML and asserts template styling is applied + page count + that content is
   visible within a page viewport (not clipped). Runs in the `e2e-tests` workflow
   (browser-capable job), not the browser-free main `ci`. For a brand-new family,
   also eyeball a long resume on the Vercel preview (long skills after education; a
   long single experience entry; a long summary) and, for a sidebar variant, that
   the columns advance together.

## How the legacy parity baseline was made
`legacyTemplateParity.test.tsx` renders each legacy ID via `renderToStaticMarkup`
with the inlined `parityFixture`, normalizes Tailwind class-token order, and
snapshots it. The committed snapshot was generated from `origin/main` *before* the
family refactor, so it is the ground truth for "unchanged".

## Current catalog (20 templates · 7 families)

| Family | Layout | Variants |
|---|---|---|
| Classic | single-column | `professional`*, `classic-navy`, `minimalist`*, `federal`* |
| Modern | single-column (accent band) | `modern-indigo`, `modern-emerald`, `modern-rose` |
| Technical | single-column (skills-first) | `technical`*, `technical-slate`, `startup`* |
| Sidebar | two-column (`data-resume-columns`) | `creative`*, `sidebar-slate`, `sidebar-violet` |
| Executive | single-column | `executive`*, `executive-gold` |
| Early Career | single-column | `entry-level`*, `academic`*, `early-career-teal` |
| Career Change | single-column | `career-change`*, `career-change-emerald` |

`*` = legacy ID locked by the parity gate. Every ID maps to a family in
`config/templateFamilies.ts` (`TEMPLATE_VARIANTS`); the editor, `/resume/templates`,
and the wizard export step all render grouped by that family — a guard test
(`config/__tests__/wizardTemplateWindow.test.ts`) fails if any ID is unmapped.

## Adding a color variant to an existing family

Pure config when the family layout is fully theme-driven (Sidebar, Early Career,
Career Change, Classic, Modern). Executive/Technical hardcoded one or two accent
spots — those are now theme fields (`bulletColorClass`/`ruleBorderClass`,
`bulletAccentClass`/`projectUrlClass`); keep the default value unchanged so the
parity gate stays green.

1. `config/<family>Themes.tsx` — extend the `…VariantId` union, add a theme
   entry, ensure the getter looks it up by `variantId`. **Change only color
   tokens** (Tailwind *classes*, never inline `style`, so they ship in the
   precompiled PDF CSS). Keep geometry identical to siblings.
2. `components/templates/<Name>Template.tsx` — a ~6-line shim →
   `<FamilyLayout data={data} variantId="…" />`.
3. `components/templates/index.ts` — register the id in `TEMPLATE_REGISTRY`.
4. `config/templates.ts` — append picker metadata to `RESUME_TEMPLATES` (append,
   don't insert), and add the badge color to `TEMPLATE_COLOR_MAP` if it's new.
5. `config/templateFamilies.ts` — add the `TEMPLATE_VARIANTS` entry (familyId).
6. `config/sectionOrders.ts` — single-column variants: add the id to
   `TEMPLATE_BODY_ORDER` (→ the family's order). Sidebar/columnar variants are
   omitted (their layout ignores `sectionOrder`).
7. Add a case to `components/templates/__tests__/variantBatch.test.tsx`.
8. The PDF CSS auto-includes the new classes (the Tailwind scan covers
   `config/**` + `components/layouts/**` + `template-primitives/**`); run
   `npm run test:pdf` to confirm styling renders.

## Adding a new family
New layout + theme config + family entry + a fresh parity snapshot + a markers
test. The **Modern** family (`ModernLayout` + `modernThemes` produced by one
factory so the variants are geometry-identical) is the reference implementation.
