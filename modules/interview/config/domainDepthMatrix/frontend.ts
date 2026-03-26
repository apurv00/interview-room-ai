import type { DomainDepthOverride } from './types'

export const frontendOverrides: Record<string, DomainDepthOverride> = {
  'frontend:screening': {
    questionStrategy: 'Probe motivation for frontend development, passion for user experience, and culture fit within engineering teams. Ask about preferred frameworks, what excites them about UI work, and how they stay current with the fast-moving frontend ecosystem.',
    interviewerTone: 'Friendly and enthusiastic about web technologies. Show genuine curiosity about their UI/UX passion.',
    scoringEmphasis: 'Evaluate communication clarity, genuine enthusiasm for frontend craft, culture fit signals, and ability to articulate why they chose frontend over other engineering paths.',
    antiPatterns: 'Do NOT ask about CSS specificity rules, JavaScript closures, or any technical deep-dives. Screening is about motivation, communication, and culture fit.',
    experienceCalibration: {
      '0-2': 'Expect enthusiasm and basic awareness of frontend frameworks. Probe for learning mindset, portfolio projects, and genuine interest in UI/UX.',
      '3-6': 'Expect clear articulation of why frontend over fullstack/backend, awareness of ecosystem trends, and concrete examples of shipped user-facing features.',
      '7+': 'Expect strategic perspective on frontend as a discipline, mentoring philosophy, and ability to connect frontend craft to business outcomes.',
    },
    domainRedFlags: [
      'Cannot articulate why they prefer frontend over other engineering disciplines',
      'Shows no awareness of current frontend ecosystem or tooling trends',
      'Describes UI work purely in technical terms with no mention of user experience',
    ],
  },
  'frontend:behavioral': {
    questionStrategy: 'Explore leadership in frontend-specific scenarios: navigating design-engineering conflicts, handling browser compatibility crises, advocating for accessibility when stakeholders push back, managing tech debt in UI codebases, and mentoring junior frontend developers.',
    interviewerTone: 'Thoughtful and empathetic. Dig into the human side of frontend challenges — collaboration with designers, handling subjective feedback.',
    scoringEmphasis: 'Evaluate depth of reflection on cross-functional collaboration, self-awareness about design tradeoffs, growth mindset around rapidly changing frontend technologies.',
    antiPatterns: 'Do NOT ask technical trivia like "explain the virtual DOM" or quiz on CSS properties. Behavioral rounds focus on collaboration, conflict resolution, and growth stories.',
    experienceCalibration: {
      '0-2': 'Expect stories from bootcamps, internships, or first jobs. Look for self-awareness, willingness to learn from feedback, and early signs of collaboration with designers.',
      '3-6': 'Expect nuanced stories about cross-functional conflict, accessibility advocacy, and navigating design vs. engineering tradeoffs on real products.',
      '7+': 'Expect leadership narratives: mentoring juniors, driving frontend standards across teams, influencing product direction, and managing stakeholder expectations around UI quality.',
    },
    domainRedFlags: [
      'Cannot name specific UI frameworks or tools they have used',
      'Blames designers for implementation challenges without showing collaboration',
      'No examples of user-facing impact or metrics',
    ],
  },
  'frontend:technical': {
    questionStrategy: 'Deep-dive into React/Vue/Angular architecture, state management patterns, rendering optimization (virtual DOM, reconciliation), CSS architecture (BEM, CSS-in-JS, utility-first), web performance (Core Web Vitals, bundle splitting, lazy loading), accessibility (WCAG, ARIA), and testing strategies (unit, integration, E2E).',
    interviewerTone: 'Collaborative technical peer. Engage in dialogue about architecture tradeoffs rather than quizzing on trivia.',
    technicalTranslation: 'Technical means: component architecture, rendering performance, state management patterns, CSS systems, accessibility implementation, browser APIs, and build tooling.',
    scoringEmphasis: 'Evaluate depth of understanding in rendering pipelines, ability to reason about performance tradeoffs, awareness of accessibility standards, and practical experience with modern frontend tooling.',
    antiPatterns: 'Do NOT ask algorithm/data structure questions or backend system design. Technical for frontend means UI architecture, rendering performance, CSS systems, and browser APIs.',
    experienceCalibration: {
      '0-2': 'Expect solid fundamentals: basic React/component patterns, CSS layout, simple state management. Probe learning speed and enthusiasm for the craft.',
      '3-6': 'Expect production-level skills: performance optimization, state management architecture, testing strategies, accessibility compliance. Probe real-world tradeoff experience.',
      '7+': 'Expect architectural leadership: design system creation, micro-frontend decisions, build pipeline optimization, mentoring approaches. Probe strategic decisions and org-wide impact.',
    },
    domainRedFlags: [
      'Cannot explain how their chosen framework renders updates to the DOM',
      'No awareness of web accessibility standards or Core Web Vitals',
      'Describes only toy projects with no production-scale complexity',
      'Cannot articulate tradeoffs between different state management approaches',
    ],
  },
  'frontend:case-study': {
    questionStrategy: 'Present UI architecture and system design scenarios: design a component library, architect a micro-frontend system, plan a migration from legacy jQuery to React, design an offline-first progressive web app, or optimize a dashboard rendering thousands of data points.',
    interviewerTone: 'Case facilitator who sets up realistic frontend architecture challenges. Provide constraints and let the candidate drive the solution.',
    technicalTranslation: 'Case study means: UI system design, component architecture decisions, migration planning, and performance engineering scenarios.',
    scoringEmphasis: 'Evaluate structured approach to UI architecture, ability to identify and reason about tradeoffs (SSR vs CSR, monolith vs micro-frontends), consideration of developer experience alongside user experience.',
    antiPatterns: 'Do NOT present generic backend system design problems. Case studies for frontend should center on UI architecture, component systems, migration strategies, and rendering at scale.',
    experienceCalibration: {
      '0-2': 'Expect basic component decomposition and layout planning. Guide them through constraints and look for structured thinking even if the solution is simple.',
      '3-6': 'Expect awareness of SSR vs CSR tradeoffs, component library design, and migration planning. Probe for real experience with architectural decisions.',
      '7+': 'Expect comprehensive system thinking: design systems at scale, micro-frontend governance, build infrastructure, cross-team developer experience, and performance budgets.',
    },
    domainRedFlags: [
      'Jumps straight to implementation without clarifying requirements or constraints',
      'No consideration of developer experience or component reusability',
      'Cannot reason about rendering strategy tradeoffs (SSR, CSR, ISR)',
    ],
  },
}
