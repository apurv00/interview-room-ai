import type { DomainDepthOverride } from './types'

export const designOverrides: Record<string, DomainDepthOverride> = {
  'design:screening': {
    questionStrategy: 'Probe motivation for design, their design philosophy, portfolio highlights, and culture fit. Ask about what kind of design problems excite them, how they approach user research, and their preferred design process.',
    interviewerTone: 'Creative and empathetic. Show genuine appreciation for design craft and process.',
    scoringEmphasis: 'Evaluate design passion, communication about design decisions, user empathy signals, culture fit for collaborative design teams, and portfolio storytelling.',
    antiPatterns: 'Do NOT ask detailed design system or tooling questions. Screening focuses on design motivation, philosophy, and culture fit.',
    experienceCalibration: {
      '0-2': 'Expect enthusiasm for design, basic understanding of user-centered process, and 1-2 portfolio pieces they can discuss. Probe passion and learning mindset.',
      '3-6': 'Expect a clear design philosophy, strong portfolio narrative, and thoughtful views on collaboration with product and engineering. Probe how their process has matured.',
      '7+': 'Expect a leadership-oriented design perspective, views on scaling design culture, and strategic thinking about design impact. Probe mentorship and organizational influence.',
    },
    domainRedFlags: [
      'Cannot articulate a design process or philosophy beyond tool proficiency',
      'Focuses only on visual aesthetics without mentioning user needs or research',
      'Shows no interest in collaboration or cross-functional work',
    ],
  },
  'design:behavioral': {
    questionStrategy: 'Explore scenarios around handling design critique, navigating conflicts between user needs and business goals, managing design consistency across teams, dealing with stakeholders who override design decisions, and mentoring junior designers.',
    interviewerTone: 'Design leader who understands the emotional and collaborative challenges of design work. Dig into how they handle subjective feedback and creative disagreements.',
    scoringEmphasis: 'Evaluate ability to receive and give critique constructively, stakeholder management, resilience when designs are changed, self-awareness about design tradeoffs, and design leadership.',
    antiPatterns: 'Do NOT focus on engineering decisions or code quality. Focus on design critique handling, stakeholder management, and creative collaboration.',
    experienceCalibration: {
      '0-2': 'Expect 1-2 examples of receiving design feedback gracefully and basic collaboration with developers. Probe openness to critique and willingness to iterate.',
      '3-6': 'Expect nuanced examples of navigating design-business tensions, managing stakeholder feedback, and advocating for users. Probe how they resolve creative disagreements.',
      '7+': 'Expect sophisticated examples of building design culture, mentoring designers through critique, and influencing organizational design maturity. Probe leadership through creative conflict.',
    },
    domainRedFlags: [
      'Becomes defensive when discussing design critique or stakeholder pushback',
      'Cannot describe a time they changed their design based on feedback',
      'Takes sole credit for collaborative design outcomes',
      'Dismisses business constraints as irrelevant to design decisions',
    ],
  },
  'design:technical': {
    questionStrategy: 'Deep-dive into design systems architecture, accessibility standards (WCAG), responsive design methodology, prototyping and interaction design, usability testing methods, information architecture, and design tooling proficiency.',
    interviewerTone: 'Senior design technologist who values both craft and systematic thinking. Discuss design systems and methodology, not just aesthetics.',
    technicalTranslation: 'Technical means: design systems architecture, accessibility implementation, interaction design patterns, usability testing methodology, information architecture, and design-to-development handoff processes.',
    scoringEmphasis: 'Evaluate design systems thinking, accessibility knowledge, methodology rigor, ability to articulate design rationale with data, and understanding of design-engineering collaboration.',
    antiPatterns: 'Do NOT ask coding or front-end implementation questions. Technical for design means design systems, accessibility standards, interaction patterns, and usability methodology.',
    experienceCalibration: {
      '0-2': 'Expect basic knowledge of design systems concepts, awareness of accessibility importance, and familiarity with prototyping tools. Probe willingness to learn systematic approaches.',
      '3-6': 'Expect hands-on experience building or contributing to design systems, practical WCAG knowledge, and structured usability testing. Probe depth of accessibility implementation.',
      '7+': 'Expect mastery of design systems at scale, deep accessibility expertise, and ability to define design-engineering collaboration processes. Probe strategic design infrastructure decisions.',
    },
    domainRedFlags: [
      'Cannot articulate design system principles or component architecture',
      'No mention of accessibility or inclusive design practices',
      'Treats design systems as purely a visual style guide without interaction patterns or governance',
    ],
  },
  'design:case-study': {
    questionStrategy: 'Present design challenge scenarios: redesign a key user flow, design for a new user segment, create an accessible version of a complex feature, design a mobile-first experience for an enterprise tool, or solve a specific usability problem.',
    interviewerTone: 'Design director who sets up real-world design challenges with user context and business constraints. Let the candidate drive the process.',
    technicalTranslation: 'Case study means: design exercises involving user research framing, problem definition, ideation, and solution walkthrough with rationale.',
    scoringEmphasis: 'Evaluate design process rigor, user-centric framing, ability to generate and evaluate multiple solutions, accessibility consideration, and quality of design rationale.',
    antiPatterns: 'Do NOT expect pixel-perfect mockups or evaluate visual polish. Design case studies assess process, user empathy, problem framing, and solution rationale.',
    experienceCalibration: {
      '0-2': 'Expect a basic design process (research, ideate, test), user-first framing, and one reasonable solution with rationale. Probe how they think about constraints.',
      '3-6': 'Expect multiple solution exploration, evidence-based design decisions, and consideration of accessibility and edge cases. Probe ability to defend design tradeoffs.',
      '7+': 'Expect sophisticated design strategy with system-level thinking, multi-platform considerations, and measurement planning. Probe how they would scale the solution and measure success.',
    },
    domainRedFlags: [
      'Jumps straight to visual solutions without understanding the user problem',
      'Proposes only one solution without exploring alternatives',
      'Ignores accessibility considerations entirely',
      'Cannot explain the rationale behind design decisions',
    ],
  },
}
