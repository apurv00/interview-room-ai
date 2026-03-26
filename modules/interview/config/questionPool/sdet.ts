import type { PoolQuestion } from './types'

export const sdetQuestions: Record<string, PoolQuestion[]> = {
  'sdet:screening': [
    { question: 'What excites you about quality engineering as a career?', experience: '0-2', targetCompetency: 'motivation', followUpTheme: 'career vision' },
    { question: 'How do you think about the difference between testing and quality?', experience: '0-2', targetCompetency: 'quality_mindset', followUpTheme: 'practical examples' },
    { question: 'How has your view of the QA role evolved over your career?', experience: '3-6', targetCompetency: 'professional_growth', followUpTheme: 'industry trends' },
    { question: 'What is your philosophy on balancing test coverage with delivery speed?', experience: '3-6', targetCompetency: 'strategic_thinking', followUpTheme: 'real tradeoffs made' },
    { question: 'How do you see quality engineering evolving in the age of AI and continuous delivery?', experience: '7+', targetCompetency: 'vision', followUpTheme: 'team implications' },
    { question: 'What does a world-class quality engineering culture look like?', experience: '7+', targetCompetency: 'leadership', followUpTheme: 'building that culture' },
    { question: 'Tell me about a bug you caught that you are especially proud of finding.', experience: 'all', targetCompetency: 'attention_to_detail', followUpTheme: 'detection methodology' },
  ],
  'sdet:behavioral': [
    { question: 'Tell me about a time you pushed back on shipping a feature that was not ready.', experience: '0-2', targetCompetency: 'advocacy', followUpTheme: 'influence without authority' },
    { question: 'Describe a situation where you found a critical bug right before release.', experience: '0-2', targetCompetency: 'pressure_handling', followUpTheme: 'communication approach' },
    { question: 'Tell me about a time your test automation strategy needed a major overhaul. What prompted it?', experience: '3-6', targetCompetency: 'strategic_adaptation', followUpTheme: 'migration approach' },
    { question: 'Describe how you handled a persistently flaky test suite that was blocking deployments.', experience: '3-6', targetCompetency: 'problem_solving', followUpTheme: 'systemic fix vs patches' },
    { question: 'Tell me about a time you drove a quality culture transformation in an organization.', experience: '7+', targetCompetency: 'organizational_leadership', followUpTheme: 'resistance management' },
    { question: 'How did you convince engineering leadership to invest in test infrastructure over features?', experience: '7+', targetCompetency: 'executive_influence', followUpTheme: 'ROI argument' },
    { question: 'Describe a disagreement about what to automate versus test manually. How did you resolve it?', experience: 'all', targetCompetency: 'decision_making', followUpTheme: 'framework for deciding' },
  ],
  'sdet:technical': [
    { question: 'How would you set up a basic test automation framework for a new web application?', experience: '0-2', targetCompetency: 'automation_fundamentals', followUpTheme: 'tool selection rationale' },
    { question: 'Explain the testing pyramid. How does it guide your automation strategy?', experience: '0-2', targetCompetency: 'testing_concepts', followUpTheme: 'practical application' },
    { question: 'How would you design the test architecture for a product with both web and mobile apps?', experience: '3-6', targetCompetency: 'test_architecture', followUpTheme: 'code sharing across platforms' },
    { question: 'Walk me through your approach to performance testing a high-traffic API.', experience: '3-6', targetCompetency: 'performance_testing', followUpTheme: 'metrics and thresholds' },
    { question: 'How would you design a test platform that serves 20 engineering teams with different tech stacks?', experience: '7+', targetCompetency: 'platform_design', followUpTheme: 'adoption strategy' },
    { question: 'What is your approach to measuring and reporting quality metrics to engineering leadership?', experience: '7+', targetCompetency: 'quality_metrics', followUpTheme: 'actionable insights' },
    { question: 'How do you handle test data management in a complex microservices environment?', experience: 'all', targetCompetency: 'test_data', followUpTheme: 'isolation and cleanup' },
  ],
  'sdet:case-study': [
    { question: 'Design a test strategy for a new e-commerce checkout flow from scratch.', experience: '0-2', targetCompetency: 'test_planning', followUpTheme: 'risk-based prioritization' },
    { question: 'You are joining a team with zero test automation. Design a 3-month plan to build coverage.', experience: '0-2', targetCompetency: 'strategy_design', followUpTheme: 'quick wins vs long-term' },
    { question: 'Design a quality gate system for a CI/CD pipeline deploying 50 times per day.', experience: '3-6', targetCompetency: 'cicd_quality', followUpTheme: 'speed vs safety balance' },
    { question: 'Plan regression testing for a major database migration affecting all product areas.', experience: '3-6', targetCompetency: 'risk_assessment', followUpTheme: 'rollback strategy' },
    { question: 'Design a company-wide test infrastructure platform that supports web, mobile, and API testing.', experience: '7+', targetCompetency: 'platform_architecture', followUpTheme: 'self-service model' },
    { question: 'The release cycle is moving from monthly to daily. Redesign the quality process.', experience: '7+', targetCompetency: 'process_transformation', followUpTheme: 'cultural change' },
    { question: 'A critical production bug slipped through all test layers. Design a post-mortem and fix plan.', experience: 'all', targetCompetency: 'root_cause_analysis', followUpTheme: 'systemic prevention' },
  ],
}
