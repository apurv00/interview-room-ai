import type { DomainDepthOverride } from './types'

export const designOverrides: Record<string, DomainDepthOverride> = {
  'design:screening': {
    questionStrategy: 'Probe motivation for design, their design philosophy, portfolio highlights, and culture fit. Ask about what kind of design problems excite them, how they approach user research, and their preferred design process.',
    interviewerTone: 'Creative and empathetic. Show genuine appreciation for design craft and process.',
    scoringEmphasis: 'Evaluate design passion, communication about design decisions, user empathy signals, culture fit for collaborative design teams, and portfolio storytelling.',
    sampleOpeners: [
      'What kind of design problems are you most passionate about solving?',
      'Walk me through a project from your portfolio that you are most proud of.',
    ],
  },
  'design:behavioral': {
    questionStrategy: 'Explore scenarios around handling design critique, navigating conflicts between user needs and business goals, managing design consistency across teams, dealing with stakeholders who override design decisions, and mentoring junior designers.',
    interviewerTone: 'Design leader who understands the emotional and collaborative challenges of design work. Dig into how they handle subjective feedback and creative disagreements.',
    scoringEmphasis: 'Evaluate ability to receive and give critique constructively, stakeholder management, resilience when designs are changed, self-awareness about design tradeoffs, and design leadership.',
    sampleOpeners: [
      'Tell me about a time your design was significantly changed by stakeholder feedback. How did you handle it?',
      'Describe a situation where user research contradicted what the business wanted to build.',
    ],
  },
  'design:technical': {
    questionStrategy: 'Deep-dive into design systems architecture, accessibility standards (WCAG), responsive design methodology, prototyping and interaction design, usability testing methods, information architecture, and design tooling proficiency.',
    interviewerTone: 'Senior design technologist who values both craft and systematic thinking. Discuss design systems and methodology, not just aesthetics.',
    technicalTranslation: 'Technical means: design systems architecture, accessibility implementation, interaction design patterns, usability testing methodology, information architecture, and design-to-development handoff processes.',
    scoringEmphasis: 'Evaluate design systems thinking, accessibility knowledge, methodology rigor, ability to articulate design rationale with data, and understanding of design-engineering collaboration.',
    sampleOpeners: [
      'How would you approach building a design system from scratch for a company with 5 product teams?',
      'Walk me through your process for conducting and synthesizing user research.',
    ],
  },
  'design:case-study': {
    questionStrategy: 'Present design challenge scenarios: redesign a key user flow, design for a new user segment, create an accessible version of a complex feature, design a mobile-first experience for an enterprise tool, or solve a specific usability problem.',
    interviewerTone: 'Design director who sets up real-world design challenges with user context and business constraints. Let the candidate drive the process.',
    technicalTranslation: 'Case study means: design exercises involving user research framing, problem definition, ideation, and solution walkthrough with rationale.',
    scoringEmphasis: 'Evaluate design process rigor, user-centric framing, ability to generate and evaluate multiple solutions, accessibility consideration, and quality of design rationale.',
    sampleOpeners: [
      'Redesign the checkout flow for an e-commerce app where 60% of users abandon at the payment step.',
      'Design an onboarding experience for a complex B2B analytics tool targeting non-technical users.',
    ],
  },
}
