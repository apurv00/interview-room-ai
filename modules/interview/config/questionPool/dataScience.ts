import type { PoolQuestion } from './types'

export const dataScienceQuestions: Record<string, PoolQuestion[]> = {
  'data-science:screening': [
    { question: 'What drew you to data science over software engineering?', experience: '0-2', targetCompetency: 'motivation', followUpTheme: 'favorite project' },
    { question: 'Tell me about a data insight you uncovered that surprised the business.', experience: '0-2', targetCompetency: 'business_impact', followUpTheme: 'how you communicated it' },
    { question: 'How do you explain complex model results to non-technical stakeholders?', experience: '3-6', targetCompetency: 'communication', followUpTheme: 'specific example' },
    { question: 'What is your approach when a stakeholder asks for an analysis but the question is poorly defined?', experience: '3-6', targetCompetency: 'problem_framing', followUpTheme: 'scoping process' },
    { question: 'How do you think about building a data science team and culture?', experience: '7+', targetCompetency: 'leadership', followUpTheme: 'hiring and mentoring' },
    { question: 'What is the biggest gap between academic data science and production data science?', experience: '7+', targetCompetency: 'practical_wisdom', followUpTheme: 'bridging the gap' },
    { question: 'What kind of data problems are you most passionate about solving?', experience: 'all', targetCompetency: 'passion', followUpTheme: 'real-world examples' },
  ],
  'data-science:behavioral': [
    { question: 'Tell me about a time you had to deliver findings that contradicted what stakeholders expected.', experience: '0-2', targetCompetency: 'integrity', followUpTheme: 'how they reacted' },
    { question: 'Describe a project where the data was messy and how you handled it.', experience: '0-2', targetCompetency: 'data_pragmatism', followUpTheme: 'quality tradeoffs' },
    { question: 'Tell me about a time you had to push back on a misleading metric that leadership wanted to use.', experience: '3-6', targetCompetency: 'ethical_reasoning', followUpTheme: 'alternative proposed' },
    { question: 'Describe a situation where you had to balance model accuracy with deployment timeline.', experience: '3-6', targetCompetency: 'pragmatism', followUpTheme: 'decision framework' },
    { question: 'Tell me about a time you established ethical data practices in an organization.', experience: '7+', targetCompetency: 'ethical_leadership', followUpTheme: 'policy creation' },
    { question: 'How did you handle a situation where different teams wanted conflicting analyses from the same data?', experience: '7+', targetCompetency: 'stakeholder_management', followUpTheme: 'alignment approach' },
    { question: 'Describe a time your model did not perform as expected in production. What happened?', experience: 'all', targetCompetency: 'learning_from_failure', followUpTheme: 'root cause and fix' },
  ],
  'data-science:technical': [
    { question: 'How would you design an A/B test to measure the impact of a new recommendation algorithm?', experience: '0-2', targetCompetency: 'experiment_design', followUpTheme: 'sample size and duration' },
    { question: 'When would you use a random forest versus logistic regression? Walk me through your reasoning.', experience: '0-2', targetCompetency: 'model_selection', followUpTheme: 'evaluation metrics' },
    { question: 'How do you handle class imbalance in a fraud detection problem?', experience: '3-6', targetCompetency: 'ml_methodology', followUpTheme: 'production considerations' },
    { question: 'Walk me through how you would set up an A/B testing framework that accounts for network effects.', experience: '3-6', targetCompetency: 'advanced_experimentation', followUpTheme: 'causal inference' },
    { question: 'How would you design a model monitoring system that detects data drift and performance degradation?', experience: '7+', targetCompetency: 'mlops', followUpTheme: 'automated response' },
    { question: 'What is your approach to establishing model governance and fairness standards across teams?', experience: '7+', targetCompetency: 'ml_governance', followUpTheme: 'practical implementation' },
    { question: 'How do you decide which features to engineer for a prediction problem?', experience: 'all', targetCompetency: 'feature_engineering', followUpTheme: 'feature selection methods' },
  ],
  'data-science:case-study': [
    { question: 'Build a churn prediction system for a subscription product. Where do you start?', experience: '0-2', targetCompetency: 'problem_framing', followUpTheme: 'target definition and features' },
    { question: 'Design a recommendation engine for a content platform with 1M users.', experience: '0-2', targetCompetency: 'system_design', followUpTheme: 'cold start problem' },
    { question: 'Design an anomaly detection pipeline for a payments company processing 1M transactions daily.', experience: '3-6', targetCompetency: 'ml_system_design', followUpTheme: 'precision-recall tradeoff' },
    { question: 'Build a demand forecasting model for a grocery delivery service with seasonal patterns.', experience: '3-6', targetCompetency: 'time_series', followUpTheme: 'handling external events' },
    { question: 'Design an experimentation platform that supports 100 concurrent A/B tests across 10 product teams.', experience: '7+', targetCompetency: 'platform_design', followUpTheme: 'interference handling' },
    { question: 'Design an end-to-end ML system for real-time content moderation at scale.', experience: '7+', targetCompetency: 'ml_architecture', followUpTheme: 'human-in-the-loop' },
    { question: 'Your model is performing well offline but poorly in production. Walk me through your investigation.', experience: 'all', targetCompetency: 'ml_debugging', followUpTheme: 'distribution shift' },
  ],
}
