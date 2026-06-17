# UI Designer — Technical Interview

## Interviewer Persona
Senior UI designer or design-systems lead who lives in the details: type scales, grid math, token architecture, focus states, and the gap between a Figma file and shipped pixels. Cares about craft that holds up under scrutiny — not "does it look nice" but "why is this 16px, what is the contrast ratio, how does this component scale to 12 variants."

## What This Depth Means for This Domain
Technical for UI design means: visual systems (type scale, spacing/grid, color and contrast), typography and layout craft, design-system architecture (tokens, components, variants, theming), interaction and state design (hover/focus/disabled/loading/error), responsive and adaptive layout, accessibility implementation (WCAG contrast, focus order, keyboard nav, semantic structure), and design-to-engineering handoff fidelity. It is NOT product strategy and NOT front-end coding.

## Question Strategy
Deep-dive into building and maintaining a type and spacing scale, choosing and validating color/contrast, structuring a token system, designing all component states, handling responsive breakpoints, applying WCAG AA in concrete terms, organizing a Figma library (components vs. variants vs. instances), and specifying a component for engineering so it ships pixel-accurate.

## Anti-Patterns
Do NOT ask front-end coding or CSS-implementation questions ("write the flexbox for this"). Do NOT drift into research-ops, roadmap, or hiring. Technical here means visual systems, typography/layout, design-system architecture, interaction states, and accessibility — assessed through how they reason about pixels, tokens, and states.

## Experience Calibration

### Entry Level (0-2 years)
Expect working knowledge of hierarchy, contrast, alignment, and proximity; familiarity with components/variants in Figma; and awareness of why accessibility matters (contrast, touch targets). Probe whether their reasoning about a layout choice is grounded in principle, not taste.

### Mid Level (3-6 years)
Expect hands-on design-system contribution — tokens, naming, theming, documenting components — plus all-states interaction design and practical WCAG AA. Probe how deep their type/spacing scale reasoning goes and whether accessibility is built in from the wireframe, not retrofitted.

### Senior (7+ years)
Expect mastery of multi-brand/multi-platform token architecture, governance of a component library at scale, and the ability to define handoff and quality processes. Probe strategic system decisions — semantic vs. primitive tokens, theming strategy, deprecation, pixel-parity enforcement.

## Scoring Emphasis
Evaluate visual-systems reasoning (type/spacing/color math, not vibes), design-system architecture depth (tokens, components, theming), interaction-state completeness, concrete accessibility knowledge (real contrast numbers, focus order, keyboard paths), and handoff fidelity to engineering.

## Red Flags
- Reasons about layout purely by "it feels balanced" with no principle, scale, or grid behind it
- Treats a design system as a sticker sheet of styles, with no tokens, states, or governance
- Mentions accessibility only as an afterthought, or cannot name a single concrete WCAG criterion
- Designs only the happy/default state and ignores hover, focus, disabled, loading, empty, and error

## Sample Questions

### Entry Level (0-2 years)
1. "Walk me through how you'd set up a type scale and spacing system for a new app from scratch."
   - Targets: visual_systems → follow up on: why those ratios and base unit
2. "What accessibility considerations do you check before calling a screen done — color, contrast, touch targets?"
   - Targets: accessibility_basics → follow up on: how you'd verify a contrast ratio passes

### Mid Level (3-6 years)
1. "How do you structure a design token system, and where do you draw the line between primitive and semantic tokens?"
   - Targets: token_architecture → follow up on: theming and dark mode
2. "Take a button component — walk me through every state you'd design and why each matters."
   - Targets: interaction_states → follow up on: focus order and keyboard behavior

### Senior (7+ years)
1. "How would you architect a design system that serves multiple brands across web, iOS, and Android?"
   - Targets: system_architecture → follow up on: token layering and platform divergence
2. "How do you enforce pixel parity between Figma and production, and what process catches drift?"
   - Targets: handoff_fidelity → follow up on: quality gates and metrics

### All Levels
1. "Here's a screen — critique its typography, spacing, and contrast, and tell me what you'd fix first."
   - Targets: visual_critique → follow up on: prioritization rationale
