import type { PoolQuestion } from './types'

export const frontendQuestions: Record<string, PoolQuestion[]> = {
  'frontend:screening': [
    { question: 'What first got you interested in frontend development?', experience: '0-2', targetCompetency: 'motivation', followUpTheme: 'learning journey' },
    { question: 'Tell me about a UI feature you built that you are proud of.', experience: '0-2', targetCompetency: 'craft_passion', followUpTheme: 'technical decisions' },
    { question: 'How do you stay current with the frontend ecosystem?', experience: '3-6', targetCompetency: 'growth_mindset', followUpTheme: 'applied learning' },
    { question: 'What made you choose frontend over fullstack or backend?', experience: '3-6', targetCompetency: 'career_direction', followUpTheme: 'tradeoff reasoning' },
    { question: 'How do you think about the frontend engineer role evolving over the next few years?', experience: '7+', targetCompetency: 'strategic_thinking', followUpTheme: 'team implications' },
    { question: 'What is your philosophy on balancing developer experience with user experience?', experience: '7+', targetCompetency: 'leadership', followUpTheme: 'org-level decisions' },
    { question: 'What kind of frontend challenges excite you the most?', experience: 'all', targetCompetency: 'passion', followUpTheme: 'specific examples' },
  ],
  'frontend:behavioral': [
    { question: 'Tell me about a time you disagreed with a designer on how to implement a feature.', experience: '0-2', targetCompetency: 'collaboration', followUpTheme: 'resolution approach' },
    { question: 'Describe a situation where you had to ship a UI under a tight deadline. What tradeoffs did you make?', experience: '0-2', targetCompetency: 'prioritization', followUpTheme: 'quality impact' },
    { question: 'Tell me about a time you advocated for accessibility when others wanted to skip it.', experience: '3-6', targetCompetency: 'advocacy', followUpTheme: 'influence tactics' },
    { question: 'Describe how you handled a major browser compatibility issue in production.', experience: '3-6', targetCompetency: 'incident_handling', followUpTheme: 'prevention measures' },
    { question: 'Tell me about a time you led a frontend architecture decision that affected multiple teams.', experience: '7+', targetCompetency: 'technical_leadership', followUpTheme: 'stakeholder alignment' },
    { question: 'How did you mentor a junior frontend developer through a challenging technical growth area?', experience: '7+', targetCompetency: 'mentorship', followUpTheme: 'coaching approach' },
    { question: 'Describe a time you had to balance tech debt cleanup with feature delivery in a UI codebase.', experience: 'all', targetCompetency: 'prioritization', followUpTheme: 'decision framework' },
  ],
  'frontend:technical': [
    { question: 'How would you manage state in a complex multi-step form with real-time validation?', experience: '0-2', targetCompetency: 'state_management', followUpTheme: 'library choices' },
    { question: 'Explain how your favorite framework handles DOM updates under the hood.', experience: '0-2', targetCompetency: 'framework_depth', followUpTheme: 'performance implications' },
    { question: 'How do you approach optimizing Core Web Vitals for a content-heavy page?', experience: '3-6', targetCompetency: 'performance', followUpTheme: 'measurement and iteration' },
    { question: 'Walk me through how you would design an accessible form system that works with screen readers.', experience: '3-6', targetCompetency: 'accessibility', followUpTheme: 'WCAG compliance' },
    { question: 'How would you architect a design system that serves five product teams with different needs?', experience: '7+', targetCompetency: 'system_architecture', followUpTheme: 'governance and adoption' },
    { question: 'What is your approach to deciding between server-side rendering and client-side rendering for different pages?', experience: '7+', targetCompetency: 'architecture_tradeoffs', followUpTheme: 'performance vs DX' },
    { question: 'How do you approach testing strategies for a frontend application?', experience: 'all', targetCompetency: 'testing', followUpTheme: 'testing pyramid balance' },
  ],
  'frontend:case-study': [
    { question: 'Design a reusable component library that will be shared across multiple product teams.', experience: '0-2', targetCompetency: 'component_design', followUpTheme: 'API design decisions' },
    { question: 'You need to build a dashboard that renders thousands of rows of data. Walk me through your approach.', experience: '0-2', targetCompetency: 'performance_design', followUpTheme: 'virtualization strategies' },
    { question: 'Plan a migration from a legacy jQuery app to React for a team of five engineers.', experience: '3-6', targetCompetency: 'migration_planning', followUpTheme: 'phasing and risk' },
    { question: 'Design an offline-first progressive web app for a field service team with spotty connectivity.', experience: '3-6', targetCompetency: 'system_design', followUpTheme: 'sync conflict resolution' },
    { question: 'Architect a micro-frontend system for a platform with 10 independent product teams.', experience: '7+', targetCompetency: 'platform_architecture', followUpTheme: 'governance and DX' },
    { question: 'Design the frontend infrastructure for a company transitioning from monolith to federated architecture.', experience: '7+', targetCompetency: 'strategic_architecture', followUpTheme: 'team structure impact' },
    { question: 'A key page has a 4-second load time. How would you diagnose and fix it?', experience: 'all', targetCompetency: 'performance_debugging', followUpTheme: 'measurement methodology' },
  ],
}
