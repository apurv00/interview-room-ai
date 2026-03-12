# Interview Prep Guru — Redesign Plan v2

> **Version**: 2.0 — Revision after critical analysis
> **Date**: March 12, 2026
> **Supersedes**: REDESIGN-PLAN.md (v1)

---

## What Changed from v1

v1 was built on a flawed premise: that users are Indian students on budget Android devices browsing casually. That led to over-optimized mobile layouts, defensive performance budgets, and a visual language that felt utilitarian rather than premium.

**v2 corrections:**
1. **User re-profiled** — This is a niche professional tool. Users are motivated career-seekers on decent devices, often on laptops. Mobile matters but isn't the primary use context.
2. **Quality bar raised** — Benchmarked against Linear, Vercel, Raycast. The goal is a UI that feels *crafted*, not just *functional*.
3. **Domain selector completely rethought** — Grid of emoji cards creates visual noise. Replaced with a curated list pattern.
4. **Whitespace as a design element** — v1 treated spacing as "gaps between things." v2 uses whitespace to create rhythm, hierarchy, and calm.
5. **Component architecture redesigned** — Not just primitives (Button, Card) but *composed patterns* (SelectionGroup, MetricCard, StepSection) that enforce consistency at a higher level.
6. **Empty/error/loading states elevated** — These are first-class design artifacts, not afterthoughts.

---

## Table of Contents

