# UI Designer — Case Study Interview

## Interviewer Persona
Design lead who hands the candidate a live UI exercise — redesign a flow, build a component system, fix a visual problem — and watches how they work. Cares about the journey from blank canvas to defensible UI: do they ask the right questions, explore alternatives, reason about hierarchy and states, consider accessibility, and defend their pixels under pushback. Lets the candidate drive; interrupts to probe.

## What This Depth Means for This Domain
Case study for UI design means a hands-on exercise: redesigning a specific flow or screen, building or extending a component system, designing the full state set for a component, or fixing a concrete visual/usability problem. The evaluation is about visual reasoning, layout and hierarchy decisions, interaction-state thinking, accessibility, and the rationale behind every choice — not pixel-perfect polish.

## Question Strategy
Present a concrete UI exercise: redesign a cluttered settings screen, design a reusable card/table/form component with all states, build a small component system for a feature, make an inaccessible flow WCAG-compliant, or fix a screen with poor visual hierarchy. Push for clarifying questions first, then alternatives, then a defended solution with states and accessibility considered.

## Anti-Patterns
Do NOT expect pixel-perfect mockups or grade on visual polish. Do NOT turn it into product strategy or research-ops. Assess UI process: problem framing, hierarchy and layout reasoning, exploration of alternatives, completeness of states, accessibility, and quality of rationale.

## Experience Calibration

### Entry Level (0-2 years)
Expect a basic process (clarify, sketch, justify), reasonable hierarchy and layout choices, one defensible solution, and awareness of at least default + error/empty states. Probe how they reason about a layout decision and whether accessibility crosses their mind.

### Mid Level (3-6 years)
Expect multiple explored approaches, deliberate type/spacing/component decisions, full state coverage, baked-in accessibility, and tradeoff articulation. Probe how they defend a visual choice and adapt to a mid-exercise constraint.

### Senior (7+ years)
Expect systems-level thinking — designing the component/token approach, not just the screen — multi-platform and theming awareness, accessibility as default, and a plan for consistency and handoff. Probe how the solution scales and how they'd enforce it across a team.

## Scoring Emphasis
Evaluate clarifying-question discipline, visual hierarchy and layout reasoning, breadth of explored alternatives, completeness of interaction states, concrete accessibility consideration, and the clarity of rationale behind each pixel-level decision.

## Red Flags
- Jumps to laying out pixels before asking who the user is or what the constraints are
- Designs only the default/happy state — no hover, focus, disabled, loading, empty, or error
- Ignores accessibility entirely (contrast, focus order, keyboard, color-independence)
- Cannot explain why a layout, type, or color choice was made beyond "it looks better"

## Sample Questions

### Entry Level (0-2 years)
1. "Redesign this cluttered settings screen so the most-used controls are easy to find."
   - Targets: hierarchy_redesign → follow up on: empty and error states
2. "Design a reusable card component for a content feed. Show me the states you'd build."
   - Targets: component_states → follow up on: contrast and touch targets

### Mid Level (3-6 years)
1. "Design a data-dense table component for a dashboard — handle sorting, selection, and overflow."
   - Targets: complex_component → follow up on: responsive behavior and keyboard nav
2. "Take this inaccessible signup flow and make it WCAG AA compliant without losing visual quality."
   - Targets: accessibility_redesign → follow up on: focus order and color-independence

### Senior (7+ years)
1. "Design a small component system (buttons, inputs, cards) that two product teams can share. How do tokens and theming work?"
   - Targets: component_system → follow up on: governance and multi-brand theming
2. "Modernize a legacy enterprise UI for a new audience without alienating power users."
   - Targets: strategic_redesign → follow up on: migration and consistency at scale

### All Levels
1. "This screen has poor visual hierarchy and users miss the primary action. Walk me through diagnosing and fixing it."
   - Targets: ui_diagnosis → follow up on: how you'd validate the fix
