import type { DomainDepthOverride } from './types'

export const frontendOverrides: Record<string, DomainDepthOverride> = {
  'frontend:screening': {
    questionStrategy: 'Probe motivation for frontend development, passion for user experience, and culture fit within engineering teams. Ask about preferred frameworks, what excites them about UI work, and how they stay current with the fast-moving frontend ecosystem.',
    interviewerTone: 'Friendly and enthusiastic about web technologies. Show genuine curiosity about their UI/UX passion.',
    scoringEmphasis: 'Evaluate communication clarity, genuine enthusiasm for frontend craft, culture fit signals, and ability to articulate why they chose frontend over other engineering paths.',
    sampleOpeners: [
      'What drew you to frontend engineering specifically?',
      'Tell me about a UI you built that you are really proud of.',
    ],
  },
  'frontend:behavioral': {
    questionStrategy: 'Explore leadership in frontend-specific scenarios: navigating design-engineering conflicts, handling browser compatibility crises, advocating for accessibility when stakeholders push back, managing tech debt in UI codebases, and mentoring junior frontend developers.',
    interviewerTone: 'Thoughtful and empathetic. Dig into the human side of frontend challenges — collaboration with designers, handling subjective feedback.',
    scoringEmphasis: 'Evaluate depth of reflection on cross-functional collaboration, self-awareness about design tradeoffs, growth mindset around rapidly changing frontend technologies.',
    sampleOpeners: [
      'Tell me about a time you disagreed with a designer on an implementation approach.',
      'Describe a situation where you had to advocate for accessibility against a tight deadline.',
    ],
  },
  'frontend:technical': {
    questionStrategy: 'Deep-dive into React/Vue/Angular architecture, state management patterns, rendering optimization (virtual DOM, reconciliation), CSS architecture (BEM, CSS-in-JS, utility-first), web performance (Core Web Vitals, bundle splitting, lazy loading), accessibility (WCAG, ARIA), and testing strategies (unit, integration, E2E).',
    interviewerTone: 'Collaborative technical peer. Engage in dialogue about architecture tradeoffs rather than quizzing on trivia.',
    technicalTranslation: 'Technical means: component architecture, rendering performance, state management patterns, CSS systems, accessibility implementation, browser APIs, and build tooling.',
    scoringEmphasis: 'Evaluate depth of understanding in rendering pipelines, ability to reason about performance tradeoffs, awareness of accessibility standards, and practical experience with modern frontend tooling.',
    sampleOpeners: [
      'Walk me through how you would architect the state management for a complex multi-step form with real-time validation.',
      'How do you approach performance optimization when Core Web Vitals scores are poor?',
    ],
  },
  'frontend:case-study': {
    questionStrategy: 'Present UI architecture and system design scenarios: design a component library, architect a micro-frontend system, plan a migration from legacy jQuery to React, design an offline-first progressive web app, or optimize a dashboard rendering thousands of data points.',
    interviewerTone: 'Case facilitator who sets up realistic frontend architecture challenges. Provide constraints and let the candidate drive the solution.',
    technicalTranslation: 'Case study means: UI system design, component architecture decisions, migration planning, and performance engineering scenarios.',
    scoringEmphasis: 'Evaluate structured approach to UI architecture, ability to identify and reason about tradeoffs (SSR vs CSR, monolith vs micro-frontends), consideration of developer experience alongside user experience.',
    sampleOpeners: [
      'Design a reusable component library that will be shared across 5 product teams. Walk me through your approach.',
      'You inherit a legacy jQuery dashboard with 50+ pages. How would you plan the migration to a modern framework?',
    ],
  },
}
