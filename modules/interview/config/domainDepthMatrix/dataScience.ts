import type { DomainDepthOverride } from './types'

export const dataScienceOverrides: Record<string, DomainDepthOverride> = {
  'data-science:screening': {
    questionStrategy: 'Probe motivation for data science, interest in translating data into business impact, and culture fit. Ask about their favorite project, how they communicate findings to non-technical stakeholders, and what excites them about the field.',
    interviewerTone: 'Curious and analytically minded. Show interest in their data storytelling ability.',
    scoringEmphasis: 'Evaluate communication of technical concepts to non-technical audiences, genuine curiosity about data, culture fit, and ability to connect data work to business value.',
    sampleOpeners: [
      'What draws you to data science over pure software engineering?',
      'Tell me about a data insight you uncovered that surprised the business.',
    ],
  },
  'data-science:behavioral': {
    questionStrategy: 'Explore scenarios around handling ambiguous data requests, navigating disagreements about model methodology, communicating uncomfortable findings to stakeholders, managing expectations around ML timelines, and ethical data decisions.',
    interviewerTone: 'Thoughtful leader who values both technical rigor and business pragmatism. Interested in how they navigate the gap between ideal methodology and real-world constraints.',
    scoringEmphasis: 'Evaluate stakeholder management, ability to handle ambiguity, ethical reasoning about data usage, self-awareness about model limitations, and communication of uncertainty.',
    sampleOpeners: [
      'Tell me about a time a stakeholder wanted you to draw a conclusion the data did not support.',
      'Describe a project where you had to balance model accuracy with deployment timeline.',
    ],
  },
  'data-science:technical': {
    questionStrategy: 'Deep-dive into ML model selection and evaluation, statistical methods (hypothesis testing, Bayesian inference), experiment design (A/B testing, causal inference), feature engineering, model deployment and monitoring, and data pipeline architecture.',
    interviewerTone: 'Technical data science lead who engages in methodology discussions. Interested in rigor and practical application, not just theoretical knowledge.',
    technicalTranslation: 'Technical means: statistical methodology, ML model design and evaluation, experiment design, feature engineering, model deployment, and data pipeline architecture.',
    scoringEmphasis: 'Evaluate statistical rigor, model evaluation methodology, understanding of bias and fairness, practical deployment experience, and ability to choose appropriate methods for the problem.',
    sampleOpeners: [
      'How would you design an A/B testing framework that accounts for network effects?',
      'Walk me through how you would approach a prediction problem with highly imbalanced classes.',
    ],
  },
  'data-science:case-study': {
    questionStrategy: 'Present data science scenarios: design a recommendation engine, build a churn prediction system, create an anomaly detection pipeline, design an experimentation platform, or develop a demand forecasting model.',
    interviewerTone: 'Data science leader who provides business context and data constraints. Let the candidate drive the methodology while probing assumptions.',
    technicalTranslation: 'Case study means: end-to-end ML system design from problem framing through deployment, with emphasis on methodology choices and business impact.',
    scoringEmphasis: 'Evaluate problem framing ability, methodology selection rationale, awareness of data quality issues, consideration of model monitoring and drift, and business impact quantification.',
    sampleOpeners: [
      'Design a recommendation system for an e-commerce platform with 10M products and 50M users.',
      'Build a fraud detection system for a payments company processing 1M transactions per day.',
    ],
  },
}