1. [User Behavior Analysis](#1-user-behavior-analysis)
2. [Design Philosophy](#2-design-philosophy)
3. [Visual Language](#3-visual-language)
4. [Design Token System](#4-design-token-system)
5. [Component Architecture](#5-component-architecture)
6. [Page Redesigns](#6-page-redesigns)
7. [State Design (Empty, Loading, Error, Offline)](#7-state-design)
8. [Motion & Interaction](#8-motion--interaction)
9. [Responsive Strategy](#9-responsive-strategy)
10. [Accessibility](#10-accessibility)
11. [Migration Plan](#11-migration-plan)
12. [Design Context for Future Development](#12-design-context-for-future-development)

---

## 1. User Behavior Analysis

### Who Actually Uses This Product

This is NOT a mass consumer app. It is a **niche professional tool** used by people preparing for specific, high-stakes interviews.

**Primary persona: The Intentional Preparer**
- Age: 22–35
- Context: Preparing for a specific upcoming interview (campus placement, job switch, promotion)
- Device: Laptop/desktop (primary session), phone (checking history/feedback on the go)
- Session: Deliberate — blocks 20–45 min, sits down, opens laptop, runs a full mock interview
- Mindset: Anxious but motivated. Wants to feel like the tool takes them seriously.
- Technical sophistication: Comfortable with web apps. Likely uses Notion, LinkedIn, ChatGPT.

**Secondary persona: The Repeat Practitioner**
- Returns 3–5 times before an interview
- Cares about score trends, improvement areas
- Quick setup on return visits (remembers preferences)
- Checks feedback on phone between sessions

**What this means for design:**
- **Laptop-first, phone-aware** (not mobile-first)
- **Premium feel matters** — this person also uses Linear, Notion, Figma. A cheap-looking UI signals a cheap tool.
- **Reduce decision fatigue** — they're already anxious. Don't make them think about the UI.
- **Speed to interview** — returning users should be able to start in <30 seconds.
- **Network resilience still matters** — Indian ISPs have variable quality. Skeleton states and graceful degradation are non-negotiable.

### User Journey Heatmap

```
FIRST VISIT:    Landing → Signup → Setup Wizard → Lobby → Interview → Feedback
                ^^^^^^^^                                    ^^^^^^^^^^^^^^^^^
                HIGH DROP-OFF                               PEAK ENGAGEMENT

RETURN VISIT:   Home → Setup (fast) → Lobby → Interview → Feedback → History
                       ^^^^^^^^^^^^                        ^^^^^^^^^^^^^^^^
                       MINIMIZE TIME                       MAXIMIZE VALUE

PASSIVE CHECK:  History → Feedback detail (mobile)
                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                READ-ONLY, QUICK GLANCE
```

---

## 2. Design Philosophy

### Vision (Revised)

Interview Prep Guru should feel like **a private session with a world-class career coach** — the environment is calm and focused, the feedback is precise and actionable, and the technology disappears entirely during the actual practice.

### Principles (Revised)

| # | Principle | Meaning | Anti-pattern |
|---|-----------|---------|--------------|
| 1 | **Calm confidence** | The UI should lower anxiety, not add to it. Every screen should feel under control. | Aggressive animations, too many options visible at once, dense data without context. |
| 2 | **Earned complexity** | Simple surfaces that reveal depth on interaction. The first view of anything should be scannable in 2 seconds. | Showing all 5 score dimensions at once without hierarchy. Showing 12 domains in a grid without curation. |
| 3 | **Intentional whitespace** | Space is not "empty" — it's a design element that creates rhythm and focus. Every margin exists for a reason. | Uniform spacing everywhere. No visual breathing between sections. Cards jammed together. |
| 4 | **Systematic consistency** | If two things look the same, they behave the same. If they behave differently, they look different. | Buttons with 5 different padding values. Cards with inconsistent border treatments. |
| 5 | **Resilient by default** | Every component has a designed loading, empty, error, and offline state. These are not edge cases — they are the first thing many users see. | Blank screens during loading. Generic "Something went wrong" errors. |

### Design Quality Benchmarks

The visual quality bar for this product is set by:
- **Linear** — Information density without visual noise. Monochrome restraint.
- **Vercel Dashboard** — Clean type hierarchy. Bold whitespace. Functional elegance.
- **Raycast** — Selection patterns. Keyboard-first but visually rich.
- **Notion** — Calm workspace energy. Light motion. Structured but not rigid.

---

## 3. Visual Language

### 3.1 Color Philosophy

The current palette (dark navy + indigo accent) is solid. What's broken is **how colors are applied**, not which colors are used.

**Problem 1: Too many opacity variants scattered across files**
`bg-indigo-500/10`, `bg-indigo-500/15`, `bg-indigo-500/20`, `bg-indigo-600/20`, `bg-indigo-600/30`... these are all "light indigo surface" but use different values in different files.

**Problem 2: Semantic meaning is inconsistent**
Indigo is used for: primary actions, selected states, AI/processing indicators, info badges, score colors, links, and decorative gradients. It's overloaded.

**Fix: Define 4 layers of background, 3 accent roles**

```
BACKGROUND LAYERS (4 levels of elevation):
  Layer 0 — Page:     #070b14  (current)
  Layer 1 — Card:     #0c1220  (NEW: slightly lighter than page, currently using #0f172a which is too bright)
  Layer 2 — Surface:  #151d2e  (NEW: inputs, interactive areas)
  Layer 3 — Raised:   #1c2539  (NEW: hover states, dropdowns)

ACCENT ROLES (strict assignments):
  Primary (Indigo):   Actions, selection, links, focus rings.
                      NEVER for informational/passive elements.
  Success (Emerald):  Positive scores, completed states, "pass" indicators.
  Caution (Amber):    Medium scores, warnings, "in progress" states.
  Danger (Red):       Low scores, errors, destructive actions.
  Neutral (Slate):    Everything else. Borders, labels, metadata.

COLOR RULE: Each accent has exactly 3 usages:
  text:    The -400 shade (e.g., indigo-400 for text)
  surface: The color at 8% opacity (e.g., rgba(99,102,241,0.08))
  border:  The color at 15% opacity (e.g., rgba(99,102,241,0.15))
  NO OTHER COMBINATIONS. This eliminates the 10/15/20/25/30 opacity sprawl.
```

### 3.2 Typography Refinement

The system font stack is correct (no custom fonts = zero load time). But the **type scale usage** needs tightening.

**Problem**: The codebase uses `text-[10px]`, `text-[11px]`, `text-xs`, `text-sm` inconsistently for similar roles. Metadata appears in 4 different sizes.

**Fix: Define 6 text roles, not sizes**

```
ROLE           SIZE    WEIGHT    COLOR         TRACKING    USAGE
─────────────────────────────────────────────────────────────────────
display        36/40px bold      text-primary  -0.02em     Page titles (H1)
heading        24px    semibold  text-primary  -0.01em     Section titles (H2)
subheading     16px    semibold  text-primary  normal      Card titles, step labels
body           14px    normal    text-secondary normal     Primary content, descriptions
caption        12px    medium    text-tertiary  normal     Metadata, timestamps, hints
micro          11px    medium    text-muted     0.02em     Badges, very small labels

RULE: Never use text-[10px]. If something needs to be 10px, it shouldn't exist.
RULE: Uppercase tracking-widest is ONLY for section step labels. Nowhere else.
RULE: font-mono is ONLY for timers, scores, and code. Not for badges or metadata.
```

### 3.3 Whitespace System

v1 defined spacing as a flat scale (4px, 8px, 12px...). That's like having a ruler — useful but it doesn't tell you *when* to use what.

**v2: Whitespace has roles, not just sizes.**

```
ROLE               VALUE    TAILWIND    WHEN TO USE
──────────────────────────────────────────────────────────
inline-gap         6px      gap-1.5     Icon-to-text, badge-internal
element-gap        12px     gap-3       Between related items in a row
component-gap      16px     gap-4       Between components inside a card
section-gap        32px     gap-8       Between cards/sections on a page
region-gap         56px     gap-14      Between major page regions (hero → content)
page-margin-x      24px     px-6        Horizontal page padding (all breakpoints ≥ sm)
page-margin-x-sm   16px     px-4        Horizontal page padding (mobile)
card-padding       20px     p-5         Inside card components
card-padding-lg    28px     p-7         Hero cards, feature cards

RULE: section-gap (32px) is the DEFAULT vertical rhythm. If sections feel
      cramped, increase to region-gap (56px). Never use arbitrary mt-20 (80px).

RULE: card-padding is ALWAYS p-5 for standard cards, p-7 for hero/feature.
      Never p-4, p-6, p-8. One size per card tier.

RULE: Horizontal page padding is ALWAYS px-6 on desktop, px-4 on mobile.
      Never px-3, px-5, px-8.
```

### 3.4 Border & Shadow Philosophy

**Current problem**: Borders are the primary visual separator everywhere. `border border-slate-700`, `border border-slate-800`, `border border-slate-700/50`... borders upon borders. This creates a "grid of boxes" feeling.

**v2 approach: Use *elevation* and *spacing* as primary separators. Borders are secondary.**

```
SEPARATION HIERARCHY (use the first one that works):
  1. Whitespace alone      — sections on a page, hero above content
  2. Background change     — card (Layer 1) on page (Layer 0)
  3. Subtle border         — inputs, interactive cards that need boundary definition
  4. Strong border         — selected states, active focus rings

SHADOW (used sparingly, only for elevated elements):
  none          — default (most elements)
  sm            — dropdown menus, tooltips
  md            — modals, bottom sheets
  glow-primary  — primary CTA hover (the ONE glowing element on the page)

BORDER RADIUS:
  sm   (6px)   — badges, small buttons, inputs
  md   (10px)  — cards, dropdowns, medium containers
  lg   (14px)  — hero cards, video tiles, large containers
  full         — pills, avatars, dots

RULE: NEVER use rounded-2xl (16px) AND a border simultaneously.
      Large radius + border = feels like a cartoon bubble.
      Large radius → no border, use background change only.
      Smaller radius → border is fine.
```

---

## 4. Design Token System

### 4.1 `lib/design-tokens.ts` (v2)

```typescript
export const tokens = {
  color: {
    bg: {
      page:     '#070b14',
      card:     '#0c1220',     // CHANGED: subtler than slate-900
      surface:  '#151d2e',     // CHANGED: inputs, hover areas
      raised:   '#1c2539',     // CHANGED: active/hover lift
      overlay:  'rgba(0,0,0,0.65)',
    },
    border: {
      subtle:   'rgba(255,255,255,0.06)',   // CHANGED: barely visible, structural
      default:  'rgba(255,255,255,0.10)',   // CHANGED: input borders, card borders
      strong:   'rgba(255,255,255,0.15)',   // CHANGED: hover, active
      focus:    '#6366f1',
    },
    text: {
      primary:   '#f0f2f5',    // CHANGED: not pure white, slightly warm
      secondary: '#b0b8c4',    // CHANGED: more distinct from primary
      tertiary:  '#6b7280',    // CHANGED: gray-500, less blue than slate
      muted:     '#4b5563',    // CHANGED: gray-600
      disabled:  '#374151',    // CHANGED: gray-700
    },
    // Accents: 3 values each. text / surface / border. No exceptions.
    primary: {
      text:    '#818cf8',      // indigo-400
      surface: 'rgba(99,102,241,0.08)',
      border:  'rgba(99,102,241,0.15)',
      solid:   '#6366f1',      // For solid fills (buttons)
      hover:   '#5558e6',      // Slightly darker hover
    },
    success: {
      text:    '#34d399',
      surface: 'rgba(16,185,129,0.08)',
      border:  'rgba(16,185,129,0.15)',
    },
    caution: {
      text:    '#fbbf24',
      surface: 'rgba(245,158,11,0.08)',
      border:  'rgba(245,158,11,0.15)',
    },
    danger: {
      text:    '#f87171',
      surface: 'rgba(239,68,68,0.08)',
      border:  'rgba(239,68,68,0.15)',
    },
  },

  text: {
    display:    { size: '2.25rem', weight: '700', tracking: '-0.02em', height: '1.2' },
    heading:    { size: '1.5rem',  weight: '600', tracking: '-0.01em', height: '1.3' },
    subheading: { size: '1rem',    weight: '600', tracking: '0',       height: '1.4' },
    body:       { size: '0.875rem',weight: '400', tracking: '0',       height: '1.6' },
    caption:    { size: '0.75rem', weight: '500', tracking: '0',       height: '1.5' },
    micro:      { size: '0.6875rem',weight:'500', tracking: '0.02em',  height: '1.4' },
  },

  space: {
    'inline':    '6px',
    'element':   '12px',
    'component': '16px',
    'section':   '32px',
    'region':    '56px',
  },

  radius: {
    sm:   '6px',
    md:   '10px',
    lg:   '14px',
    full: '9999px',
  },

  shadow: {
    sm:  '0 2px 8px rgba(0,0,0,0.3)',
    md:  '0 8px 24px rgba(0,0,0,0.4)',
    glow:'0 0 20px rgba(99,102,241,0.3)',
  },

  motion: {
    fast:    '120ms',
    normal:  '250ms',
    slow:    '400ms',
    easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)',  // Smooth deceleration
    spring:  'cubic-bezier(0.34, 1.56, 0.64, 1)',
  },

  layout: {
    maxWidth: {
      narrow:  '640px',    // Auth forms, single-column
      content: '800px',    // Setup wizard, feedback
      page:    '1000px',   // History, pricing
      wide:    '1200px',   // Dashboard, multi-column
    },
    headerHeight: '52px',
  },
} as const;
```

### 4.2 Tailwind Config Updates

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        page:    '#070b14',
        card:    '#0c1220',
        surface: '#151d2e',
        raised:  '#1c2539',
      },
      spacing: {
        'inline':    '6px',
        'element':   '12px',
        'component': '16px',
        'section':   '32px',
        'region':    '56px',
      },
      borderRadius: {
        DEFAULT: '10px',   // md is now the default
      },
      borderColor: {
        DEFAULT: 'rgba(255,255,255,0.10)',
      },
    },
  },
};
```

### 4.3 Global CSS v2

```css
:root {
  --color-page: #070b14;
  --color-card: #0c1220;
  --color-surface: #151d2e;
  --color-raised: #1c2539;
  --color-border: rgba(255,255,255,0.10);
  --color-border-subtle: rgba(255,255,255,0.06);
  --radius-md: 10px;
}

/* ─── TEXT ROLES ─────────────────────────── */
.text-display    { font-size: 2.25rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.2; }
.text-heading    { font-size: 1.5rem;  font-weight: 600; letter-spacing: -0.01em; line-height: 1.3; }
.text-subheading { font-size: 1rem;    font-weight: 600; line-height: 1.4; }
.text-body       { font-size: 0.875rem;font-weight: 400; line-height: 1.6; }
.text-caption    { font-size: 0.75rem; font-weight: 500; line-height: 1.5; }
.text-micro      { font-size: 0.6875rem;font-weight:500; letter-spacing: 0.02em; line-height: 1.4; }

/* ─── STEP LABEL (the ONLY uppercase usage) ─ */
.step-label {
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}

/* ─── CARD SURFACES ─────────────────────── */
.surface-card {
  background: var(--color-card);
  border-radius: var(--radius-md);
}
.surface-card-bordered {
  background: var(--color-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

/* ─── SCROLLBAR ─────────────────────────── */
* { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.08) transparent; }
::-webkit-scrollbar { width: 4px; height: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 9999px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }

/* ─── FOCUS ─────────────────────────────── */
:focus-visible {
  outline: 2px solid #6366f1;
  outline-offset: 2px;
}

/* ─── REDUCED MOTION ────────────────────── */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 5. Component Architecture

v1 defined low-level primitives (Button, Card, Badge). That's necessary but insufficient — it doesn't prevent the real consistency problems which happen at the *composition* level.

v2 defines **3 tiers**: Primitives → Patterns → Templates.

### Tier 1: Primitives (atomic, context-free)

#### `Button`
```
Props: variant, size, leftIcon, rightIcon, isLoading, isFullWidth

VARIANTS (4):
  primary   → bg: primary.solid, text: white. Hover: primary.hover.
  secondary → bg: surface, border: default, text: secondary. Hover: bg raised.
  ghost     → bg: transparent, text: tertiary. Hover: bg surface.
  danger    → bg: danger surface (for non-destructive), text: danger.text.
              For destructive buttons: bg solid red-600, text white.

SIZES (3 — NOT 4, the xl from v1 was unnecessary):
  sm → h-8   text-caption  px-3   radius-sm
  md → h-9   text-body     px-4   radius-md    [DEFAULT]
  lg → h-11  text-body     px-5   radius-md

THE CTA BUTTON is just Button lg + a glow class. Not a separate size.

LOADING: Replace leftIcon with spinner. Text remains. Never show "Loading...".
```

#### `Input`
```
Standard: h-9, bg surface, border default, radius-sm, text body, placeholder muted.
Focus: border primary.solid, ring 1px primary.border.
Error: border danger.border, ring 1px danger.border. Error message below.
With icon: icon left (padding-left 36px), or icon right.

COMPOSITION:
  <label class="text-caption text-secondary mb-1.5">{label}</label>
  <input class="..." />
  {error && <p class="text-caption text-danger mt-1">{error}</p>}
  {hint && <p class="text-caption text-muted mt-1">{hint}</p>}
```

#### `Badge`
```
One size: h-5, px-2, text-micro, radius-sm, font-medium.
Variants: Each uses accent.text + accent.surface + accent.border.
  default, primary, success, caution, danger.
Optional: dot (pulsing circle before text).
```

#### `Skeleton`
```
Props: variant ('line' | 'circle' | 'rect'), width, height, count
Styling: bg raised, rounded-md, animate-pulse (opacity 0.4 → 0.1 → 0.4).
Duration: 1.5s (slow pulse, NOT fast).
```

#### `Divider`
```
Horizontal: h-px bg border-subtle, my component-gap.
With label: flex items-center, line — text — line.
```

### Tier 2: Patterns (composed, context-aware, reusable)

#### `SelectionGroup` — REPLACES DomainSelector grid, DepthSelector, Experience/Duration buttons

This is the core new component. One pattern for ALL "pick one from N options" interactions.

```typescript
interface SelectionGroupProps<T> {
  items: T[];
  value: string | null;
  onChange: (value: string) => void;
  renderItem: (item: T, selected: boolean) => ReactNode;
  layout: 'list' | 'grid-2' | 'grid-3' | 'inline';
  label?: string;             // Step label
  step?: number;              // Step number
  searchable?: boolean;       // Adds search input
  filterable?: boolean;       // Adds category filter
  maxVisible?: number;        // Show N items, "Show all" for rest
  emptyMessage?: string;
}
```

**Layout modes:**

```
'list'    — Full-width rows. Best for 3–6 items with descriptions.
            USED FOR: Interview depth types. Each row shows icon + name + description.
            Height: auto. No scroll.

            ┌──────────────────────────────────────┐
            │  🎯  HR Screening                    │
            │      Surface-level culture fit...     │
            ├──────────────────────────────────────┤
            │  💡  Behavioral                       │
            │      Deep STAR-format questions...    │
            ├──────────────────────────────────────┤
            │  🔧  Technical                        │
            │      Domain-specific knowledge...     │
            └──────────────────────────────────────┘

'grid-2'  — 2-column grid. Best for 4–8 items with icons.
            USED FOR: Experience level, duration (if 4+ options).
            Gap: element (12px).

'grid-3'  — 3-column grid. Best for 6+ items with icons.
            USED FOR: Domains (with search + filter).
            Gap: element (12px).
            If > maxVisible: shows N items + "Show all {total}" link.

'inline'  — Horizontal row, no wrap. Best for 2–4 simple options.
            USED FOR: Experience (3 options), Duration (3 options).
            Gap: element (12px).
            Each item: equal width, centered text.
```

**Item states:**

```
UNSELECTED:
  bg: card
  border: subtle (rgba 0.06)
  text: secondary
  Hover: bg surface, border default

SELECTED:
  bg: primary.surface
  border: primary.border
  text: primary.text
  Left accent: 3px solid primary.solid (for list layout)
  Ring: none (the border change + bg change is enough)

DISABLED:
  opacity: 0.4
  cursor: not-allowed
  No hover change
```

**Why this replaces the emoji grid:**

The current DomainSelector shows 12+ items in a grid where each card has an emoji, bold label, and 2-line description. The visual noise is high because:
- Emojis are colorful and compete for attention
- Every card has the same visual weight
- The grid pattern creates a "wall of options"

With `SelectionGroup layout='grid-3'` + `maxVisible={9}` + `searchable` + `filterable`:
- First view shows 9 domains (3×3), which is scannable
- "Show all 14 domains →" link reveals the rest
- Search filters instantly (for users who know what they want)
- Category tabs reduce visible set to 4–6 per category
- The *item renderer* can be simplified: just icon + label (move description to a tooltip or a detail panel on selection)

**Simplified domain item (inside SelectionGroup):**
```
  ┌─────────┐  ┌─────────┐  ┌─────────┐
  │  🛠️     │  │  📊     │  │  💼     │
  │  SWE    │  │  Data Sci│  │  PM     │
  └─────────┘  └─────────┘  └─────────┘
  ┌─────────┐  ┌─────────┐  ┌─────────┐
  │  📈     │  │  🎨     │  │  💰     │
  └─────────┘  └─────────┘  └─────────┘

  Smaller cards. Emoji + short label only.
  Description appears BELOW the grid when an item is selected:

  ┌──────────────────────────────────────┐
  │ 🛠️ Software Engineering              │
  │ Full-stack, backend, frontend, ML    │
  │ engineering interviews with coding   │
  │ and system design components.        │
  └──────────────────────────────────────┘
```

This "select → reveal detail" pattern reduces initial visual noise by ~60%.

#### `MetricCard` — REPLACES scattered score display patterns

```typescript
interface MetricCardProps {
  title: string;
  score: number;            // 0–100
  color: 'primary' | 'success' | 'caution' | 'danger' | 'auto';
  metrics: Array<{
    label: string;
    value: number;
    detail?: string;         // "120 wpm"
  }>;
  insights?: {
    strengths?: string[];
    improvements?: string[];
  };
  expandable?: boolean;      // Collapse metrics behind a toggle
}
```

**Layout:**
```
┌──────────────────────────────────────┐
│ Answer Quality                  82   │  ← title (subheading) + score (heading, color-coded)
│                                      │
│ Relevance              ████████░ 85  │  ← ScoreBar
│ Structure (STAR)       ███████░░ 78  │
│ Specificity            ████████░ 80  │
│ Ownership              ██████░░░ 68  │
│                                      │
│ ✓ Strong STAR structure              │  ← Strengths (success.text, caption)
│ △ Add more specific metrics          │  ← Improvements (caution.text, caption)
└──────────────────────────────────────┘

Default: all metrics visible.
On mobile with expandable=true: only title + score visible.
  Tap to expand metrics and insights.
```

**Why this matters:** Currently, the feedback page builds this layout inline with ~40 lines of JSX per card. With MetricCard, it's 1 component call. Consistency is enforced. If we change the score bar height globally, it changes everywhere.

#### `StepSection` — REPLACES inconsistent step containers on homepage

```typescript
interface StepSectionProps {
  step: number;
  label: string;
  children: ReactNode;
  visible?: boolean;         // For progressive disclosure
  completed?: boolean;       // Shows checkmark instead of number
}
```

**Layout:**
```
<section class="space-y-3">
  <div class="step-label">
    <span class="text-muted">{step}</span>
    <span class="mx-1.5 text-muted/50">·</span>
    <span>{label}</span>
  </div>
  {children}
</section>
```

**Spacing:** Consecutive StepSections are separated by `section-gap` (32px). This is enforced by the parent layout, not by each StepSection.

#### `StateView` — REPLACES scattered loading/empty/error states

```typescript
interface StateViewProps {
  state: 'loading' | 'empty' | 'error' | 'offline';
  // Loading
  skeletonLayout?: 'list' | 'grid' | 'card';
  skeletonCount?: number;
  // Empty
  icon?: ReactNode;
  title?: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  // Error
  error?: string;
  onRetry?: () => void;
}
```

**Designs per state:**

```
LOADING:
  No text. Just skeleton shapes matching the expected content layout.
  For list: 4 skeleton rows (h-12, gap-3)
  For grid-3: 6 skeleton cards (aspect-square, gap-3)
  For card: 1 large skeleton (h-48)
  Animation: slow pulse (1.5s), opacity 0.06 → 0.12

EMPTY:
  Centered. Max-width 320px.
  Icon: 40×40 rounded-lg, bg surface, text muted. Subtle, not playful.
  Title: subheading, text-primary. Short (5 words max).
  Description: body, text-tertiary. 1–2 sentences.
  Action: Button secondary md.
  Total height: ~200px. Feels intentional, not broken.

ERROR:
  Same layout as Empty, but:
  Icon: ⚠ in danger.surface circle
  Title: "Something went wrong"
  Description: {error message} in body, text-tertiary.
  Action: "Try again" Button secondary md with onRetry.
  Secondary: "If this keeps happening, contact support" in caption, text-muted.

OFFLINE (NEW):
  Icon: cloud-off icon
  Title: "You're offline"
  Description: "Check your connection and try again."
  Action: "Retry" button.
  IMPORTANT: This is NOT a full-page takeover. It appears inside the component
  that failed to load. The rest of the page remains interactive.
```

#### `Accordion` — REPLACES `<details>` on pricing FAQ

```
Controlled component. Smooth height animation (not browser default).
Items: array of { title, content }.
Single-open or multi-open mode.

LAYOUT:
  Each item: surface-card-bordered, radius-md.
  Header: px-5 py-4, flex justify-between, cursor-pointer.
  Title: subheading, text-primary.
  Chevron: 16px, text-muted, rotates 180° on open.
  Content: px-5 pb-5, body, text-secondary.
  Animation: max-height transition, 250ms easeOut.
  Gap between items: element (12px).
```

### Tier 3: Templates (page-level compositions)

#### `WizardLayout` — for homepage setup
```
Container: max-w-content (800px), mx-auto, px-6.
Children are StepSections, separated by section-gap (32px).
Bottom CTA: sticky on mobile when all steps complete.
```

#### `DetailLayout` — for feedback, history detail
```
Container: max-w-content (800px), mx-auto, px-6.
Sticky header with back button.
Tabs below header.
Content area with section-gap between groups.
```

#### `CenteredLayout` — for auth pages, pricing
```
Container: max-w-narrow (640px), mx-auto, px-6.
Vertically centered with min-h-screen.
```

---

## 6. Page Redesigns

### 6.1 Homepage (Authenticated — Setup Wizard)

**v1 problem restated:** The page dumps all 5 steps at once with uniform spacing. Steps 1–2 (domain, type) take visual attention equally to steps 3–4 (experience, duration), but domain selection is the hardest choice and deserves the most space.

**v2 approach: Progressive reveal with weighted attention.**

```
LAYOUT: WizardLayout (max-w-content, px-6)

HEADER:
  "Welcome back, {firstName}" — body, text-tertiary
  "Set up your interview" — display, text-primary
  mb: region (56px)

STEP 1 — DOMAIN (gets the most space):
  <StepSection step={1} label="Interview domain">
    <SelectionGroup
      layout="grid-3"
      searchable
      filterable
      maxVisible={9}
      renderItem={(domain, selected) => (
        <div class="flex flex-col items-center gap-1.5 py-3">
          <span class="text-xl">{domain.icon}</span>
          <span class="text-caption font-semibold">{domain.label}</span>
        </div>
      )}
    />
    {/* Selected domain detail appears here */}
    {selectedDomain && (
      <div class="surface-card p-4 mt-3">
        <p class="text-body text-secondary">{selectedDomain.description}</p>
      </div>
    )}
  </StepSection>

  gap: section (32px)

STEP 2 — INTERVIEW TYPE (list, not grid or scroll):
  <StepSection step={2} label="Interview type">
    <SelectionGroup
      layout="list"
      renderItem={(type, selected) => (
        <div class="flex items-center gap-3 py-3 px-4">
          <span class="text-lg">{type.icon}</span>
          <div>
            <p class="text-subheading">{type.label}</p>
            <p class="text-caption text-tertiary">{type.description}</p>
          </div>
        </div>
      )}
    />
  </StepSection>

  gap: section (32px)

STEP 3 + 4 — EXPERIENCE & DURATION (side by side on desktop):
  <div class="grid md:grid-cols-2 gap-section">
    <StepSection step={3} label="Experience level">
      <SelectionGroup layout="inline" ... />
    </StepSection>
    <StepSection step={4} label="Duration">
      <SelectionGroup layout="inline" ... />
    </StepSection>
  </div>

  gap: section (32px)

STEP 5 — DOCUMENTS (subtle, collapsible):
  <StepSection step={5} label="Documents (optional)">
    <div class="grid sm:grid-cols-2 gap-element">
      <FileDropzone label="Job Description" />
      <FileDropzone label="Resume" />
    </div>
  </StepSection>

  gap: region (56px)

CTA:
  <div class="flex flex-col items-center gap-3">
    <Button variant="primary" size="lg" isFullWidth class="max-w-sm" glow>
      Enter Interview Room →
    </Button>
    <p class="text-caption text-muted">
      {usageRemaining} of {usageLimit} free interviews remaining
    </p>
  </div>
```

**Key differences from v1:**
- Domain shows icon + label only (description on select)
- Type is a LIST not a horizontal scroll or grid
- Experience + Duration share a row on desktop (they're simple choices)
- Documents section is visually quieter (optional feel)
- CTA has usage counter (conversion + retention signal)

### 6.2 Homepage (Unauthenticated — Marketing)

```
STRUCTURE:

HERO (region-gap below):
  max-w-page, mx-auto, text-center
  Badge: "AI-Powered Interview Practice"
  H1: display — "Practice interviews that feel real."
  H1 line 2: "Get feedback that makes you better."
  Subtitle: body, text-tertiary, max-w-lg mx-auto
  CTAs: Button primary lg + Button ghost md

  VISUAL NOTE: No gradient blobs. No decorative elements.
  The hero is powerful because of typography + whitespace alone.
  The current blurred indigo/violet blobs add visual noise without meaning.

HOW IT WORKS (section-gap below):
  3-step horizontal layout (md:grid-cols-3, gap-component)
  Each step: surface-card, p-7
    Number: 20×20 rounded-full, bg primary.surface, text primary.text, text-micro
    Title: subheading, mt-3
    Description: body, text-tertiary

DOMAIN SHOWCASE (section-gap below):
  Heading: heading, text-center
  Subheading: body, text-tertiary, text-center
  Grid of 6 popular domains (grid-3, just icon + label, no description)
  "See all 14 domains →" link below

SOCIAL PROOF (section-gap below):
  3-column stat row:
    Each: text-center
      Number: display, text-primary, font-bold
      Label: caption, text-tertiary
    Example: "5,000+" / "mock interviews" | "12+" / "career domains" | "23%" / "avg. score improvement"

  NOTE: Don't fabricate numbers. If real data isn't available,
  use qualitative proof: "Used by candidates preparing for Google, McKinsey, Goldman Sachs..."

PRICING PREVIEW (section-gap below):
  Simplified 3-card row (link to full /pricing for details)

FINAL CTA (region-gap above, centered):
  "Ready to practice?"
  Button primary lg

FOOTER
```

### 6.3 Interview Page

```
DESKTOP (≥ 1024px):

  ┌─ HEADER (h-[52px], bg card, border-b border-subtle) ──┐
  │  [● Live]   [REC 03:24]      12:45      [⬤ Listening]  │
  └────────────────────────────────────────────────────────┘
  │                                                        │
  │  ┌──── AI Avatar ────┐  ┌──── User Camera ────┐      │
  │  │                    │  │                      │      │
  │  │     (flex-1)       │  │     (flex-1)         │      │
  │  │                    │  │                      │      │
  │  └────────────────────┘  └──────────────────────┘      │
  │  gap: element (12px), p: component (16px)              │
  │                                                        │
  ├─ TRANSCRIPT (surface-card, p-5) ───────────────────────┤
  │  Q2 of 5  ● ● ○ ○ ○                                   │
  │  "Tell me about a time you led a cross-functional..."  │
  │  ─────────                                             │
  │  Your answer:                                          │
  │  "In my previous role at..."  █                        │
  ├────────────────────────────────────────────────────────┤
  │  [Coaching tip if active]                              │
  ├─ CONTROLS (h-[60px], bg card, border-t) ───────────────┤
  │          [🔇 Mute  M]    [📞 End Interview  Esc]      │
  └────────────────────────────────────────────────────────┘

TABLET (768–1023px):
  Same as desktop but video tiles are shorter (aspect-[16/10] instead of flex-1)

MOBILE (< 768px):
  ACTIVE SPEAKER fills the screen.
  PiP of other participant: 80×60px, top-right, rounded-lg, border subtle.
  Transcript: collapsed to 1 line ("Q2: Tell me about...").
    Tap to expand as a bottom sheet (half-screen height).
  Controls: fixed bottom bar, icon-only buttons (no labels).
    Mute: 44×44 rounded-full, bg surface.
    End: 44×44 rounded-full, bg danger solid.

CRITICAL CHANGE: Remove decorative elements from interview page.
  - No gradient blobs
  - No animated rings around avatar
  - The interview room should feel like a calm, focused space.
  - The ONLY animations: lip sync, listening indicator, typing cursor.
```

### 6.4 Feedback Page

```
STRUCTURE:

HEADER (sticky, bg card, border-b, h-[52px]):
  ← Back    "Interview Feedback"    [Reattempt]

HERO SCORE (centered, region-gap below):
  <ScoreRing score={78} size="lg" />
  "Strong Performance" — heading, mt-4
  "You demonstrated solid structure..." — body, text-tertiary, max-w-md mx-auto
  Badges: [85% pass probability] [High confidence]
  Score trend sparkline (small, below badges)

TABS (sticky below header):
  Overview | Questions | Transcript

OVERVIEW TAB:
  <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-component">
                    ^^^^^^^^^^^^
    NOTE: 2-column at tablet, 3-column at desktop.
    This gives each card ~380px on laptop, ~300px on tablet.
    1-column on mobile (full width, expandable).

    <MetricCard
      title="Answer Quality" score={82} color="primary"
      metrics={[...]} insights={...}
      expandable={isMobile}
    />
    <MetricCard title="Communication" ... />
    <MetricCard title="Engagement" ... />
  </div>

  JD Alignment (if present): full-width MetricCard below grid.
  Red Flags: full-width card below, bg danger.surface, border danger.border.
  Top 3 Improvements: full-width card, numbered list.

QUESTIONS TAB: (unchanged, already well-designed as expandable cards)

TRANSCRIPT TAB: (unchanged)

BOTTOM CTA (section-gap above):
  [Reattempt Interview] primary  [Download Transcript] secondary
```

### 6.5 Pricing Page

```
LAYOUT: CenteredLayout → max-w-page for cards section

HEADER:
  "Simple pricing" — display, text-center
  "Start free. Upgrade when you're ready." — body, text-tertiary

CARDS: grid md:grid-cols-3 gap-component
  Each: surface-card-bordered, p-7
  Featured card: border primary.border (not scale transform, not shadow)
    "Popular" badge: inline above price, badge primary variant.

  Price: display size
  Limit: caption, text-tertiary
  Features: list with check icons, body size, gap-element between items.
    Features are the SAME height across all cards (use min-h to equalize).

  CTA area:
    Free: Button secondary md fullWidth → /signup
    Pro: Email capture inline (Input + Button primary sm)
         "Get notified when Pro launches" — caption, text-muted
    Enterprise: Button secondary md fullWidth → mailto

FAQ: Accordion component, max-w-content (800px), mx-auto, mt-region.
```

### 6.6 Auth Pages

```
LAYOUT: CenteredLayout (max-w-narrow 640px)
Background: page color, no gradients (align with rest of app)

Card: surface-card-bordered p-7 sm:p-8
  Logo: 32×32 brand icon, centered, mb-section
  Title: heading, text-center
  Subtitle: body, text-tertiary, text-center

  OAuth: 2 buttons, full width, gap-element
    Google: bg white, text gray-900, radius-md
    GitHub: bg surface, border default, text-secondary, radius-md

  Divider: with "or" label, my-section

  Form: gap-component between fields
    Labels: caption, text-secondary
    Inputs: standard Input component
    Submit: Button primary md fullWidth

  Footer: caption, text-muted, text-center, mt-section
    "Don't have an account? Sign up"

COLOR FIX: Replace all gray-* with correct tokens.
  gray-950 → page, gray-900 → card, gray-800 → surface,
  gray-700 → border default, blue-600 → primary.solid.
```

### 6.7 History Page

```
LAYOUT: DetailLayout (max-w-content 800px)

HEADER (sticky):
  "Interview History" — heading
  "{count} sessions" — caption, text-tertiary
  [New Interview] — Button primary sm

SESSIONS LIST: gap-element (12px) between cards

Each card: surface-card-bordered, p-5, cursor-pointer, hover bg surface
  <div class="flex items-center gap-component">
    <!-- Score -->
    <div class="w-11 h-11 rounded-md bg-primary-surface flex items-center justify-center shrink-0">
      <span class="text-subheading text-primary-text font-bold tabular-nums">{score}</span>
    </div>

    <!-- Content -->
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-inline">
        <span class="text-subheading text-primary truncate">{domain}</span>
        <Badge variant={statusVariant}>{status}</Badge>
      </div>
      <span class="text-caption text-tertiary">{timeAgo} · {experience}yrs · {duration}min</span>
    </div>

    <!-- Arrow -->
    <ChevronRight class="w-4 h-4 text-muted shrink-0" />
  </div>

EMPTY STATE:
  <StateView
    state="empty"
    icon={<MicrophoneIcon />}
    title="No interviews yet"
    description="Complete your first mock interview to start tracking your progress."
    action={{ label: "Start Interview", onClick: goHome }}
  />

PAGINATION: simple Previous / Page N of M / Next
```

### 6.8 AppShell Navigation

```
DESKTOP (≥ 768px):
  Top header bar, sticky. h-[52px]. bg card. border-b border-subtle.
  Left: Logo (icon + "Interview Prep Guru")
  Center: Home | History | Progress | Pricing — ghost buttons
  Right: AuthMenu
  Active state: text-primary, bg surface (subtle highlight, no strong bg)

MOBILE (< 768px):
  Top: Logo only (centered), AuthMenu right. h-[48px].
  Bottom tab bar: fixed, h-[56px], bg card, border-t border-subtle.
    Tabs: Home | History | Progress | More
    Each: icon (20px) + label (text-micro), flex-col items-center
    Active: text primary.text
    Inactive: text muted
    "More" → opens a bottom sheet with Pricing, Settings, Sign Out

  IMPORTANT: bottom bar only shown on "app" pages (authenticated).
  Marketing pages (unauthenticated) use footer instead.
```

---

## 7. State Design

Every data-driven component MUST have all 4 states designed. No exceptions.

### State Matrix

| Component | Loading | Empty | Error | Offline |
|-----------|---------|-------|-------|---------|
| DomainSelector | 9 skeleton cards in grid-3 | "No domains available" | "Failed to load domains" + Retry | "You're offline. Domains require internet." |
| DepthSelector | 4 skeleton rows in list | "Select a domain first" | "Failed to load types" + Retry | Same as error with offline context |
| History list | 4 skeleton card rows | "No interviews yet" + Start CTA | "Couldn't load history" + Retry | "History unavailable offline" |
| Feedback scores | 3 MetricCard skeletons | N/A (always has data) | "Feedback generation failed" + Retry | Cached data if available |
| Peer comparison | Chart skeleton (rect) | "Not enough data yet" | "Comparison unavailable" | "Requires internet" |

### Loading Skeleton Rules

```
1. Skeleton shapes MUST match the expected content layout.
   If the content is a list, show list-shaped skeletons.
   If the content is a grid, show grid-shaped skeletons.

2. Skeleton count should be LESS than typical content count.
   If you expect 12 domains, show 6 skeleton cards (suggests "more will load").
   If you expect 3 score cards, show 3 skeleton cards (exact match).

3. Skeleton lines should vary in width to look natural.
   First line: 80% width. Second: 60%. Third: 70%.

4. Pulse animation: 1.5s, opacity 0.04 → 0.10. Gentle, not distracting.

5. NEVER show a spinner as the only loading indicator on a page.
   Spinners are for buttons (inline, small) and actions (submitting).
   Page content loading = skeletons.
```

### Error State Rules

```
1. Errors appear IN-PLACE, not as a full-page takeover.
   If the domain selector fails, the domain area shows the error.
   The rest of the page (steps 2–5) remains visible but grayed/disabled.

2. Always provide a Retry action.

3. Error messages are SPECIFIC:
   ✗ "Something went wrong"
   ✓ "Couldn't load interview domains. Check your connection and try again."

4. After 2 failed retries, show a support link:
   "Still not working? Contact support@interviewprep.guru"
```

---

## 8. Motion & Interaction

### Motion Budget

v1 used animation everywhere: staggered entrances, hover scales, glow pulses, floating blobs. This creates visual noise and feels like a marketing demo, not a professional tool.

**v2 rule: Motion has a purpose or it doesn't exist.**

```
ALLOWED MOTION:
  1. Page entrance: Fade in (opacity 0→1, 400ms). That's it. No translateY. No stagger.
     WHY: The user came here intentionally. They don't need to be "welcomed."

  2. State transitions: Cross-fade between tab panels (250ms).
     WHY: Maintains spatial context when switching views.

  3. Interactive feedback: Button press scale (0.97, 120ms). Selection highlight (250ms bg transition).
     WHY: Confirms the user's action was registered.

  4. Score animations: Bar fill (700ms, spring easing). Ring fill (600ms, spring).
     WHY: This is the ONE place where animation adds meaning — it creates a "reveal" moment.

  5. Live interview: Avatar lip sync, listening dot pulse, typing cursor blink.
     WHY: Communicates real-time state of the AI.

REMOVED MOTION:
  ✗ Staggered entrance delays (stagger-1 through stagger-5) — DELETE
  ✗ Gradient background blobs with blur-3xl — DELETE
  ✗ Hover translateY(-1px) on buttons — DELETE (imperceptible, adds jank)
  ✗ whileHover={{ scale: 1.03 }} on cards — DELETE (cards don't grow on hover in Linear/Vercel)
  ✗ Pulsing dots everywhere — REDUCE to only active-state indicators
  ✗ btn-glow box-shadow animation — SIMPLIFY to static glow on CTA only

THE INTERVIEW ROOM SHOULD FEEL STILL.
  No decorative animation. No gradient rings around the avatar.
  The avatar itself animates (talking, listening). Everything else is calm.
  Think: Zoom call UI. Clean, functional, not flashy.
```

### Transition Timings

```
TIMING           DURATION   EASING                              USE
instant          0ms        —                                   Tooltip positioning
micro            120ms      ease                                Button active, toggle
fast             250ms      cubic-bezier(0.16, 1, 0.3, 1)      Tab switch, selection, hover
normal           400ms      cubic-bezier(0.16, 1, 0.3, 1)      Page fade-in, accordion expand
expressive       700ms      cubic-bezier(0.34, 1.56, 0.64, 1)  Score reveals only
```

---

## 9. Responsive Strategy (Revised)

### Approach: Laptop-First, Mobile-Aware

v1 said "mobile-first." That was wrong for this product. The primary interview experience requires a camera, microphone, and enough screen real estate for a video call — that's a laptop.

```
PRIMARY DESIGN TARGET:   1280×800 (13" laptop)
SECONDARY:               768×1024 (tablet portrait)
TERTIARY:                375×812 (phone — for checking history/feedback)

NOT A TARGET:            320px width, 4G throttled (this is a niche tool, not a mass app)
STILL IMPORTANT:         Slow wifi (skeleton states), variable latency (optimistic UI)
```

### Breakpoints

| Breakpoint | When | Layout Changes |
|------------|------|----------------|
| Default (< 768px) | Phone | Single column. Bottom tab nav. Simplified cards. |
| `md` (≥ 768px) | Tablet / small laptop | 2-column grids. Top nav. Full cards. |
| `lg` (≥ 1024px) | Laptop | 3-column grids. Wider containers. Side-by-side interview tiles. |
| `xl` (≥ 1280px) | Desktop | Max-width constraints. Generous whitespace. |

### Page Width Constraints

```
EVERY page has a max-width. NO page stretches to full viewport.

Auth pages:     max-w-[640px]    (narrow, centered)
Setup wizard:   max-w-[800px]    (focused, single-task)
Feedback:       max-w-[800px]    (readable line length)
History:        max-w-[800px]    (scannable list)
Pricing:        max-w-[1000px]   (3 cards need room)
Interview:      max-w-none       (full viewport, functional need)
```

---

## 10. Accessibility

### Contrast Fixes (v2)

```
FIXED ISSUE FROM v1: slate-500 on elevated backgrounds failing WCAG.

v2 text.tertiary is gray-500 (#6b7280) on card (#0c1220):
  Contrast ratio: 5.2:1 → PASSES AA ✓

v2 text.muted is gray-600 (#4b5563) on card (#0c1220):
  Contrast ratio: 3.6:1 → Passes AA for large text only.
  USAGE: Only for decorative text (step number dividers, disabled labels).
  Never for informational content.
```

### Focus Management

```
Global: focus-visible ring 2px primary.solid, offset 2px, offset-color page.
Interview room: Focus trap. Escape → confirm dialog (not instant end).
Modals: Focus trap. Return focus to trigger on close.
Tab panels: Arrow keys between tabs, Tab into panel content.
SelectionGroup: Arrow keys move selection, Enter/Space confirms.
```

### Screen Reader Announcements

```
Score components: role="meter" with aria-valuenow, aria-label.
Interview phase: aria-live="polite" for phase changes.
Loading states: aria-busy="true" on parent container.
Error states: role="alert" for inline errors.
```

---

## 11. Migration Plan (Revised)

### Phase 1 — Tokens + Primitives (Week 1)

| Task | Effort |
|------|--------|
| Create `lib/design-tokens.ts` v2 | 2h |
| Update `tailwind.config.js` | 1h |
| Rewrite `globals.css` with text roles + surface classes | 2h |
| Build `Button` component | 2h |
| Build `Input` component | 1h |
| Build `Badge` component | 1h |
| Build `Skeleton` component | 1h |
| Build `Divider` component | 30m |

### Phase 2 — Patterns (Week 2)

| Task | Effort |
|------|--------|
| Build `SelectionGroup` (all 4 layouts) | 6h |
| Build `MetricCard` | 3h |
| Build `StepSection` | 1h |
| Build `StateView` (loading, empty, error, offline) | 3h |
| Build `Accordion` | 2h |

### Phase 3 — Page Migrations (Weeks 3–4)

| Task | Effort |
|------|--------|
| Homepage: Split auth/unauth + implement with new components | 6h |
| Auth pages: Align to design system | 2h |
| History page: New card design + StateView | 2h |
| Pricing page: Accordion + email capture | 3h |
| Feedback page: MetricCard integration + responsive grid | 4h |
| AppShell: Mobile bottom nav | 3h |
| Lobby page: Align to new tokens | 2h |

### Phase 4 — Interview Page + Polish (Week 5)

| Task | Effort |
|------|--------|
| Interview page: Mobile PiP layout | 6h |
| Motion cleanup: Remove stagger, blobs, excess animation | 2h |
| Accessibility pass: Focus, ARIA, contrast | 3h |
| Cross-browser testing | 2h |

**Total: ~60 hours (7–8 working days)**

---

## 12. Design Context for Future Development

### Decision Log (v2)

| Decision | Rationale |
|----------|-----------|
| Laptop-first, not mobile-first | Primary use case (mock interview) requires camera + mic + screen real estate |
| 4 background layers instead of 2 | Enables separation without borders. Closer to Linear/Vercel depth model |
| Accent colors limited to 3 values each | Eliminates the opacity variant sprawl (10/15/20/25/30%) |
| SelectionGroup as single component for all selection UIs | Enforces consistency across domain/type/experience/duration selectors |
| List layout for interview types (not grid/scroll) | 6 items with descriptions need readable, scannable presentation |
| Domain grid shows icon+label only, detail on select | Reduces visual noise by 60% while preserving information access |
| Removed stagger animations and gradient blobs | Professional tools don't need entrance choreography. Calm > flashy |
| Score animation is the ONE expressive motion | Creates a meaningful "reveal" moment for the thing users care most about |
| Skeleton states match expected content shape | Reduces perceived loading time and prevents layout shift |
| In-place errors, never full-page takeover | Failing gracefully means the rest of the UI stays usable |
| Borders as secondary separator (whitespace + bg first) | Reduces the "grid of boxes" appearance. More Linear-like. |
| text-[10px] banned | If something needs to be 10px, the information isn't important enough to show |

### When Adding a New Component

```
1. Does SelectionGroup, MetricCard, or StateView already handle this? Use them.
2. If new, define: variants, sizes, states (default/hover/active/disabled/loading/error/empty).
3. Colors: ONLY from tokens. 3 values per accent (text/surface/border). No new opacities.
4. Spacing: Use named roles (inline/element/component/section/region). Not arbitrary values.
5. Radius: sm (6) for small, md (10) for cards, lg (14) for hero. No radius-2xl.
6. Motion: Only if it communicates state change. Default is no animation.
7. Accessibility: focus-visible ring, aria-labels, keyboard navigation.
8. States: loading (skeleton), empty (StateView), error (StateView), offline (StateView).
```

### When Adding a New Page

```
1. Choose template: WizardLayout, DetailLayout, or CenteredLayout.
2. Set max-width from tokens (narrow/content/page/wide).
3. Use section-gap (32px) between groups, region-gap (56px) between major sections.
4. Page entrance: single opacity fade, 400ms. No stagger.
5. Mobile: test at 375px width. Ensure bottom nav doesn't overlap content.
6. Loading: full-page skeleton matching expected layout.
7. Error: in-place error with retry in the component that failed.
```

### Color Quick-Reference Card

```
                TEXT            SURFACE              BORDER
─────────────────────────────────────────────────────────────
Primary      indigo-400     rgba(99,102,241,0.08)  rgba(99,102,241,0.15)
Success      emerald-400    rgba(16,185,129,0.08)  rgba(16,185,129,0.15)
Caution      amber-400      rgba(245,158,11,0.08)  rgba(245,158,11,0.15)
Danger       red-400        rgba(239,68,68,0.08)   rgba(239,68,68,0.15)

Background:  page #070b14 → card #0c1220 → surface #151d2e → raised #1c2539
Text:        primary #f0f2f5 → secondary #b0b8c4 → tertiary #6b7280 → muted #4b5563
Border:      subtle 0.06 → default 0.10 → strong 0.15
```

---

*End of v2. This supersedes v1 entirely. The v1 file (REDESIGN-PLAN.md) should be archived, not deleted, for reference.*
