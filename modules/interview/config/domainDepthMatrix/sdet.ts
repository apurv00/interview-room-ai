import type { DomainDepthOverride } from './types'

export const sdetOverrides: Record<string, DomainDepthOverride> = {
  'sdet:screening': {
    questionStrategy: 'Probe motivation for quality engineering, their philosophy on testing, culture fit for teams that value reliability. Ask about their approach to balancing speed and quality, what excites them about test automation, and how they view the QA role evolving.',
    interviewerTone: 'Warm and curious about their quality mindset. Show respect for the craft of testing.',
    scoringEmphasis: 'Evaluate passion for quality, communication about testing philosophy, culture fit, and understanding of how QA integrates with development teams.',
    sampleOpeners: [
      'What excites you most about quality engineering?',
      'How do you see the role of QA evolving in modern software teams?',
    ],
  },
  'sdet:behavioral': {
    questionStrategy: 'Explore scenarios around advocating for quality when teams push to ship, handling flaky test suites, managing test infrastructure at scale, navigating disagreements about what to automate, and leading quality culture change.',
    interviewerTone: 'Empathetic and interested in the challenges unique to QA — being the voice of quality when speed is prioritized.',
    scoringEmphasis: 'Evaluate ability to influence without authority, resilience when quality is deprioritized, self-awareness about testing tradeoffs, and leadership in quality culture.',
    sampleOpeners: [
      'Tell me about a time you had to push back on shipping a feature you believed was not ready.',
      'Describe a situation where your test automation strategy needed a major overhaul.',
    ],
  },
  'sdet:technical': {
    questionStrategy: 'Deep-dive into test automation frameworks (Selenium, Playwright, Cypress), test architecture (page object model, screenplay pattern), CI/CD testing integration, performance/load testing (k6, JMeter), API testing strategies, mobile testing, and test data management.',
    interviewerTone: 'Technical peer who appreciates test engineering as a craft. Discuss automation architecture, not just tool usage.',
    technicalTranslation: 'Technical means: test automation architecture, framework design, CI/CD integration, performance testing methodology, test data management, and quality metrics.',
    scoringEmphasis: 'Evaluate test architecture design skills, understanding of testing pyramid, ability to reason about test coverage vs. maintenance cost, and practical experience with automation at scale.',
    sampleOpeners: [
      'How would you design a test automation framework for a product with both web and mobile interfaces?',
      'Walk me through your approach to testing a distributed microservices system end-to-end.',
    ],
  },
  'sdet:case-study': {
    questionStrategy: 'Present quality engineering scenarios: design a test strategy for a greenfield microservices platform, plan regression testing for a major migration, architect a performance testing pipeline, or design a quality gate system for CI/CD.',
    interviewerTone: 'Quality architect who presents realistic constraints around team size, timelines, and legacy systems.',
    technicalTranslation: 'Case study means: test strategy design, quality process architecture, and risk-based testing scenarios.',
    scoringEmphasis: 'Evaluate structured approach to test strategy, ability to prioritize testing efforts based on risk, consideration of maintenance costs, and quality metrics thinking.',
    sampleOpeners: [
      'You are joining a team building a new payment platform. Design the test strategy from scratch.',
      'The release cycle is moving from monthly to daily. How would you redesign the quality process?',
    ],
  },
}
