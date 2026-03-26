import type { DomainDepthOverride } from './types'

export const sdetOverrides: Record<string, DomainDepthOverride> = {
  'sdet:screening': {
    questionStrategy: 'Probe motivation for quality engineering, their philosophy on testing, culture fit for teams that value reliability. Ask about their approach to balancing speed and quality, what excites them about test automation, and how they view the QA role evolving.',
    interviewerTone: 'Warm and curious about their quality mindset. Show respect for the craft of testing.',
    scoringEmphasis: 'Evaluate passion for quality, communication about testing philosophy, culture fit, and understanding of how QA integrates with development teams.',
    antiPatterns: 'Do NOT ask about specific automation frameworks or test architecture. Screening is about quality mindset, motivation, and culture fit — not tooling proficiency.',
    experienceCalibration: {
      '0-2': 'Expect curiosity about quality and basic understanding of why testing matters. Look for analytical thinking and attention to detail in how they describe past work.',
      '3-6': 'Expect a clear quality philosophy, understanding of how QA fits into agile teams, and examples of advocating for quality in real projects.',
      '7+': 'Expect a strategic view of quality engineering: how testing culture scales, where QA is headed as a discipline, and how to build quality into the development process.',
    },
    domainRedFlags: [
      'Views QA as purely manual click-testing with no interest in automation',
      'Cannot articulate how quality engineering adds value beyond finding bugs',
      'Shows no understanding of how QA integrates with development workflows',
    ],
  },
  'sdet:behavioral': {
    questionStrategy: 'Explore scenarios around advocating for quality when teams push to ship, handling flaky test suites, managing test infrastructure at scale, navigating disagreements about what to automate, and leading quality culture change.',
    interviewerTone: 'Empathetic and interested in the challenges unique to QA — being the voice of quality when speed is prioritized.',
    scoringEmphasis: 'Evaluate ability to influence without authority, resilience when quality is deprioritized, self-awareness about testing tradeoffs, and leadership in quality culture.',
    antiPatterns: 'Do NOT ask technical questions about test framework internals or coding patterns. Behavioral for SDET focuses on advocacy, influence, and navigating quality-vs-speed tensions.',
    experienceCalibration: {
      '0-2': 'Expect early stories about finding important bugs, learning to speak up about quality concerns, and initial experiences balancing thoroughness with deadlines.',
      '3-6': 'Expect stories about influencing teams to invest in test infrastructure, handling flaky test suites, and navigating disagreements about what to automate vs. test manually.',
      '7+': 'Expect leadership narratives: driving org-wide quality culture, building QA teams, establishing testing standards across multiple product lines, and measuring quality impact.',
    },
    domainRedFlags: [
      'Cannot provide examples of advocating for quality when under deadline pressure',
      'Describes QA as a gatekeeping role rather than a collaborative one',
      'No evidence of adapting testing strategy based on project context or risk',
    ],
  },
  'sdet:technical': {
    questionStrategy: 'Deep-dive into test automation frameworks (Selenium, Playwright, Cypress), test architecture (page object model, screenplay pattern), CI/CD testing integration, performance/load testing (k6, JMeter), API testing strategies, mobile testing, and test data management.',
    interviewerTone: 'Technical peer who appreciates test engineering as a craft. Discuss automation architecture, not just tool usage.',
    technicalTranslation: 'Technical means: test automation architecture, framework design, CI/CD integration, performance testing methodology, test data management, and quality metrics.',
    scoringEmphasis: 'Evaluate test architecture design skills, understanding of testing pyramid, ability to reason about test coverage vs. maintenance cost, and practical experience with automation at scale.',
    antiPatterns: 'Do NOT ask product design or business strategy questions. Technical for SDET means test architecture, automation frameworks, CI/CD integration, performance testing, and quality metrics.',
    experienceCalibration: {
      '0-2': 'Expect familiarity with at least one automation tool (Selenium, Cypress, Playwright), basic understanding of the testing pyramid, and ability to write maintainable test cases.',
      '3-6': 'Expect framework design experience: page object patterns, test data management, CI/CD integration, API testing, and strategies for reducing flakiness at scale.',
      '7+': 'Expect architectural ownership: designing test platforms, establishing automation standards across teams, performance/load testing pipelines, and quality engineering metrics.',
    },
    domainRedFlags: [
      'Cannot explain the testing pyramid or why different test levels exist',
      'Only knows one testing tool with no understanding of underlying principles',
      'No strategy for managing test data or test environment complexity',
      'Cannot discuss test maintenance costs or flakiness mitigation',
    ],
  },
  'sdet:case-study': {
    questionStrategy: 'Present quality engineering scenarios: design a test strategy for a greenfield microservices platform, plan regression testing for a major migration, architect a performance testing pipeline, or design a quality gate system for CI/CD.',
    interviewerTone: 'Quality architect who presents realistic constraints around team size, timelines, and legacy systems.',
    technicalTranslation: 'Case study means: test strategy design, quality process architecture, and risk-based testing scenarios.',
    scoringEmphasis: 'Evaluate structured approach to test strategy, ability to prioritize testing efforts based on risk, consideration of maintenance costs, and quality metrics thinking.',
    antiPatterns: 'Do NOT present generic software architecture problems. Case studies for SDET should center on test strategy design, quality process architecture, and risk-based testing decisions.',
    experienceCalibration: {
      '0-2': 'Expect basic test planning: identifying what to test, choosing test levels, and writing a simple test plan. Guide through constraints and look for risk-awareness.',
      '3-6': 'Expect comprehensive test strategy: risk-based prioritization, automation ROI analysis, environment management, and integration with CI/CD pipelines.',
      '7+': 'Expect quality architecture thinking: org-wide test infrastructure design, quality gates for deployment pipelines, shift-left strategies, and metrics-driven quality improvement.',
    },
    domainRedFlags: [
      'Proposes testing everything without risk-based prioritization',
      'No consideration of test maintenance burden or long-term sustainability',
      'Cannot connect testing strategy to business risk or deployment confidence',
    ],
  },
}
