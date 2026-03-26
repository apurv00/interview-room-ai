import type { DomainDepthOverride } from './types'

export const dataScienceOverrides: Record<string, DomainDepthOverride> = {
  'data-science:screening': {
    questionStrategy: 'Probe motivation for data science, interest in translating data into business impact, and culture fit. Ask about their favorite project, how they communicate findings to non-technical stakeholders, and what excites them about the field.',
    interviewerTone: 'Curious and analytically minded. Show interest in their data storytelling ability.',
    scoringEmphasis: 'Evaluate communication of technical concepts to non-technical audiences, genuine curiosity about data, culture fit, and ability to connect data work to business value.',
    antiPatterns: 'Do NOT ask about specific ML algorithms, statistical tests, or coding challenges. Screening is about data curiosity, communication skills, and culture fit.',
    experienceCalibration: {
      '0-2': 'Expect academic or bootcamp background with Kaggle projects or coursework. Look for genuine curiosity about data, basic understanding of the ML lifecycle, and communication skills.',
      '3-6': 'Expect clear examples of business impact from data work, ability to explain technical methods to non-technical audiences, and a point of view on the data science role.',
      '7+': 'Expect strategic thinking about data science as a function: team building, stakeholder management, connecting analytics to company strategy, and thought leadership.',
    },
    domainRedFlags: [
      'Cannot explain any data project in terms of business impact',
      'Only speaks in jargon with no ability to simplify for non-technical audiences',
      'No curiosity about the data itself — treats it purely as inputs to algorithms',
    ],
  },
  'data-science:behavioral': {
    questionStrategy: 'Explore scenarios around handling ambiguous data requests, navigating disagreements about model methodology, communicating uncomfortable findings to stakeholders, managing expectations around ML timelines, and ethical data decisions.',
    interviewerTone: 'Thoughtful leader who values both technical rigor and business pragmatism. Interested in how they navigate the gap between ideal methodology and real-world constraints.',
    scoringEmphasis: 'Evaluate stakeholder management, ability to handle ambiguity, ethical reasoning about data usage, self-awareness about model limitations, and communication of uncertainty.',
    antiPatterns: 'Do NOT ask to derive formulas or explain algorithm internals. Behavioral for data science focuses on stakeholder communication, ethical reasoning, and navigating ambiguity.',
    experienceCalibration: {
      '0-2': 'Expect early stories about presenting findings to managers, dealing with messy data, and learning to scope data questions when requirements are ambiguous.',
      '3-6': 'Expect nuanced stakeholder stories: pushing back on misleading metrics, handling conflicting data requests from multiple teams, and communicating model uncertainty to executives.',
      '7+': 'Expect leadership narratives: building data-driven culture, establishing ethical data practices, managing data science teams, and navigating organizational politics around data insights.',
    },
    domainRedFlags: [
      'Cannot provide examples of communicating data findings to non-technical stakeholders',
      'Shows no awareness of ethical considerations in data collection or model usage',
      'Avoids discussing situations where data was ambiguous or inconclusive',
    ],
  },
  'data-science:technical': {
    questionStrategy: 'Deep-dive into ML model selection and evaluation, statistical methods (hypothesis testing, Bayesian inference), experiment design (A/B testing, causal inference), feature engineering, model deployment and monitoring, and data pipeline architecture.',
    interviewerTone: 'Technical data science lead who engages in methodology discussions. Interested in rigor and practical application, not just theoretical knowledge.',
    technicalTranslation: 'Technical means: statistical methodology, ML model design and evaluation, experiment design, feature engineering, model deployment, and data pipeline architecture.',
    scoringEmphasis: 'Evaluate statistical rigor, model evaluation methodology, understanding of bias and fairness, practical deployment experience, and ability to choose appropriate methods for the problem.',
    antiPatterns: 'Do NOT ask software engineering system design or frontend/backend architecture questions. Technical for data science means statistical methods, ML methodology, experiment design, and model deployment.',
    experienceCalibration: {
      '0-2': 'Expect textbook knowledge of ML algorithms, basic statistics (hypothesis testing, distributions), and ability to use scikit-learn or similar frameworks. Probe for understanding beyond rote application.',
      '3-6': 'Expect production ML experience: feature engineering, model evaluation beyond accuracy, A/B testing rigor, handling data drift, and deploying models to production pipelines.',
      '7+': 'Expect methodology leadership: designing experimentation platforms, establishing model governance, causal inference expertise, and mentoring on statistical rigor across teams.',
    },
    domainRedFlags: [
      'Cannot explain when to use different model evaluation metrics beyond accuracy',
      'No understanding of overfitting or data leakage risks',
      'Treats all problems as supervised learning without considering problem framing',
      'Cannot discuss model fairness or bias detection',
    ],
  },
  'data-science:case-study': {
    questionStrategy: 'Present data science scenarios: design a recommendation engine, build a churn prediction system, create an anomaly detection pipeline, design an experimentation platform, or develop a demand forecasting model.',
    interviewerTone: 'Data science leader who provides business context and data constraints. Let the candidate drive the methodology while probing assumptions.',
    technicalTranslation: 'Case study means: end-to-end ML system design from problem framing through deployment, with emphasis on methodology choices and business impact.',
    scoringEmphasis: 'Evaluate problem framing ability, methodology selection rationale, awareness of data quality issues, consideration of model monitoring and drift, and business impact quantification.',
    antiPatterns: 'Do NOT present pure software infrastructure problems. Case studies for data science should center on problem framing, methodology selection, data quality, and model lifecycle — not distributed systems architecture.',
    experienceCalibration: {
      '0-2': 'Expect basic problem framing: defining the target variable, choosing a simple model, and outlining an evaluation plan. Guide through data quality and deployment considerations.',
      '3-6': 'Expect end-to-end ML thinking: data collection strategy, feature engineering, model selection rationale, offline/online evaluation, and monitoring for drift.',
      '7+': 'Expect ML system design: experimentation platform architecture, model governance, A/B testing infrastructure, feedback loops, and quantified business impact estimation.',
    },
    domainRedFlags: [
      'Jumps to model selection without framing the problem or understanding the data',
      'No mention of data quality, missing values, or sampling bias',
      'Cannot articulate how they would measure success or monitor model performance in production',
    ],
  },
}
