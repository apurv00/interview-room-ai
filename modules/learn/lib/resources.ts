// ─── Resource Hub Data ──────────────────────────────────────────────────────
// Single source of truth for all self-serve learning content.
// Used by: resource pages (SSR/SEO), homepage personalization, footer links, sitemap.

export interface ResourceFAQ {
  q: string
  a: string
}

export interface ResourceLink {
  /** Display text for the inline link. */
  text: string
  /** Internal path. Use absolute paths beginning with `/`. */
  href: string
}

export interface ResourceSection {
  heading: string
  body: string
  /**
   * Optional related-content links rendered at the bottom of the section.
   * Used to wire topic-cluster cross-links between hero guides for SEO.
   */
  links?: ResourceLink[]
}

export interface Resource {
  slug: string
  title: string
  description: string
  category: 'questions' | 'tips' | 'frameworks' | 'companies'
  keywords: string[]
  relevantDomains: string[]       // empty = all
  relevantExperience: string[]    // empty = all
  relevantWeakAreas: string[]
  relevantGoals: string[]
  isCareerSwitcher?: boolean      // true = boost for career switchers
  content: {
    intro: string
    sections: ResourceSection[]
    tips: string[]
    faq: ResourceFAQ[]
  }
}

export const RESOURCES: Resource[] = [
  // ──────────────── INTERVIEW QUESTIONS ────────────────
  {
    slug: 'common-interview-questions',
    title: 'Common Interview Questions & Answers',
    description: 'Master the most frequently asked interview questions with expert-crafted sample answers and strategies for every career level.',
    category: 'questions',
    keywords: ['common interview questions', 'interview questions and answers', 'job interview questions', 'most asked interview questions'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: [],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'Whether you\'re preparing for your first interview or your fiftieth, certain questions come up again and again. Mastering these common questions gives you a solid foundation for any interview scenario.',
      sections: [
        {
          heading: 'Tell Me About Yourself',
          body: 'This is often the opening question and sets the tone for the entire interview. Structure your answer as a brief professional narrative: start with your current role, highlight 2-3 key achievements, and connect to why you\'re excited about this opportunity. Keep it under 2 minutes. Avoid personal details unless they\'re directly relevant to the role.'
        },
        {
          heading: 'Why Do You Want This Role?',
          body: 'Interviewers want to see genuine motivation and research. Reference specific aspects of the company, team, or product that excite you. Connect your skills and career trajectory to the role\'s requirements. Avoid generic answers like "it\'s a great company" — be specific about what makes this opportunity uniquely appealing to you.'
        },
        {
          heading: 'What Are Your Strengths and Weaknesses?',
          body: 'For strengths, pick 2-3 that directly relate to the job requirements and back each with a specific example. For weaknesses, choose a genuine area of growth (not a disguised strength) and explain what concrete steps you\'re taking to improve. Show self-awareness without undermining your candidacy.'
        },
        {
          heading: 'Where Do You See Yourself in 5 Years?',
          body: 'This question tests ambition and alignment. Show that your career goals align with the company\'s growth trajectory. Focus on skills you want to develop, impact you want to make, and how this role is a stepping stone. Avoid overly specific titles — focus on the type of work and responsibility level you aspire to.'
        },
        {
          heading: 'Why Are You Leaving Your Current Job?',
          body: 'Always frame your answer positively — focus on what you\'re moving toward, not what you\'re running from. Mention growth opportunities, new challenges, or alignment with your long-term goals. Never badmouth a previous employer, even if the experience was negative.'
        },
      ],
      tips: [
        'Research the company thoroughly before your interview — know their mission, recent news, and competitors.',
        'Prepare 3-5 specific examples from your experience that demonstrate key competencies.',
        'Practice your answers out loud, but don\'t memorize scripts — aim for natural delivery.',
        'Prepare thoughtful questions to ask the interviewer about the role, team, and company culture.',
        'Follow up with a thank-you email within 24 hours of your interview.',
      ],
      faq: [
        { q: 'How many interview questions should I prepare for?', a: 'Prepare thorough answers for 10-15 common questions and 5-10 role-specific ones. Having a bank of 8-10 detailed stories from your experience that you can adapt to different questions is more effective than memorizing individual answers.' },
        { q: 'How long should my answers be?', a: 'Most answers should be 1-3 minutes. For behavioral questions using the STAR method, aim for 2-3 minutes. For simple factual questions, 30-60 seconds is sufficient. Watch the interviewer\'s body language for cues.' },
        { q: 'What if I don\'t know the answer to a question?', a: 'It\'s okay to pause and think. Say "That\'s a great question, let me think about that for a moment." If you truly don\'t know, be honest and explain how you would approach finding the answer. Never make up an answer.' },
        { q: 'Should I ask about salary in the first interview?', a: 'Generally, let the employer bring up compensation first. If they ask your expectations early, provide a researched range based on market data. Save detailed negotiation for after you receive an offer.' },
      ],
    },
  },
  {
    slug: 'behavioral-questions',
    title: 'Behavioral Interview Questions: The Complete Guide (2026)',
    description: 'A complete guide to answering behavioral interview questions using the STAR method. Covers leadership, teamwork, conflict, failure, and ambiguity, with prep templates, real example answers, and the 12 most common questions you should prepare for.',
    category: 'questions',
    keywords: ['behavioral interview questions', 'STAR method examples', 'tell me about a time', 'situational interview questions', 'competency-based questions', 'behavioral interview prep', 'most common behavioral questions'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['star_structure', 'storytelling', 'specificity'],
    relevantGoals: ['improve_scores', 'general_practice'],
    content: {
      intro: 'Behavioral interview questions are the backbone of almost every modern interview process. Recruiters use them because past behavior is the single best predictor of future performance — far more reliable than hypothetical "what would you do" questions. This guide walks you through exactly what behavioral questions are, why companies use them, the STAR framework that scores best with hiring committees, and detailed example answers for the 12 most common question themes.',
      sections: [
        {
          heading: 'What Are Behavioral Interview Questions, and Why Companies Ask Them',
          body: 'Behavioral interview questions ask you to describe specific past experiences in concrete detail. They almost always begin with phrases like "Tell me about a time when…", "Describe a situation where…", or "Give me an example of…". The hiring philosophy behind them is simple: how you handled a tough situation in the past is the best signal for how you will handle a similar situation on the job.\n\nThis style of interviewing originated at consulting firms in the 1970s and was popularized by companies like Google, Amazon, and McKinsey. Today nearly every well-run hiring process — from startups to Fortune 500s — uses behavioral questions to evaluate competencies that are hard to assess any other way: leadership, judgment, ownership, collaboration, conflict resolution, and resilience under pressure. Interviewers are typically scoring you on a structured rubric and need specific evidence (not opinions) to mark each competency.\n\nThe practical implication: vague or generic answers get marked down. You need *real* stories, told with *real* details, and ideally with *real numbers*. The rest of this guide shows you how.',
          links: [
            { text: 'STAR Method Guide', href: '/learn/guides/star-method-guide' },
            { text: 'Common Interview Questions', href: '/learn/guides/common-interview-questions' },
          ],
        },
        {
          heading: 'The STAR Method: Why It Wins, and How to Use It',
          body: 'STAR stands for Situation, Task, Action, Result. It is the single most effective framework for behavioral answers because it forces you to cover every dimension a hiring committee is scoring against, in the right proportion.\n\n• **Situation (10–15 seconds):** Set the scene briefly. Where were you, who was on the team, what was at stake? Don\'t over-explain — interviewers are not grading your storytelling, they are grading your decisions.\n\n• **Task (10–15 seconds):** Make your *individual* responsibility crystal clear. This is where interviewers separate the doers from the bystanders. "As tech lead, I owned the migration design and the on-call rotation" is much stronger than "we needed to migrate the system."\n\n• **Action (60–90 seconds — the longest part):** This is where 60% of your time should go. Use "I" not "we". Walk through the specific steps you took, the trade-offs you considered, and the obstacles you handled. Interviewers cannot give you credit for actions they cannot hear, so be explicit even if it feels obvious.\n\n• **Result (15–30 seconds):** Quantify the outcome. "Reduced churn by 12 percent" is dramatically more credible than "improved retention." If your result was negative, name it honestly and explain what you learned — failure stories with reflection often score *higher* than success stories without reflection.\n\nUsed correctly, a STAR answer lands in 2 to 3 minutes. Anything longer and you are losing the room.',
          links: [
            { text: 'STAR Method Guide', href: '/learn/guides/star-method-guide' },
            { text: 'Interview Frameworks', href: '/learn/guides/interview-frameworks' },
          ],
        },
        {
          heading: 'Leadership and Influence Questions',
          body: '"Tell me about a time you led a team through a difficult project." "Describe a time you had to influence someone without authority." "Give me an example of when you had to make an unpopular decision."\n\nThese questions are testing whether you can drive outcomes through other people. Strong answers explicitly cover three things: (1) how you set direction and built alignment, (2) how you handled the people side — coaching, removing blockers, managing conflict — and (3) what happened to the *team* afterward, not just to the project.\n\nA common mistake is treating leadership as a synonym for being the loudest person in the room. Senior interviewers actively probe for *humble* leadership: how did you bring quieter team members in, how did you change your mind when proven wrong, how did you give credit. If you only have one or two leadership stories, focus on these qualities — they distinguish you from candidates who can only tell heroic-rescue stories.\n\nMetrics that help: team size, project duration, retention or engagement results, on-time delivery, and any after-the-fact feedback you received from teammates or stakeholders.',
        },
        {
          heading: 'Conflict and Disagreement Questions',
          body: '"Describe a time you had a disagreement with a colleague." "Tell me about a time you had to push back on your manager." "Give me an example of working with a difficult stakeholder."\n\nConflict questions test emotional intelligence, intellectual honesty, and your ability to disagree productively. The trap to avoid: making the other person sound unreasonable. Interviewers immediately mark down candidates whose conflict stories cast everyone else as the villain. Instead, present the disagreement *factually* — show that you genuinely understood the other side, even if you ultimately did not agree with it.\n\nThe most effective structure for conflict answers is: (1) the disagreement and what was at stake, (2) what you did to truly understand the other view (asked questions, gathered data, talked to a third party), (3) the specific path you took to resolution (proposed a test, escalated to a decision-maker, negotiated a hybrid), and (4) what you learned about working with that person going forward. Bonus points if your relationship with the colleague *improved* afterward — that signals real maturity.',
        },
        {
          heading: 'Failure, Mistakes, and Growth Questions',
          body: '"Tell me about a time you failed." "What is the biggest mistake you have made in your career?" "Describe a project that did not go the way you hoped."\n\nFailure questions are arguably the most important behavioral category because they test self-awareness, ownership, and growth — three traits that almost all senior roles require. This is also where most candidates are weakest. The two failure modes are: (1) telling a fake failure that is actually a success in disguise ("I worked too hard"), and (2) telling a real failure but blaming external forces.\n\nThe answer hiring committees love is straightforward: pick a *real* failure, take *full* ownership without excuses, explain *what specifically you did wrong* and what your reasoning was at the time, then show *what you learned and how you have applied that learning since*. The growth is the point — interviewers will overlook a bad outcome if they hear genuine reflection. They will not overlook defensiveness.\n\nA test for whether your failure story is strong enough: tell it to a friend who knows you well, and ask if it makes you sound *worse* before it makes you sound *better*. If yes, you have a real story. If not, pick a different one.',
        },
        {
          heading: 'Ambiguity, Initiative, and Bias-for-Action Questions',
          body: '"Tell me about a time you had to make a decision without enough information." "Describe a time you took initiative beyond your formal role." "Give me an example of when you had to act under pressure."\n\nThese questions are increasingly common because remote work and flatter org structures put more weight on individual judgment. Interviewers want to see that you can move forward without waiting for permission, but also that you do not break things by being reckless.\n\nStrong answers show your *decision-making process* explicitly: what was the data you had, what were the options you considered, what trade-off did you make, what risk did you accept and why, and how did you manage the downside. Bonus points if you can describe a moment where you almost waited for more information, but consciously decided that the cost of delay was higher than the cost of being wrong.\n\nAmazon calls this "Bias for Action" and tests it on every candidate. Most other companies test it under different names — "comfort with ambiguity" at Google, "obligation to dissent" at McKinsey — but the underlying signal is the same.',
          links: [
            { text: 'Amazon Leadership Principles', href: '/learn/guides/amazon-leadership-principles-guide' },
            { text: 'How to Interview at Google', href: '/learn/guides/how-to-interview-at-google' },
          ],
        },
        {
          heading: 'How to Prepare: The 8-Story Library',
          body: 'You do not need to memorize an answer for every possible question. You need 8 to 10 *versatile stories* that can each answer 2 to 3 different question types. Think of this as a story library, not a script.\n\nA balanced library covers: one leadership story, one teamwork or collaboration story, one conflict story, one failure-and-learning story, one initiative or scrappy execution story, one ambiguity or judgment-under-pressure story, one stakeholder management story, and one technical or analytical problem-solving story relevant to your domain.\n\nFor each story, write a one-page outline with: the situation in 2 sentences, your specific task in 1 sentence, 4 to 6 actions with concrete details, and a result with at least one quantitative metric. Then practice telling each one out loud in 2 minutes flat. The act of writing is what makes the recall fast — once a story is in your library, you will be able to adapt it on the fly to whatever the interviewer actually asks.\n\nThe single best preparation tool is repetition with feedback. Mock interviews — whether with a friend, a coach, or an AI interviewer — surface the gaps in your stories that re-reading your notes never will.',
        },
      ],
      tips: [
        'Write a one-page outline for each of 8 versatile stories before any real interview. Refresh them every time you change roles.',
        'Always quantify results: numbers, percentages, dollars, hours saved, NPS deltas — anything specific beats anything vague.',
        'Spend 60 percent of your speaking time on the Action step. Most candidates spend 60 percent on the Situation. Reverse it.',
        'Use "I" not "we". Hiring committees can only score you for actions they hear you take.',
        'Pick failure stories that make you look slightly worse before they make you look better. Real reflection beats clean narratives.',
        'Practice each story out loud, on a timer, until you can finish in under 2 minutes. Then practice the follow-up answers separately.',
      ],
      faq: [
        { q: 'How is the STAR method different from just telling a story?', a: 'STAR enforces a structure that maps directly to what hiring committees are scoring. Without it, candidates spend too long on context and not enough on their specific actions and results. STAR keeps you focused, concise, and easy to score.' },
        { q: 'What if I do not have a lot of work experience yet?', a: 'Behavioral answers can come from internships, university capstone projects, volunteer work, side projects, or open source contributions. The principles of leadership, conflict, ownership, and learning from failure apply across contexts. Just be transparent about where the story came from — "in my university capstone project, I…" — and the interviewer will calibrate accordingly.' },
        { q: 'How many behavioral stories should I actually prepare?', a: 'Eight to ten versatile stories is the sweet spot. Each story can typically answer 2 to 3 different question categories with light adaptation, so this covers the full universe of questions you are likely to see. Memorizing more leads to surface-level recall instead of deep familiarity.' },
        { q: 'Should I always use STAR for every behavioral question?', a: 'Yes for any question that asks about a specific past experience ("tell me about a time", "describe when", "give me an example"). STAR is not appropriate for hypothetical questions ("how would you", "what would you do"), opinion questions ("what is your view on"), or technical drilldowns. Match the framework to the question type.' },
        { q: 'How do I handle a behavioral question when I genuinely cannot think of an example?', a: 'Take 5 to 10 seconds of quiet thinking — interviewers prefer a thoughtful pause to a rambling start. If you still cannot find a perfect example, offer a partial one: "I do not have a story that exactly matches that, but the closest situation is…" Honesty is rewarded; bluffing is not.' },
        { q: 'Are behavioral questions still relevant for technical or engineering roles?', a: 'Absolutely. Companies like Google, Meta, Amazon, and Stripe weight behavioral interviews equally with technical ones for senior engineering roles, and the hiring committee can override a strong technical signal if the behavioral signal is weak. For most senior offers, behavioral performance is the deciding factor.' },
      ],
    },
  },
  {
    slug: 'technical-interview-questions',
    title: 'Technical Interview Questions',
    description: 'Prepare for technical interviews with domain-specific questions for software engineering, data science, DevOps, and more.',
    category: 'questions',
    keywords: ['technical interview questions', 'coding interview', 'system design interview', 'data science interview', 'software engineer interview questions'],
    relevantDomains: ['backend', 'ds', 'devops'],
    relevantExperience: [],
    relevantWeakAreas: ['technical_depth'],
    relevantGoals: ['improve_scores'],
    content: {
      intro: 'Technical interviews assess your domain expertise through problem-solving, system design, and knowledge-based questions. Preparation varies by domain but the core principles remain: think aloud, structure your approach, and communicate clearly.',
      sections: [
        {
          heading: 'Software Engineering Interviews',
          body: 'SWE interviews typically include coding problems, system design, and behavioral rounds. For coding, practice data structures (arrays, trees, graphs, hash maps) and algorithms (sorting, searching, dynamic programming). For system design, learn to break down large systems into components, discuss trade-offs, and estimate scale. Use a whiteboard or shared editor to visualize your thinking.'
        },
        {
          heading: 'Data Science Interviews',
          body: 'DS interviews cover statistics, machine learning, SQL, and case studies. Be ready to explain model selection, feature engineering, and evaluation metrics. Practice translating business problems into analytical frameworks. Common questions: "How would you detect fraud in transactions?" or "Design an A/B test for a new feature."'
        },
        {
          heading: 'System Design Principles',
          body: 'System design questions test your ability to architect scalable, reliable systems. Start by clarifying requirements and constraints. Estimate scale (users, data volume, QPS). Design the high-level architecture, then dive deep into specific components. Discuss trade-offs between consistency, availability, and partition tolerance. Always address failure modes and monitoring.'
        },
        {
          heading: 'How to Think Aloud',
          body: 'Technical interviewers evaluate your thought process, not just the final answer. Narrate your approach: "First, I\'ll identify the constraints. This looks like a graph traversal problem because..." Ask clarifying questions before diving in. Discuss trade-offs between approaches. If stuck, explain what you\'ve tried and what you\'re considering next.'
        },
      ],
      tips: [
        'Practice coding problems daily for at least 2-3 weeks before your interview.',
        'For system design, study real-world architectures (how does Twitter handle the timeline? How does Uber match riders?).',
        'Always clarify the problem before starting to solve it — interviewers intentionally leave requirements ambiguous.',
        'Time yourself during practice — most coding problems should be solved in 20-30 minutes.',
        'After solving a problem, optimize it. Discuss time and space complexity.',
      ],
      faq: [
        { q: 'How long should I prepare for a technical interview?', a: 'Most candidates need 4-8 weeks of dedicated preparation, practicing 1-2 hours daily. Focus on your weakest areas first, then build breadth. If you\'re already coding regularly, 2-4 weeks may be sufficient.' },
        { q: 'What if I get stuck during a coding problem?', a: 'First, restate the problem to ensure understanding. Try working through a small example manually. Consider common patterns (two pointers, sliding window, BFS/DFS). If truly stuck, tell the interviewer: "I\'m considering X approach because..." — they often provide hints.' },
        { q: 'Do I need to write perfect code in a technical interview?', a: 'No. Interviewers prioritize problem-solving approach, communication, and code structure over syntax perfection. Pseudocode is often acceptable. However, your code should be logically correct and well-organized.' },
      ],
    },
  },
  {
    slug: 'second-interview-questions',
    title: 'Second Interview Questions',
    description: 'Prepare for second-round interviews with deeper questions about culture fit, leadership, and role-specific scenarios.',
    category: 'questions',
    keywords: ['second interview questions', 'second round interview', 'final interview questions', 'panel interview', 'interview with hiring manager'],
    relevantDomains: [],
    relevantExperience: ['3-6', '7+'],
    relevantWeakAreas: [],
    relevantGoals: ['improve_scores', 'promotion'],
    content: {
      intro: 'Second interviews go deeper than initial screenings. You\'ll likely meet the hiring manager, potential teammates, or a panel. Questions shift from "can you do the job?" to "are you the right fit?" and "how will you perform in this specific environment?"',
      sections: [
        {
          heading: 'What to Expect in a Second Interview',
          body: 'Second interviews are typically longer (60-90 minutes), more detailed, and may involve multiple interviewers or a panel. You\'ll face role-specific scenarios, deeper behavioral questions, and culture-fit assessments. Some companies include presentations, case studies, or work samples at this stage.'
        },
        {
          heading: 'Culture Fit Questions',
          body: '"What type of work environment do you thrive in?" and "How do you handle disagreements with your manager?" These questions assess whether your working style aligns with the team. Research the company\'s values and culture beforehand. Be authentic — a poor culture fit hurts both you and the employer.'
        },
        {
          heading: 'Role-Specific Scenarios',
          body: '"How would you handle your first 90 days in this role?" or "Walk us through how you\'d approach [specific project]." These test strategic thinking and practical knowledge. Show that you understand the role\'s challenges and have a thoughtful plan. Ask clarifying questions to demonstrate engagement.'
        },
        {
          heading: 'Questions to Ask in a Second Interview',
          body: 'This is your opportunity to evaluate the company. Ask about: team dynamics and collaboration style, how success is measured in the first year, biggest challenges the team is currently facing, career growth paths, and the decision-making timeline. Thoughtful questions show you\'re seriously evaluating the opportunity.'
        },
      ],
      tips: [
        'Review your first interview notes — second interviewers often reference themes from round one.',
        'Prepare a 90-day plan for the role to demonstrate strategic thinking.',
        'Research each interviewer on LinkedIn to understand their background and potential perspectives.',
        'Bring specific questions about the team, projects, and growth opportunities.',
        'Send personalized thank-you notes to each interviewer within 24 hours.',
      ],
      faq: [
        { q: 'Is a second interview a good sign?', a: 'Yes — companies only invest time in second interviews with candidates they\'re seriously considering. However, you\'re likely competing with 2-4 other finalists, so strong preparation is still essential.' },
        { q: 'How is a second interview different from the first?', a: 'First interviews assess baseline qualifications and communication skills. Second interviews evaluate culture fit, deeper technical competence, and how you\'d perform in specific role scenarios. They\'re typically longer and involve senior stakeholders.' },
        { q: 'Should I negotiate salary in a second interview?', a: 'Only discuss compensation if the interviewer brings it up. If asked about expectations, provide a researched range. Detailed negotiation is usually reserved for after receiving a formal offer.' },
      ],
    },
  },
  {
    slug: 'mock-interview-guide',
    title: 'Complete Mock Interview Guide',
    description: 'Everything you need to know about mock interviews: how to practice effectively, get feedback, and build confidence before the real thing.',
    category: 'questions',
    keywords: ['mock interview', 'practice interview', 'interview practice', 'mock interview tips', 'interview simulation'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['confidence'],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'Mock interviews are the single most effective way to prepare for real interviews. They reduce anxiety, improve your delivery, and help you identify blind spots in your answers. Here\'s how to make the most of your practice sessions.',
      sections: [
        {
          heading: 'Why Mock Interviews Work',
          body: 'Research shows that interview performance improves significantly with practice under realistic conditions. Mock interviews activate the same stress responses as real interviews, helping you build familiarity and confidence. They also reveal habits you\'re not aware of — filler words, rambling answers, or missing key points.'
        },
        {
          heading: 'How to Structure a Mock Interview',
          body: 'Set up a realistic environment: use video if your real interview will be virtual, dress professionally, and minimize distractions. Follow the actual interview format — opening, behavioral questions, technical questions (if applicable), and closing. Aim for 30-45 minutes. Record yourself so you can review your performance.'
        },
        {
          heading: 'Getting Effective Feedback',
          body: 'Good feedback is specific and actionable. Ask your practice partner to evaluate: answer structure (did you use STAR?), relevance (did you address the question?), conciseness (were you too long or too short?), and delivery (pace, confidence, filler words). AI-powered mock interviews like Interview Prep Guru provide scored feedback across multiple dimensions automatically.'
        },
        {
          heading: 'Common Mock Interview Mistakes',
          body: 'Avoid these common pitfalls: practicing only in your head instead of out loud, memorizing scripts instead of key points, not recording yourself, skipping the "questions for the interviewer" portion, and not debriefing after each practice session. The goal is realistic practice, not comfort.'
        },
      ],
      tips: [
        'Do at least 3-5 full mock interviews before your real interview.',
        'Practice with different people to get varied perspectives and question styles.',
        'Record your mock interviews and watch them back — you\'ll notice habits you can\'t feel in the moment.',
        'Time your answers to ensure you\'re staying within 2-3 minutes for behavioral questions.',
        'Practice recovery from tough questions — being stumped in a mock interview is valuable learning.',
      ],
      faq: [
        { q: 'How many mock interviews should I do before a real interview?', a: 'Aim for 3-5 full mock interviews over 1-2 weeks. Space them out to allow time for improvement between sessions. Quality matters more than quantity — one well-debriefed mock interview is worth three without feedback.' },
        { q: 'Can I do mock interviews alone?', a: 'Yes — AI tools like Interview Prep Guru simulate realistic interview conversations and provide instant scored feedback. You can also record yourself answering questions and review the recording. However, practicing with a real person adds the interpersonal element.' },
        { q: 'What should I do after a mock interview?', a: 'Review the feedback immediately. Identify your top 2-3 improvement areas. Rewrite any weak answers. Practice those specific answers again before your next session. Track your progress across sessions to measure improvement.' },
      ],
    },
  },

  // ──────────────── TIPS & FRAMEWORKS ────────────────
  {
    slug: 'interview-tips',
    title: '50+ Interview Tips for 2026',
    description: 'Comprehensive collection of expert interview tips covering preparation, delivery, body language, follow-up, and common mistakes to avoid.',
    category: 'tips',
    keywords: ['interview tips', 'job interview advice', 'interview preparation tips', 'how to ace an interview', 'interview do\'s and don\'ts'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: [],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'Whether it\'s your first interview or you\'re a seasoned professional, these 50+ tips cover every stage of the interview process — from preparation through follow-up.',
      sections: [
        {
          heading: 'Before the Interview',
          body: 'Research the company\'s mission, recent news, competitors, and culture. Study the job description and map your experience to each requirement. Prepare 8-10 STAR stories. Practice with a mock interview tool. Plan your outfit the night before. Test your technology for virtual interviews. Prepare 5+ questions to ask the interviewer. Print extra copies of your resume.'
        },
        {
          heading: 'During the Interview',
          body: 'Arrive 10-15 minutes early. Make strong eye contact and offer a firm handshake (or look at the camera for video). Listen actively before responding. Take a moment to think before answering complex questions. Use specific examples, not generalities. Show enthusiasm without being inauthentic. Keep your answers focused and concise (1-3 minutes). Mirror the interviewer\'s energy level.'
        },
        {
          heading: 'Virtual Interview Tips',
          body: 'Test your camera, microphone, and internet 30 minutes before. Use a clean, professional background. Position your camera at eye level. Look at the camera (not the screen) when speaking. Close unnecessary tabs and silence notifications. Have a glass of water nearby. Use natural hand gestures that stay within the camera frame.'
        },
        {
          heading: 'After the Interview',
          body: 'Send a personalized thank-you email within 24 hours to each interviewer. Reference specific conversation points. Reiterate your interest and key qualifications. If you haven\'t heard back by the stated timeline, follow up once with a polite email. Debrief yourself: what went well? What would you improve?'
        },
      ],
      tips: [
        'The "2-minute rule": keep most answers between 1-3 minutes unless asked to elaborate.',
        'Prepare a "brag sheet" — a list of quantified achievements you can reference during the interview.',
        'Use the interviewer\'s name naturally during conversation to build rapport.',
        'If you don\'t understand a question, ask for clarification rather than guessing what they meant.',
        'End every answer on a positive note, even when discussing challenges or failures.',
      ],
      faq: [
        { q: 'What is the biggest mistake candidates make in interviews?', a: 'Not preparing specific examples. Candidates who give vague, generic answers are far less memorable than those who share detailed stories with quantified results. The second biggest mistake is not researching the company — it signals low interest.' },
        { q: 'How early should I arrive for an in-person interview?', a: 'Arrive at the building 15 minutes early, but check in at reception 5-10 minutes before your scheduled time. Arriving too early can be just as awkward as arriving late. Use extra time to review your notes in the car or lobby.' },
        { q: 'What should I do if I\'m running late to an interview?', a: 'Call or email immediately. Be honest about the situation, apologize sincerely, and provide a realistic arrival time. Most interviewers are understanding about occasional delays — it\'s how you handle the situation that matters.' },
      ],
    },
  },
  {
    slug: 'phone-interview-tips',
    title: 'Phone Interview Tips',
    description: 'Expert tips for phone screening interviews including preparation, delivery, and how to make a strong impression without visual cues.',
    category: 'tips',
    keywords: ['phone interview tips', 'phone screening', 'phone interview preparation', 'recruiter phone call', 'telephone interview'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['confidence'],
    relevantGoals: ['first_interview'],
    content: {
      intro: 'Phone interviews are typically the first screening step. Without visual cues, your voice, energy, and preparation become even more important. Here\'s how to make the most of this critical 20-30 minute conversation.',
      sections: [
        {
          heading: 'Preparing for a Phone Screen',
          body: 'Have the job description, your resume, and prepared notes in front of you — this is an advantage of phone interviews. Research the company and the interviewer. Prepare concise versions of your key stories (shorter than in-person). Have a quiet space with good cell reception. Charge your phone and disable call waiting.'
        },
        {
          heading: 'Delivery and Tone',
          body: 'Stand up or sit up straight — your posture affects your voice. Smile while speaking (it genuinely changes your vocal tone). Speak slightly slower than your normal pace, as phone audio can distort fast speech. Use vocal variety to convey enthusiasm. Avoid filler words like "um" and "like" — they\'re more noticeable without visual distractions.'
        },
        {
          heading: 'Common Phone Screen Questions',
          body: 'Phone screens focus on: why you\'re interested in the role, your relevant experience summary, salary expectations, availability/timeline, and basic qualifications. Keep answers concise (60-90 seconds each). The screener is checking boxes — help them check yours quickly and clearly.'
        },
      ],
      tips: [
        'Use a landline or ensure strong cell reception — dropped calls create a poor impression.',
        'Keep a glass of water nearby for dry mouth moments.',
        'Take brief notes during the call to reference in your thank-you email.',
        'If the call comes at a bad time, ask to reschedule within 24 hours rather than doing it distracted.',
        'Have your calendar open to immediately confirm next steps.',
      ],
      faq: [
        { q: 'How long do phone interviews usually last?', a: 'Most phone screenings last 20-30 minutes. Longer calls (45+ minutes) usually indicate strong interest. If the call is shorter than 15 minutes, it may be a quick qualification check rather than a full screening.' },
        { q: 'Should I use speakerphone or headphones?', a: 'Use wired headphones with a microphone for the best audio quality. Speakerphone can create echo and background noise. Bluetooth headphones work but can occasionally have audio lag.' },
        { q: 'Can I use notes during a phone interview?', a: 'Yes — this is one advantage of phone interviews. Have bullet points (not scripts) for your key stories, the job requirements mapped to your experience, and questions to ask. Avoid reading verbatim as it sounds unnatural.' },
      ],
    },
  },
  {
    slug: 'video-interview-tips',
    title: 'Video Interview Tips',
    description: 'Master video interviews with tips on setup, camera presence, body language, and technology to make a professional impression on Zoom, Teams, and more.',
    category: 'tips',
    keywords: ['video interview tips', 'zoom interview', 'virtual interview', 'online interview tips', 'remote interview'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['confidence'],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'Video interviews are now standard across industries. The technology adds a layer of complexity — but also opportunity. With the right setup and techniques, you can make an even stronger impression than in-person.',
      sections: [
        {
          heading: 'Technical Setup',
          body: 'Test your camera, microphone, and internet at least 30 minutes before. Use a wired ethernet connection if possible. Position your camera at eye level (stack books under your laptop if needed). Use external lighting facing you — avoid backlighting from windows. Close all unnecessary applications and browser tabs. Have a backup plan (phone number) in case of technical failure.'
        },
        {
          heading: 'Background and Appearance',
          body: 'Use a clean, professional background — a bookshelf, plain wall, or tidy office space. Avoid virtual backgrounds as they can glitch. Dress fully professional (not just the top half). Solid colors work best on camera. Remove distracting items from the visible area. Ensure the room is well-lit with light facing you.'
        },
        {
          heading: 'Camera Presence',
          body: 'Look at the camera lens (not the screen) when speaking — this creates eye contact with the interviewer. It feels unnatural but makes a significant difference. When listening, you can look at the screen. Use natural hand gestures within the camera frame. Sit slightly forward to convey engagement. Nod to show you\'re listening.'
        },
      ],
      tips: [
        'Place a sticky note with "LOOK HERE" next to your camera as a reminder to make eye contact.',
        'Use the gallery/tile view so you can see the interviewer while keeping your eyes near the camera.',
        'Have a physical notepad for notes rather than typing — keyboard sounds are distracting.',
        'If you experience a technical issue, stay calm, acknowledge it briefly, and move on.',
        'Record a test video of yourself answering a question to check your setup and presence.',
      ],
      faq: [
        { q: 'What\'s the best background for a video interview?', a: 'A clean, well-lit space with minimal distractions. A bookshelf, plain wall, or home office works well. Avoid virtual backgrounds — they can glitch and appear unprofessional. The key is consistency: nothing in the background should draw attention away from you.' },
        { q: 'Should I look at the camera or the screen?', a: 'Look at the camera lens when speaking (this creates eye contact for the interviewer). Look at the screen when the interviewer is speaking. It takes practice but dramatically improves your video presence.' },
        { q: 'What should I do if my internet cuts out during the interview?', a: 'Have the interviewer\'s email or phone number ready. If disconnected, immediately send a brief message: "Apologies for the technical difficulty, attempting to reconnect." Most interviewers are understanding — what matters is how calmly you handle it.' },
      ],
    },
  },
  {
    slug: 'body-language-guide',
    title: 'Body Language Guide for Interviews',
    description: 'Master non-verbal communication in interviews: posture, eye contact, hand gestures, facial expressions, and confidence signals.',
    category: 'tips',
    keywords: ['interview body language', 'non-verbal communication', 'interview confidence', 'eye contact in interviews', 'hand gestures interview'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['confidence'],
    relevantGoals: ['improve_scores'],
    content: {
      intro: 'Research shows that non-verbal communication accounts for up to 55% of the impression you make. Mastering body language can be the difference between a good interview and a great one.',
      sections: [
        {
          heading: 'Posture and Positioning',
          body: 'Sit up straight with both feet on the floor. Lean slightly forward to show engagement (about 10-15 degrees). Keep your shoulders back and relaxed — not tense or slouched. Avoid crossing your arms, which can signal defensiveness. In a panel interview, angle your body toward whoever is speaking.'
        },
        {
          heading: 'Eye Contact',
          body: 'Maintain natural eye contact for 3-5 seconds at a time, then briefly look away before re-engaging. In a panel, make eye contact with the person who asked the question, then briefly include other panelists. For video interviews, look at the camera when speaking. Avoid staring (which feels aggressive) or constantly looking away (which signals discomfort).'
        },
        {
          heading: 'Hand Gestures',
          body: 'Natural hand gestures make you appear more confident and help your verbal delivery. Keep gestures within a "box" from your shoulders to your waist. Open palms signal honesty. Avoid: pointing, fidgeting with objects, touching your face, or keeping your hands hidden under the table.'
        },
        {
          heading: 'Confidence Signals vs. Nervousness Signals',
          body: 'Confidence: firm handshake, steady eye contact, measured pace of speech, open posture, genuine smile. Nervousness: fidgeting, touching your face/hair, crossed arms, rapid speech, avoiding eye contact, nervous laughter. Awareness is the first step — practice in mock interviews to build comfortable habits.'
        },
      ],
      tips: [
        'Practice your "resting interview face" — a slight, natural smile signals warmth and confidence.',
        'Mirror the interviewer\'s energy level subtly — if they\'re animated, show more energy; if calm, match that.',
        'Take a deep breath before answering a difficult question — it creates a natural, confident pause.',
        'Keep a glass of water to use as a natural pause mechanism when you need a moment to think.',
      ],
      faq: [
        { q: 'What should I do with my hands during an interview?', a: 'Rest them on the table or in your lap when not gesturing. Use natural, open gestures when speaking. Avoid: clasping them tightly, hiding them, fidgeting with pens, or gesturing too wildly. Steepled fingers (fingertips touching) convey confidence.' },
        { q: 'How do I appear confident even when I\'m nervous?', a: 'Use "power posing" for 2 minutes before the interview (stand tall, hands on hips). During the interview: sit up straight, maintain eye contact, speak at a measured pace, and pause deliberately before answering. Your body can lead your mind into confidence.' },
        { q: 'Does body language matter in phone interviews?', a: 'Yes — your posture affects your voice. Standing up makes you sound more energetic. Smiling changes your vocal tone. Even though the interviewer can\'t see you, your body language affects how you sound and feel.' },
      ],
    },
  },
  {
    slug: 'star-method-guide',
    title: 'The STAR Method: Complete Guide with Examples (2026)',
    description: 'A complete guide to the STAR interview method (Situation, Task, Action, Result). Includes a full worked example, the time budget interviewers expect, common mistakes to avoid, and how STAR compares to alternative frameworks like SOAR, CAR, and SPAR.',
    category: 'frameworks',
    keywords: ['STAR method', 'STAR interview technique', 'situation task action result', 'behavioral interview framework', 'STAR method examples', 'STAR vs CAR', 'STAR worked example'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['star_structure', 'specificity', 'storytelling'],
    relevantGoals: ['improve_scores', 'general_practice'],
    content: {
      intro: 'The STAR method is the gold standard for answering behavioral interview questions and the framework that almost every hiring committee — at Google, Amazon, Meta, McKinsey, BCG, Goldman, and most well-run startups — explicitly trains its interviewers to score against. This guide walks you through each letter of STAR in detail, shows you a full worked example you can use as a template, breaks down the time budget interviewers actually expect, and lists the common mistakes that quietly tank otherwise good candidates.',
      sections: [
        {
          heading: 'Why STAR Beats Every Other Behavioral Framework',
          body: 'Behavioral interviewers are trained against a structured rubric. They listen for specific evidence of *situation context*, *individual ownership*, *concrete actions*, and *measurable outcomes*. A free-form story almost always misses one of these dimensions, which forces the interviewer to either probe for it (eating your time) or mark it down (eating your score). STAR solves this problem at the source by walking you through every dimension in the order interviewers want to hear them.\n\nThe bigger reason STAR wins, though, is *predictability for the interviewer*. Most interviewers are doing 4 to 6 candidate loops in a single day, often back-to-back. They are tired, they are taking notes, and they need to fit your answer into a scoring template within 90 seconds of you finishing. A well-formed STAR answer literally maps line-for-line onto their scorecard. A free-form answer does not. All else equal, the STAR answer scores higher because it is *easier to score*.\n\nNone of this means STAR is the *only* good framework. CAR (Challenge, Action, Result), SOAR (Situation, Obstacles, Actions, Results), and SPAR (Situation, Problem, Action, Result) all work — they are just variants of the same idea. STAR is the most widely taught and the most widely recognized, which is why we recommend it as your default.',
          links: [
            { text: 'Behavioral Interview Questions', href: '/learn/guides/behavioral-questions' },
          ],
        },
        {
          heading: 'S — Situation: Set the Scene Without Burning Time',
          body: 'Briefly describe the context. Where were you working, what was the team or project, and why was the situation significant? Aim for 2 to 3 sentences and 15 seconds of speaking time. The goal is to give the interviewer just enough scaffolding to understand the challenge, then move on.\n\nThe most common Situation mistake is over-explaining. Candidates spend 60 seconds describing the org chart, the company history, the previous project, and the tech stack — and then have only 90 seconds left for everything that actually matters. If you find yourself saying "and then a year before that…" you have lost the thread.\n\n**Good example:** "At my previous company, my team of 8 engineers was migrating a legacy payments service to a microservices architecture, with a hard 3-month deadline driven by a vendor contract renewal."\n\n**Bad example:** "So in my previous job — well, I had been there for about three years at that point — and the company was a fintech, and they had originally been built on a monolith because the founders were ex-PayPal…" (You have already lost 20 seconds and the interviewer has not learned anything that affects the score.)',
        },
        {
          heading: 'T — Task: Make Your Individual Responsibility Crystal Clear',
          body: 'Clarify your specific role and what was expected of *you*, separately from what the team had to deliver. This is the single most important transition in a STAR answer because it tells the interviewer how much credit to assign to you personally for everything that follows.\n\nAim for 1 to 2 sentences and 10 to 15 seconds. The Task is short on purpose — you do not need to defend the assignment, you just need to own it.\n\n**Good example:** "As the tech lead on the project, I owned the migration design, the cutover plan, and the on-call rotation for the first month after launch."\n\n**Bad example:** "We were tasked with migrating the system." (Notice the "we". The interviewer now has no idea whether you were the architect, an individual contributor, the project manager, or a ride-along.)\n\nIf your role was genuinely shared with someone else, *say so explicitly* and then describe your half: "My peer led the database migration; I led the API contract changes and the rollback plan."',
        },
        {
          heading: 'A — Action: The 60 Percent of Your Answer That Matters Most',
          body: 'Action is where 60 percent of your speaking time should go — typically 60 to 90 seconds. This is where the interviewer learns how you think and what you can actually do. Skipping or rushing this section is the number one reason behavioral answers fall flat.\n\nFour rules for a strong Action section:\n\n1. **Use "I" not "we".** Hiring committees can only credit you for actions they hear *you* take. "We decided to" buys you nothing.\n\n2. **Walk through 3 to 5 specific steps**, in order, with the reasoning behind each. The interviewer wants to see your decision-making process, not just the highlights reel.\n\n3. **Include at least one obstacle and how you handled it.** Real work has friction. If your story has zero friction, the interviewer assumes you skipped something.\n\n4. **Tie your actions to skills relevant to the job.** If you are interviewing for a technical lead role, surface the technical decisions. If you are interviewing for a people-management role, surface the coaching and conflict moments.\n\n**Good example:** "I started by mapping all the upstream dependencies — there were 14 services calling the legacy API, and three of them had no documented owners. I tracked down the owners myself and got commitments to update their integrations. Then I proposed a phased cutover instead of a big-bang migration, because the rollback path on a big-bang would have meant 4 hours of downtime. I wrote the migration plan, presented it to the architecture review board, and got approval after addressing two concerns about data consistency. During the cutover, our database team discovered an edge case that threatened to corrupt 0.1 percent of transactions — I made the call to pause for 24 hours, fix it properly, and re-run the migration on the weekend."',
          links: [
            { text: 'Behavioral Interview Questions', href: '/learn/guides/behavioral-questions' },
          ],
        },
        {
          heading: 'R — Result: Quantify or Lose Half the Credit',
          body: 'Share the outcome in 15 to 30 seconds, with at least one specific metric. Numbers are not optional in a strong result — interviewers are explicitly trained to mark down vague outcomes. "We delivered on time" earns half credit. "We delivered 2 weeks ahead of schedule with zero customer-facing downtime, and processing latency dropped from 800ms to 480ms" earns full credit.\n\nGood metrics to reach for: percentage changes, dollar impact, customer or user counts, latency or speed improvements, time-to-market reduction, retention or churn numbers, NPS or CSAT deltas, head-count or efficiency improvements. Even imperfect data is better than no data — "I do not have the exact number, but our weekly bug reports for that area dropped by roughly half" is fine.\n\nIf the outcome was *not* positive, name the result honestly and then add the learning. Failure stories with reflection routinely score higher than success stories without reflection. The pattern: "The result was X. In hindsight, the mistake I made was Y. Since then I have done Z differently, and on the next similar project we got A."',
        },
        {
          heading: 'A Full Worked Example You Can Borrow',
          body: 'Here is a complete STAR answer to a common question, sized for the time budget interviewers actually expect. Read it once, then write your own version of the same shape.\n\n**Question:** "Tell me about a time you had to meet a tight deadline."\n\n**Situation (15 seconds):** "Last year, our biggest client requested a custom reporting feature with a 2-week deadline. Internally, our normal estimate for that scope of work was 6 weeks."\n\n**Task (10 seconds):** "As the project lead, I owned the scoping conversation with the client, the rebalancing of our sprint, and the risk plan."\n\n**Action (75 seconds):** "I started by breaking the feature into must-haves and nice-to-haves with the client\'s stakeholder on a 30-minute call. We agreed on 4 must-have components for the 2-week sprint and 3 enhancements for a follow-up sprint. Once the scope was locked, I rebalanced our existing sprint — pushed two non-urgent features to the next cycle, freed up 3 of our 5 engineers full-time for the new work, and personally took on the most complex integration piece because I had context from a similar project the year before. I set up a daily 15-minute standup with the client\'s engineering counterpart to catch integration issues early, which paid off on day 4 when we spotted a schema mismatch that would have blown the deadline if we had found it in week 2."\n\n**Result (20 seconds):** "We shipped all 4 must-have components on day 13, one day ahead of schedule, with no production incidents in the first month. The client was so pleased with the transparency and pace that they expanded their contract by 30 percent the following quarter. The phased-scope approach we used became our standard template for any urgent customer ask."\n\nTotal length: about 2 minutes. Notice how the Action section is the longest, the Result has three concrete numbers, and the "I" pronoun is consistent throughout.',
        },
        {
          heading: 'Common STAR Mistakes That Quietly Tank Your Score',
          body: '1. **Burying yourself in Situation.** Spending 45 seconds setting the scene and only 30 seconds on Action is the most common failure mode. Cap Situation at 15 seconds.\n\n2. **Saying "we" when you mean "I".** Interviewers are scoring *you*, not your team. Every "we" is a missed scoring opportunity.\n\n3. **Skipping the obstacle.** A story with no friction sounds either fake or shallow. Always include at least one moment where the path was unclear and you had to make a call.\n\n4. **Vague Results.** "Things went well" earns nothing. If you cannot remember a metric, estimate one and say "approximately" — interviewers respect calibrated estimates more than perfect amnesia.\n\n5. **Picking the wrong story.** Your strongest story for *leadership* is rarely your strongest story for *failure*. Build a library of 8 to 10 distinct stories so you can match the right one to each question.\n\n6. **Memorizing word-for-word.** Memorized answers sound robotic and collapse the moment a follow-up question forces you off script. Practice the *shape* of each story until you can re-tell it conversationally, then trust the framework.',
          links: [
            { text: 'Behavioral Interview Questions', href: '/learn/guides/behavioral-questions' },
            { text: 'Amazon Leadership Principles', href: '/learn/guides/amazon-leadership-principles-guide' },
          ],
        },
      ],
      tips: [
        'Build a library of 8 to 10 versatile STAR stories before your first interview, not the night before.',
        'Cap Situation and Task at 30 seconds combined. Spend 60 to 90 seconds on Action and 15 to 30 on Result.',
        'Always quantify the Result with at least one number. "Approximately" is fine; "things went well" is not.',
        'Use "I" not "we" — every "we" is a credit you are giving away to people the interviewer cannot score.',
        'Include one obstacle in every Action section. Frictionless stories sound shallow and invite suspicion.',
        'Practice each story out loud on a 2-minute timer until you can finish without rushing. Then practice the follow-up answers separately.',
      ],
      faq: [
        { q: 'What is the ideal length for a STAR answer?', a: 'About 2 to 3 minutes total. Situation 15 to 30 seconds, Task 10 to 15 seconds, Action 60 to 90 seconds, Result 15 to 30 seconds. If the interviewer wants more detail, they will ask follow-ups — your job in the first answer is to land all four sections cleanly.' },
        { q: 'Can I use the same STAR story for different questions?', a: 'Yes, and you should. A strong project story can answer questions about leadership, tight deadlines, teamwork, conflict, or stakeholder management depending on which actions you emphasize. Build versatile stories instead of one-purpose answers.' },
        { q: 'What if my result was not positive?', a: 'Failure stories with genuine reflection routinely score higher than clean success stories. Share what happened honestly, take ownership without excuses, and explain exactly what you learned and how you have applied it since. Interviewers respect self-awareness more than they respect a flawless track record.' },
        { q: 'How is STAR different from CAR, SOAR, or SPAR?', a: 'SOAR (Situation, Obstacles, Actions, Results) puts more weight on obstacles. CAR (Challenge, Action, Result) is a condensed three-part variant. SPAR (Situation, Problem, Action, Result) emphasizes the problem statement. All four follow the same underlying logic: context, your action, the outcome. STAR is the most widely taught and the easiest for interviewers to score against, which is why we recommend it as your default.' },
        { q: 'Should I tell the interviewer "I am going to use the STAR method"?', a: 'No. Announcing the framework sounds rehearsed and breaks the conversational flow. Just *use* the structure — interviewers will recognize a clean STAR answer immediately without you naming it.' },
        { q: 'How do I handle aggressive follow-up questions like "tell me more about your role specifically"?', a: 'Follow-ups are a sign your story interested the interviewer — that is good. The trap is reaching for new details you did not actually know. If you do not remember an exact number, say "approximately X" or "I can ballpark it but I am not certain". Honesty about the edges of your memory builds trust; bluffing destroys it. Amazon and McKinsey interviewers in particular probe hard precisely to test for this.' },
      ],
    },
  },
  {
    slug: 'interview-frameworks',
    title: 'Interview Frameworks: SPAR, PPF & More',
    description: 'Beyond STAR: learn SPAR, Present-Past-Future, CAR, and other interview answer frameworks for different question types.',
    category: 'frameworks',
    keywords: ['interview frameworks', 'SPAR method', 'present past future method', 'CAR method', 'interview answer structure'],
    relevantDomains: [],
    relevantExperience: ['3-6', '7+'],
    relevantWeakAreas: ['star_structure', 'storytelling'],
    relevantGoals: ['improve_scores'],
    content: {
      intro: 'While STAR is the go-to framework for behavioral questions, different question types benefit from different structures. Here are the most effective interview frameworks and when to use each one.',
      sections: [
        {
          heading: 'SPAR Method (Situation, Problem, Action, Result)',
          body: 'SPAR is a variation of STAR that emphasizes the problem or challenge more explicitly. It\'s ideal for questions about overcoming obstacles, solving problems, or dealing with difficult situations. The Problem component helps you clearly articulate what was at stake before diving into your solution.'
        },
        {
          heading: 'Present-Past-Future (PPF) Method',
          body: 'PPF is perfect for "Tell me about yourself" — the most common opening question. Structure: Present (what you do now and recent accomplishments), Past (relevant background and how it led here), Future (why this role is the natural next step). This creates a compelling narrative arc that positions the job as a logical progression.'
        },
        {
          heading: 'CAR Method (Challenge, Action, Result)',
          body: 'CAR is a condensed framework ideal for shorter answers or when you need to cover multiple examples quickly. Skip the detailed context-setting and lead with the challenge. It\'s particularly effective in fast-paced panel interviews or when asked "Give me three examples of..."'
        },
        {
          heading: 'Choosing the Right Framework',
          body: '"Tell me about yourself" → PPF. "Tell me about a time when..." → STAR or SPAR. "What would you do if..." → Hypothetical framework (Clarify → Approach → Execute → Evaluate). "Why this company/role?" → Research-Connection-Enthusiasm. Quick examples needed → CAR. The key is having multiple tools and selecting the right one for each question type.'
        },
      ],
      tips: [
        'Master STAR first, then layer in other frameworks for variety and precision.',
        'PPF is the best framework for "Tell me about yourself" — practice it until it feels natural.',
        'Use CAR when you need brevity — it works well for supporting examples in longer discussions.',
        'For hypothetical questions, always start by clarifying assumptions before proposing a solution.',
      ],
      faq: [
        { q: 'Which framework should I use most often?', a: 'STAR for 70% of behavioral questions. PPF for introductions and "tell me about yourself." CAR for quick supporting examples. The framework should be invisible to the interviewer — they should just hear a well-structured, compelling answer.' },
        { q: 'Can I mix frameworks in one interview?', a: 'Absolutely — using different frameworks for different question types shows versatility and strong communication skills. The key is being consistent within each answer: don\'t start with STAR and switch to PPF mid-response.' },
        { q: 'Do interviewers know about these frameworks?', a: 'Most experienced interviewers are familiar with STAR and may even prompt you to use it. Using a framework doesn\'t make your answer feel "formulaic" — it makes it clear and easy to follow. Interviewers appreciate structured answers.' },
      ],
    },
  },

  // ──────────────── PRACTICE & ASSESSMENT ────────────────
  {
    slug: 'interview-readiness-quiz',
    title: 'Free Interview Readiness Quiz',
    description: 'Take our free quiz to assess your interview readiness across preparation, delivery, and confidence. Get personalized recommendations.',
    category: 'frameworks',
    keywords: ['interview readiness quiz', 'interview assessment', 'am I ready for an interview', 'interview preparation checklist', 'interview self-assessment'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: [],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'Not sure if you\'re ready for your upcoming interview? This self-assessment covers the key areas that determine interview success. Answer honestly to get personalized recommendations.',
      sections: [
        {
          heading: 'Preparation Readiness',
          body: 'Ask yourself: Can I explain why I want this specific role in under 60 seconds? Do I have 5+ specific examples from my experience ready to share? Have I researched the company\'s mission, recent news, and competitors? Can I map my skills to every major requirement in the job description? Do I have thoughtful questions prepared to ask the interviewer?'
        },
        {
          heading: 'Delivery Readiness',
          body: 'Ask yourself: Have I practiced answering questions out loud (not just in my head)? Can I tell a story using the STAR method in under 3 minutes? Have I done at least one mock interview? Am I comfortable with pauses and silence? Can I recover smoothly when I don\'t know an answer?'
        },
        {
          heading: 'Confidence Readiness',
          body: 'Ask yourself: Can I maintain eye contact comfortably? Do I feel authentic (not robotic) when delivering prepared answers? Am I comfortable discussing both my strengths and weaknesses? Can I handle unexpected questions without panicking? Do I know my salary expectations and can I discuss them calmly?'
        },
        {
          heading: 'Your Action Plan',
          body: 'If you answered "no" to 3+ questions in any section, focus there first. For Preparation gaps: spend 2-3 hours researching and writing out your stories. For Delivery gaps: do 2-3 mock interviews. For Confidence gaps: practice power posing, record yourself, and reframe nervousness as excitement. Every "no" you convert to "yes" significantly improves your chances.'
        },
      ],
      tips: [
        'Revisit this checklist 48 hours before your interview to identify any last-minute gaps.',
        'Focus on converting your weakest area first — that\'s where you\'ll see the biggest improvement.',
        'Share this quiz with a friend who\'s also preparing — accountability partners improve preparation quality.',
      ],
      faq: [
        { q: 'How long before my interview should I take this quiz?', a: 'Ideally 1-2 weeks before. This gives you enough time to address any gaps. Take it again 2 days before as a final check. If you\'re scoring well on all sections, you\'re in good shape.' },
        { q: 'What if I\'m not ready but my interview is tomorrow?', a: 'Focus on the highest-impact areas: prepare your "tell me about yourself" answer, have 3 strong STAR stories ready, research the company for 30 minutes, and prepare 3 questions to ask. Even a few hours of focused preparation makes a significant difference.' },
      ],
    },
  },
  {
    slug: 'salary-negotiation-guide',
    title: 'Salary Negotiation Guide',
    description: 'Learn how to negotiate your salary with confidence: research, timing, scripts, and strategies for getting the compensation you deserve.',
    category: 'frameworks',
    keywords: ['salary negotiation', 'how to negotiate salary', 'salary negotiation tips', 'compensation negotiation', 'job offer negotiation'],
    relevantDomains: [],
    relevantExperience: ['7+'],
    relevantWeakAreas: [],
    relevantGoals: ['promotion'],
    content: {
      intro: 'Most candidates leave money on the table by not negotiating. Research shows that employers expect negotiation and often build room for it into initial offers. Here\'s how to negotiate with confidence and professionalism.',
      sections: [
        {
          heading: 'Research Your Market Value',
          body: 'Before any negotiation, know your worth. Use Glassdoor, Levels.fyi (for tech), Payscale, and LinkedIn Salary Insights. Factor in: location, company size, industry, your experience level, and specialized skills. Identify a range: your minimum acceptable number, your target, and your stretch goal.'
        },
        {
          heading: 'When to Negotiate',
          body: 'The best time to negotiate is after receiving a written offer — you have maximum leverage when the company has decided they want you. If asked about salary expectations early, provide a range based on research: "Based on my experience and market data, I\'m targeting $X-$Y." Never give a single number.'
        },
        {
          heading: 'The Negotiation Conversation',
          body: 'Express genuine enthusiasm for the role first. Then: "I\'m very excited about this opportunity. Based on my research and the value I\'d bring in [specific area], I was hoping we could discuss the compensation. I\'m targeting [range]." Be specific about your value: reference unique skills, relevant experience, or competitive offers. Listen more than you talk.'
        },
        {
          heading: 'Beyond Base Salary',
          body: 'Total compensation includes: base salary, signing bonus, annual bonus, equity/RSUs, PTO, remote work flexibility, professional development budget, title, and review timeline. If the company can\'t move on base salary, negotiate these other components. A $5K signing bonus or 5 extra PTO days can be easier for companies to approve than a salary increase.'
        },
      ],
      tips: [
        'Never accept an offer on the spot — always ask for 24-48 hours to review.',
        'Practice your negotiation script out loud before the actual conversation.',
        'Frame requests in terms of value you bring, not personal needs ("I need more because my rent is high").',
        'If you have competing offers, mention them factually without ultimatums.',
        'Get the final agreement in writing before accepting.',
      ],
      faq: [
        { q: 'Will negotiating make the company rescind the offer?', a: 'Almost never. Professional, evidence-based negotiation is expected and respected. Companies invest significant time and money in the hiring process — they won\'t walk away because you asked. The rare exception is demanding far above market rate or being confrontational.' },
        { q: 'How much higher should I counter?', a: 'Typically 10-20% above the initial offer, depending on your research. If the offer is already at the top of market range, negotiate other components instead. Always anchor your counter to market data, not arbitrary numbers.' },
        { q: 'Should I negotiate if I\'m happy with the offer?', a: 'Consider it. Even a modest negotiation sets the tone for future compensation discussions. If the offer is genuinely at or above market rate and you\'re satisfied, it\'s okay to accept — just make sure you\'ve done the research to confirm.' },
      ],
    },
  },
  {
    slug: 'career-switch-guide',
    title: 'Career Switch Interview Guide',
    description: 'How to ace interviews when switching careers: framing transferable skills, addressing the "why" question, and overcoming experience gaps.',
    category: 'frameworks',
    keywords: ['career switch interview', 'career change interview', 'transferable skills', 'changing careers', 'career transition interview tips'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['storytelling'],
    relevantGoals: ['career_switch'],
    isCareerSwitcher: true,
    content: {
      intro: 'Switching careers is increasingly common and often valued by employers for the diverse perspective it brings. The key is framing your transition as a strength, not a liability. Here\'s how to interview with confidence when changing fields.',
      sections: [
        {
          heading: 'Framing Your Career Switch',
          body: 'Lead with your "why" — a clear, compelling narrative about what draws you to the new field. Connect the dots between your previous experience and the new role. Instead of apologizing for lacking direct experience, emphasize the unique perspective you bring. Example: "My 5 years in marketing gave me deep expertise in user psychology and data analysis — skills that directly apply to product management."'
        },
        {
          heading: 'Identifying Transferable Skills',
          body: 'Map your existing skills to the new role\'s requirements. Common transferable skills: project management, stakeholder communication, data analysis, problem-solving, team leadership, client management, and strategic thinking. For each skill, prepare a STAR story from your previous career that demonstrates it in action.'
        },
        {
          heading: 'Addressing the Experience Gap',
          body: 'Be proactive — don\'t wait for the interviewer to ask. Acknowledge the transition openly: "While I\'m new to [field], I\'ve taken concrete steps to bridge the gap." Then showcase: relevant courses/certifications, side projects, volunteer work, informational interviews, and industry knowledge. Show you\'re a fast learner with specific examples.'
        },
        {
          heading: 'Answering "Why the Switch?"',
          body: 'This is the most important question you\'ll face. Your answer should convey: genuine passion (not just dissatisfaction with your current role), informed decision-making (you\'ve done your research), concrete preparation (courses, projects, networking), and long-term commitment (this isn\'t a whim). Practice this answer until it\'s natural and compelling — it will likely come up multiple times.'
        },
      ],
      tips: [
        'Build credibility through visible actions: blog posts, open-source contributions, certifications, or volunteer projects in your target field.',
        'Network in your target industry before applying — referrals from insiders significantly improve your chances.',
        'Apply to companies known for valuing diverse backgrounds (many explicitly state this in job descriptions).',
        'Prepare to discuss how your unique background gives you an edge over traditional candidates.',
      ],
      faq: [
        { q: 'Will I have to take a pay cut when switching careers?', a: 'It depends on the industry and your transferable skills. Some transitions (e.g., marketing to product management) may not require a pay cut at all. For larger jumps, expect a potential 10-20% reduction initially, with rapid catch-up as you prove yourself. Negotiate based on your transferable skills, not just direct experience.' },
        { q: 'How do I address the "lack of experience" concern?', a: 'Reframe it: "I bring 7 years of experience in skills directly applicable to this role — project management, stakeholder communication, and data-driven decision making. What\'s different is the domain, and I\'ve invested [specific efforts] to bridge that gap." Show concrete examples of transferable impact.' },
        { q: 'Should I mention my career switch in my cover letter?', a: 'Absolutely — address it proactively and frame it positively. Your cover letter should tell the story of why this transition makes sense, what unique value you bring, and what steps you\'ve already taken. Don\'t let the interviewer discover your transition as a surprise.' },
      ],
    },
  },

  // ──────────────── COMPANY GUIDES ────────────────

  {
    slug: 'how-to-interview-at-google',
    title: 'How to Interview at Google: The Complete 2026 Guide',
    description: 'A complete guide to interviewing at Google in 2026 — the full hiring loop, what "Googleyness" actually means, the four scoring attributes, what the hiring committee looks for, and a 4-week prep plan that has worked for hundreds of candidates.',
    category: 'companies',
    keywords: ['google interview', 'googleyness', 'google behavioral interview', 'google interview process', 'google hiring committee', 'google interview prep'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['star_structure', 'specificity'],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'Google\'s interview process is the most studied and most imitated hiring system in tech, and also one of the most misunderstood. Unlike most companies, Google\'s hiring decision is made by a committee — not the hiring manager — using structured scorecards and a deliberately calibrated bar. Knowing exactly how that machine works is the difference between preparing for the *right* interview and preparing for an interview that does not exist. This guide breaks down the full Google loop, the four attributes you are scored on, what "Googleyness" really means in 2026, and a 4-week preparation plan.',
      sections: [
        {
          heading: 'The Full Google Hiring Loop, Step by Step',
          body: 'Google\'s end-to-end hiring process typically takes 4 to 8 weeks and follows the same structure across most non-leadership roles:\n\n1. **Recruiter screen (30 minutes).** A behavioral conversation about your background, interest in Google, salary expectations, and timing. Recruiters submit a brief writeup and either advance you or close the loop. This stage is more about logistics than evaluation, but a recruiter who is genuinely excited about your background can be a strong advocate later, so treat it like a real interview.\n\n2. **Phone or video technical screen (45 to 60 minutes).** One round, usually with a senior engineer or PM on the team you are interviewing for. For engineering candidates this is a coding interview on a shared editor; for PM candidates it is typically a product or analytical question. Pass rate at this stage is roughly 20 to 30 percent.\n\n3. **The on-site loop (4 to 5 interviews).** Historically in person at a Google campus, now mostly virtual. Each interview is 45 minutes. The mix depends on the role but typically includes 2 to 3 technical or role-specific rounds, 1 to 2 behavioral rounds, and sometimes a "Googleyness" round explicitly framed as cultural-fit. Each interviewer submits *independent* written feedback into a shared system after the loop ends.\n\n4. **Hiring committee review.** This is the step that makes Google different. After your loop, a committee of 3 to 5 senior Googlers — none of whom interviewed you — reads all the interviewer packets and makes the actual hire/no-hire decision. The hiring manager has input but cannot override the committee. This is why preparing well for *every* interviewer matters: you cannot win the loop with a champion who liked you, and you cannot lose it with a single bad day if the rest is strong.\n\n5. **Team matching.** Once approved by the committee, you are placed into a matching pool. Multiple teams may interview you for fit; you choose which to join. This step can add 2 to 6 weeks depending on availability. You can be hired by Google before being matched to a team.\n\n6. **Offer.** Negotiated through the recruiter, with the committee\'s level recommendation as the anchor.',
        },
        {
          heading: 'The Four Attributes Google Actually Scores You On',
          body: 'Forget the marketing language for a moment. Internally, every Google interviewer scores every candidate on four explicit attributes, and the hiring committee aggregates the scores across all interviewers. If you understand what these four are and what evidence each interviewer is hunting for, you can prepare deliberately for each one.\n\n**1. General Cognitive Ability (GCA).** Not IQ. This measures *how you think through ambiguous problems* — how you decompose them, what assumptions you state, how you handle being wrong, and how cleanly you communicate your reasoning. The signal Google is hunting for is "this person can learn anything we throw at them in 18 months." This is why they prefer open-ended problems with multiple reasonable answers over trivia questions.\n\n**2. Role-Related Knowledge (RRK).** Depth in the actual craft you would do on the job. For engineers this is data structures, system design, and language fluency. For PMs it is product sense and analytical rigor. Most candidates over-prepare RRK and under-prepare the other three attributes.\n\n**3. Leadership.** Both formal and informal. Google specifically looks for "emergent leadership" — the ability to step into ownership when a problem appears, then step back when someone better-positioned takes over. Senior IC candidates are scored on leadership too, not just managers.\n\n**4. Googleyness.** See the next section. This is the most misunderstood attribute and the one most candidates need to think about more carefully.',
          links: [
            { text: 'STAR Method Guide', href: '/learn/guides/star-method-guide' },
            { text: 'Behavioral Interview Questions', href: '/learn/guides/behavioral-questions' },
          ],
        },
        {
          heading: 'What "Googleyness" Actually Means in 2026',
          body: 'Googleyness is the cultural fit attribute, and it has been deliberately re-defined a few times over the past decade. In 2026, Google describes it as a combination of five behaviors that interviewers are explicitly told to score against:\n\n• **Intellectual humility.** Admitting what you do not know without making excuses for it. The phrase Google interviewers love to hear: "I don\'t know, but here is exactly how I would find out."\n\n• **Comfort with ambiguity.** Being able to make progress when the problem is not yet well-defined. A common interview probe: "What would you do if your manager left and the project priorities became unclear for two months?" Strong answers describe how you would act, not how you would wait.\n\n• **Collaborative nature.** Making the people around you better. Interviewers explicitly look for stories where you brought a quieter teammate into the conversation, mentored a junior colleague, or changed your own mind because of input from someone else.\n\n• **Conscientiousness.** Following through on commitments without being chased. Stories about quietly hitting deadlines and quietly catching mistakes score well here.\n\n• **Bias toward action.** Doing instead of planning. This is not "move fast and break things" — Google still values careful engineering — but it is the willingness to start before everything is perfect.\n\nThe trap to avoid: do not *say* the word "Googleyness." Show these qualities in your stories. Interviewers are trained to mark candidates who name-drop the framework as a small negative signal because it suggests memorization over genuine fit.',
        },
        {
          heading: 'The Behavioral Questions Google Asks Most Often',
          body: 'Google\'s behavioral interviewers are trained to push past the rehearsed answer and probe for specifics. Expect 2 to 4 follow-ups on every story you tell, often along the lines of "what was *your* role specifically?" or "what would you do differently now?" Prepare deeply, not broadly.\n\nThe themes that come up most often across the 4 to 5 interviews in your loop:\n\n1. *A time you handled ambiguity without clear direction.* Tests comfort-with-ambiguity. Strong answers show you acted while clarifying.\n\n2. *A time you influenced a decision without formal authority.* Tests informal leadership and collaboration. Strong answers show you did the work to bring others along, not that you bulldozed.\n\n3. *A time you scaled your impact beyond your immediate role.* Tests ownership and emergent leadership. Bonus points if the impact persisted after you left the project.\n\n4. *A time you failed and what you learned.* Tests intellectual humility. The trap is presenting a fake failure ("I worked too hard") — Google interviewers will probe relentlessly until they find the real one.\n\n5. *A time you changed your mind because of new information.* Tests intellectual humility from a different angle. Strong answers name what you used to believe, what changed your mind, and what you do differently now.\n\n6. *A time you advocated for the user against business pressure.* Tests user empathy. Particularly common for PM, design, and senior engineering candidates.\n\nPrepare 2 to 3 distinct STAR stories for each theme. Every story should have at least one quantitative result.',
          links: [
            { text: 'Behavioral Interview Questions', href: '/learn/guides/behavioral-questions' },
            { text: 'STAR Method Guide', href: '/learn/guides/star-method-guide' },
          ],
        },
        {
          heading: 'A 4-Week Preparation Plan',
          body: '**Week 1 — Foundation.** Read every public Google hiring resource (the Google careers blog, the rework.withgoogle.com structured-interviewing posts, and Lazlo Bock\'s book *Work Rules!*). Do a brutal honest self-audit against the four attributes — which are your weakest? Build a draft list of 12 behavioral stories.\n\n**Week 2 — Story library.** Write a one-page outline for each of your 12 stories: situation, task, your specific actions in 3 to 5 bullets, and at least one quantified result. Tag each story with the attributes it covers. Identify gaps — if you have no leadership story, find one in your last 2 years of work, even a small one.\n\n**Week 3 — Technical drilling.** For engineering candidates, do 2 to 3 LeetCode-style problems per day on a shared editor format, *out loud*, narrating your reasoning. For PMs, do 1 product-sense and 1 analytical question per day with the same out-loud narration. Record yourself if possible. The goal is not memorizing answers but training the *thinking-out-loud* habit Google interviewers reward.\n\n**Week 4 — Mock interviews.** Do at least 4 full mock interviews — 2 technical, 2 behavioral — with someone who can give you structured feedback. AI mock interviewers are excellent for pattern repetition; a real human is better for tone and nuance. After each mock, write down 3 things to fix and verify they are fixed in the next mock.',
        },
      ],
      tips: [
        'Show intellectual curiosity — ask thoughtful questions about the team and the role at the end of every interview. "What does success look like in the first 90 days?" is a strong opener.',
        'Use STAR for behavioral answers but emphasize the *why* behind your decisions, not just the what.',
        'Quantify impact in every Result. "Reduced p99 latency by 40 percent" beats "made things faster".',
        'Demonstrate collaboration explicitly — Google scores you for making others better, not just for personal heroics.',
        'Be comfortable saying "I don\'t know, but here is how I would find out." This is the single most Googley phrase you can use.',
        'Prepare for the hiring committee, not the interviewer. Each interviewer is scoring independently against a rubric, so consistency across all 4 to 5 conversations matters more than a single great moment.',
      ],
      faq: [
        { q: 'How long does the Google interview process take from start to offer?', a: 'Typically 4 to 8 weeks for the loop plus committee review, then 2 to 6 additional weeks for team matching. The whole process can take 6 to 14 weeks depending on which team you ultimately match with.' },
        { q: 'What is the Google hiring committee, and how is it different from a hiring manager interview?', a: 'Unlike most companies, Google\'s hire/no-hire decision is made by a committee of 3 to 5 senior Googlers — none of whom interviewed you. They read every interviewer\'s independent writeup and make the call. The hiring manager provides input but cannot override the committee. This is why you need to prepare equally well for every interviewer in the loop, not just the one who is closest to the team.' },
        { q: 'Can I re-apply to Google if I am rejected?', a: 'Yes. Google typically asks candidates to wait 6 to 12 months before re-applying. Use that time to address the specific feedback areas the recruiter shared with you and to build new experiences worth talking about. Re-applicants who have addressed real gaps often succeed on the second attempt.' },
        { q: 'What is the best way to prepare for Googleyness questions?', a: 'Stop trying to memorize the framework and start collecting real stories that demonstrate intellectual humility, comfort with ambiguity, collaboration, conscientiousness, and bias for action. The most common mistake is naming the attribute in your answer ("this shows my Googleyness because…"). Just tell the story; the interviewer is trained to score the qualities without you naming them.' },
        { q: 'Do I need a referral to interview at Google?', a: 'No, but it helps. A referral from a current Google employee gets your application a faster initial review and a slightly higher first-pass rate. Once you are in the loop, the referral does not influence the hiring committee.' },
        { q: 'How important is "leetcode practice" for Google engineering interviews?', a: 'Important but over-emphasized. Google interviewers are explicitly trained to score your *reasoning process*, not whether you produce the optimal solution. A candidate who narrates a clear approach, asks clarifying questions, and writes correct code at a moderate complexity level routinely scores higher than a candidate who silently produces an optimal solution. Practice problems for fluency, but practice talking through them out loud even more.' },
      ],
    },
  },
  {
    slug: 'amazon-leadership-principles-guide',
    title: 'Amazon Leadership Principles: The Complete Interview Guide (2026)',
    description: 'A complete guide to interviewing at Amazon in 2026: the 16 Leadership Principles in plain English, the Bar Raiser explained, the loop format, the most common LP questions, and a story-mapping system that builds the 30+ STAR stories Amazon expects from senior candidates.',
    category: 'companies',
    keywords: ['amazon interview', 'amazon leadership principles', 'amazon behavioral interview', 'bar raiser interview', 'amazon LP questions', '16 leadership principles'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['star_structure', 'ownership'],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'Amazon\'s interview process is built around one thing: the 16 Leadership Principles. Every behavioral question you will be asked maps to one or two of them, every interviewer in your loop is assigned a specific subset to evaluate, and the hiring decision is made primarily on how clearly your stories demonstrate the LPs in action. Almost everything else — the Bar Raiser, the loop format, the depth of follow-ups — is downstream of this core insight. Once you understand it, Amazon interview prep becomes a structured, almost mechanical exercise. This guide walks you through how the LPs map to the loop, how the Bar Raiser actually works, and the story-building system used by candidates who consistently land Amazon offers.',
      sections: [
        {
          heading: 'The Full Amazon Interview Loop',
          body: 'Amazon\'s end-to-end process is faster than most large-tech companies and runs in roughly four stages:\n\n1. **Recruiter screen (30 minutes).** Lightly behavioral, mostly logistics. Salary, timing, location, and a few quick questions about your background. Recruiters at Amazon are usually moving fast and prioritize clarity and fit over personality.\n\n2. **Phone interview with the hiring manager (45 to 60 minutes).** Already heavily LP-focused. You will get 3 to 5 behavioral questions explicitly tied to specific Leadership Principles, often without the LP being named. Pass rate at this stage is roughly 30 to 40 percent. The hiring manager is looking for whether your stories have enough depth and metrics to survive the loop.\n\n3. **The "loop" (4 to 5 interviews, 45 minutes each, usually in a single day).** Each interviewer is pre-assigned 2 to 3 LPs to evaluate. They will typically ask 2 to 3 behavioral questions per LP, with aggressive follow-ups. Expect at least one technical or role-specific round in the mix as well. The loop is virtual for most candidates and intentionally back-to-back to compress the experience.\n\n4. **Debrief and Bar Raiser sign-off.** After the loop, all interviewers meet in a debrief room (still done in real time at Amazon, unlike Google\'s asynchronous committee). Each interviewer presents their writeup and votes hire/no-hire. The Bar Raiser has veto power. A unanimous hire is rare; a 4-out-of-5 hire with a strong Bar Raiser endorsement is common.',
        },
        {
          heading: 'The 16 Leadership Principles, in Plain English',
          body: 'Amazon\'s 16 LPs are written in marketing language. Here is what each one is *actually* testing for in an interview, and which ones come up most often:\n\n**The "always tested" six:**\n\n• **Customer Obsession** — Did you start from the customer and work backwards? Or did you start from internal goals? Strong stories name a specific customer need, the data you used to validate it, and the trade-off you accepted to serve it.\n\n• **Ownership** — Did you act like the owner of the entire problem, or did you stay in your lane? Tested heavily for senior candidates. Strong stories show you doing things "above your pay grade" because they needed doing.\n\n• **Bias for Action** — Did you move when the path was unclear, or wait for permission? Calibrated speed, not recklessness. Strong stories explain the risk you accepted and how you managed the downside.\n\n• **Dive Deep** — Did you actually understand the data and the details, or did you skim? Tested by relentless follow-ups. Strong stories include specific numbers you remember without hesitation.\n\n• **Earn Trust** — Did you listen, speak candidly, and treat others well, especially under pressure? Strong stories include a moment where you said something hard but said it respectfully.\n\n• **Deliver Results** — Did you actually ship, with measurable impact? Tested in every story. Strong results have at least two distinct metrics — one for the immediate outcome and one for downstream effect.\n\n**The "frequently tested" five:**\n\n• **Are Right, A Lot** — judgment under uncertainty.\n• **Disagree and Commit** — productive disagreement followed by full commitment to the decision.\n• **Have Backbone; Disagree and Commit** — courage to push back on senior people.\n• **Insist on the Highest Standards** — refusing to ship below-bar work.\n• **Frugality** — doing more with less.\n\n**The "less common but still asked" five:**\n\n• Learn and Be Curious, Hire and Develop the Best, Think Big, Invent and Simplify, Strive to Be Earth\'s Best Employer.\n\n*(There are also two newer principles — Strive to Be Earth\'s Best Employer and Success and Scale Bring Broad Responsibility — added in 2021 but tested less frequently in early-career and IC loops.)*',
          links: [
            { text: 'STAR Method Guide', href: '/learn/guides/star-method-guide' },
          ],
        },
        {
          heading: 'The Bar Raiser, Explained',
          body: 'The Bar Raiser is a specially trained Amazon employee from *outside* the hiring team who participates in every loop. Their official job is to ensure that every new hire raises the average performance bar of the team they are joining — quantitatively, the candidate should be in the top 50 percent of people currently in the role. They have *veto power*: they can block a hire even if every other interviewer voted yes.\n\nIn practice, the Bar Raiser is the deepest probe of your interview day. They will pick the 1 or 2 most important Leadership Principles and ask 3 to 5 behavioral questions on each, with relentless follow-ups: "Tell me more about *your* specific role." "What did you do *next*?" "What was the metric exactly?" "What would you do *differently* if you ran this project again?"\n\nThe Bar Raiser is hunting for two specific signals: (1) the *depth* of your story — are these things you actually did, or are you reciting a polished summary that falls apart under pressure? — and (2) *self-awareness* — can you genuinely articulate what went wrong and what you learned, or do you blame circumstances and other people?\n\nThe candidates who pass the Bar Raiser most consistently do two things differently from the candidates who fail. First, they tell stories with *enough* specificity that follow-ups go deeper, not wider. ("The exact number was 38 percent, not 40 — I checked it last week.") Second, they answer "what would you do differently?" with a *real* alternative, not a humble brag. ("In hindsight I would have escalated to the VP two weeks earlier — I waited because I wanted to solve it within the team, but the delay cost us the launch window.")',
        },
        {
          heading: 'Story Mapping: The 30-Story System',
          body: 'Senior Amazon candidates routinely prepare 30 or more STAR stories. That sounds excessive until you do the math: 5 to 6 interviewers, 2 to 3 LPs per interviewer, 2 to 3 stories per LP. You are very likely to be asked 25 to 35 behavioral questions in one day, and you cannot reuse stories within the same loop because interviewers compare notes in the debrief.\n\nThe efficient way to build a 30-story library is to start from your *projects*, not from the LPs. List the 10 to 12 most significant work projects of the last 3 to 5 years. For each one, write a one-page outline: situation, your specific role, 4 to 6 actions in detail, and 2 to 3 quantified results. Then, for each project, identify which 3 to 5 Leadership Principles it could plausibly demonstrate. A single rich project can typically support stories for Customer Obsession, Ownership, Bias for Action, Dive Deep, and Deliver Results — five stories from one project, if you emphasize different actions and metrics.\n\nOnce you have your project library, do the inverse mapping: for each LP, which projects can you draw from? Aim for 2 to 3 distinct projects per "always tested" LP and 1 to 2 per "frequently tested" LP. You will end up with roughly 30 to 40 distinct stories from 10 to 12 projects, which is exactly what the loop demands.\n\nThe trap to avoid: do not prepare a different story for every single LP from scratch. You will run out of memory in the loop. Build deep familiarity with a smaller set of projects, then practice flexing them to whichever LP the interviewer asks about.',
          links: [
            { text: 'Behavioral Interview Questions', href: '/learn/guides/behavioral-questions' },
            { text: 'STAR Method Guide', href: '/learn/guides/star-method-guide' },
          ],
        },
        {
          heading: 'The Most Common LP Questions and How to Answer Them',
          body: 'Across hundreds of Amazon interview reports, a small number of questions come up over and over. Prepare a strong story for each before your loop:\n\n• *"Tell me about a time you went above and beyond for a customer."* (Customer Obsession.) Strong answers name a specific customer, the unmet need, the action you took outside your normal job description, and the result — both for the customer and the business.\n\n• *"Tell me about a time you took ownership of something that was not your responsibility."* (Ownership.) Strong answers show the gap you noticed, the cost of letting it sit, the work you did anyway, and what changed because of it.\n\n• *"Tell me about a time you disagreed with your manager."* (Have Backbone; Disagree and Commit.) Strong answers describe the disagreement factually, the data you used to make your case, the way you raised it respectfully, and crucially how you committed fully once the decision went the other way.\n\n• *"Tell me about a time you made a decision without enough data."* (Bias for Action.) Strong answers describe the cost of waiting, the risk you accepted, how you managed the downside, and what happened.\n\n• *"Tell me about a time you failed."* (Earn Trust + several other LPs.) Strong answers pick a real failure, take full ownership, name what you learned, and describe how you have applied it since. This question is asked in almost every Amazon loop.\n\n• *"Tell me about a time you had to dive into the details."* (Dive Deep.) Strong answers show you finding a specific data point or anomaly that other people had missed and acting on it.\n\n• *"Tell me about a time you had to deliver under pressure."* (Deliver Results.) Strong answers include both the constraint and at least two metrics in the result.',
        },
        {
          heading: 'A 4-Week Amazon Preparation Plan',
          body: '**Week 1 — Project library.** List 10 to 12 significant work projects from the last 3 to 5 years. Write a one-page outline for each: situation, your role, 4 to 6 specific actions, 2 to 3 quantified results. Do not worry about LPs yet.\n\n**Week 2 — LP mapping.** For each project, write down which 3 to 5 LPs it could demonstrate. Then do the inverse: for each "always tested" LP, list which projects you would use and why. Identify gaps and find or create stories to fill them — even small, recent stories are fine.\n\n**Week 3 — Story rehearsal.** Practice telling each story out loud on a 2-minute timer. After each story, practice answering 5 follow-up questions: "What was your specific role?", "What was the exact metric?", "What did you do next?", "What would you do differently?", "What did the team think of your decision?". Record yourself.\n\n**Week 4 — Mock loops.** Do at least 2 full mock loops — back-to-back 45-minute behavioral interviews, ideally with someone trained to probe Bar-Raiser-style. AI mock interviewers excel at the *aggressive follow-up* pattern Amazon uses, which is hard to replicate with friends.',
        },
      ],
      tips: [
        'Build a project library first, map LPs to projects second. You will end up with 30+ stories from 10 to 12 projects, which is exactly what the loop requires.',
        'Use specific metrics — "$2M revenue impact in Q3" beats "significant business impact" every time.',
        'Emphasize your *individual* contribution. Amazon Bar Raisers explicitly probe for "tell me what *you* specifically did" and mark down candidates who keep saying "we".',
        'Always have a real failure story ready. Amazon asks some variant of "tell me about a time you failed" in nearly every loop.',
        'Practice the follow-ups, not just the opening answer. The Bar Raiser will probe each story 3 to 5 layers deep.',
        'Do not name the LP in your answer. Just tell the story. Interviewers are explicitly trained to score for the principle without you flagging it.',
      ],
      faq: [
        { q: 'How many Leadership Principles should I actually prepare for?', a: 'All 16, but with very different depth. Prepare 2 to 3 strong stories each for the top 6 (Customer Obsession, Ownership, Bias for Action, Dive Deep, Earn Trust, Deliver Results). Prepare 1 to 2 stories each for the next 5 (Are Right A Lot, Disagree and Commit, Have Backbone, Insist on Highest Standards, Frugality). Have at least 1 story available for each of the remaining 5.' },
        { q: 'What does the Bar Raiser actually look for?', a: 'Two things specifically: depth and self-awareness. Depth means your story can survive 3 to 5 layers of follow-up questions without falling apart. Self-awareness means you can articulate what you did wrong and what you learned without blaming circumstances. The Bar Raiser is also explicitly looking for whether you would raise the team\'s average performance — they use a "top 50 percent of current people in this role" mental anchor.' },
        { q: 'How should I handle the "Disagree and Commit" question?', a: 'Show a time you disagreed with a decision, explained your reasoning with specific data, raised it respectfully through the right channel, and then — critically — committed *fully* once the decision was made. Amazon\'s phrase is "strong opinions, weakly held". The trap to avoid: telling a story where you disagreed and then secretly tried to undermine the decision. Bar Raisers spot this immediately.' },
        { q: 'Is the Bar Raiser allowed to veto a hire that all other interviewers approved?', a: 'Yes. The Bar Raiser has explicit veto power. In practice they use it sparingly — most loops resolve through consensus — but a strong "no" from the Bar Raiser will block the hire even if 4 of 5 interviewers voted yes.' },
        { q: 'How long does the Amazon interview process take from start to offer?', a: 'Faster than most large-tech companies. Typically 3 to 6 weeks from recruiter screen to offer. The loop itself is usually a single day. Amazon does not have a separate team-matching step like Google because hiring is team-specific from the start.' },
        { q: 'Do I need to memorize all 16 Leadership Principles word-for-word?', a: 'No, and it actively hurts you to recite them. What you do need is to understand what each principle is *testing for* in everyday work and to have stories that demonstrate the underlying behavior. Amazon interviewers are trained to mark candidates who name-drop the framework as a small negative signal.' },
      ],
    },
  },
  {
    slug: 'how-to-interview-at-meta',
    title: 'How to Interview at Meta — Complete Guide 2026',
    description: 'Prepare for Meta interviews with tips on demonstrating impact, moving fast, and navigating the behavioral and technical rounds.',
    category: 'companies',
    keywords: ['meta interview', 'facebook interview', 'meta behavioral interview', 'meta interview process'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['specificity', 'ownership'],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'Meta interviews focus on impact and scale. Behavioral rounds probe cultural fit with "Move Fast" and "Be Bold" values. The company values candidates who can articulate the business impact of their decisions and are comfortable making calls with incomplete information.',
      sections: [
        { heading: 'Interview Process', body: 'Meta\'s process: (1) Recruiter screen (30 min), (2) Technical phone screen (45 min), (3) On-site/virtual loop of 4-5 rounds including behavioral, technical, and system design. For non-engineering roles, expect case studies and execution-focused rounds. The process typically takes 3-6 weeks.' },
        { heading: 'Cultural Values to Demonstrate', body: 'Meta\'s core values: Move Fast (ship and iterate, don\'t wait for perfection), Be Bold (take risks, big bets over safe choices), Focus on Impact (prioritize the highest-leverage work), Be Open (transparent communication, give and receive feedback), Build Social Value (connect your work to broader mission). Show these in every answer.' },
        { heading: 'Common Question Themes', body: 'Meta interviews frequently cover: shipping at speed under constraints, measuring and articulating impact quantitatively, working with ambiguity at massive scale, cross-team collaboration in a flat organization, and making bold bets that didn\'t always pay off.' },
        { heading: 'Preparation Strategy', body: 'Quantify everything — Meta loves numbers. "Increased DAU by 12%" is much stronger than "improved engagement." Show comfort with ambiguity: describe situations where you made decisions without full information. Demonstrate speed: how you shipped something faster than expected. Research Meta\'s products deeply — show genuine interest in the platform ecosystem.' },
      ],
      tips: [
        'Quantify the impact of every story — revenue, users, time, percentage improvements.',
        'Show comfort making decisions with incomplete information.',
        'Demonstrate speed: "I shipped in 2 weeks instead of the planned 6."',
        'Meta values bold decisions — share a time you took a calculated risk.',
        'Research Meta\'s product ecosystem (Facebook, Instagram, WhatsApp, Reality Labs).',
      ],
      faq: [
        { q: 'Is Meta\'s interview different from when it was Facebook?', a: 'The core process is similar, but the culture has evolved. There\'s more emphasis on efficiency, impact per headcount, and bold decision-making since the Meta rebrand and organizational changes.' },
        { q: 'How important is product knowledge?', a: 'Very. Interviewers expect you to have opinions about Meta\'s products. Try using them actively before your interview and think critically about what you\'d improve.' },
      ],
    },
  },
  {
    slug: 'how-to-interview-at-apple',
    title: 'How to Interview at Apple — Complete Guide 2026',
    description: 'Navigate Apple\'s secretive interview process with insights on demonstrating craft, product passion, and attention to detail.',
    category: 'companies',
    keywords: ['apple interview', 'apple interview process', 'apple behavioral interview', 'apple hiring'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['specificity', 'star_structure'],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'Apple is famously secretive about its interview process. The company values craft, attention to detail, and genuine passion for creating excellent products. Behavioral questions probe how you balance perfectionism with pragmatic delivery.',
      sections: [
        { heading: 'Interview Process', body: 'Apple\'s process varies by team but typically includes: (1) Recruiter call, (2) Phone screen with hiring manager, (3) On-site/virtual loop of 5-8 interviews (yes, often more than FAANG peers). Interviews may span multiple days. Expect cross-functional interviewers from different teams. The process can take 4-8 weeks.' },
        { heading: 'What Apple Values', body: 'Apple\'s culture prioritizes: craft and quality (sweating the details others miss), secrecy and focus (doing fewer things but doing them exceptionally), user experience obsession (every pixel matters), simplicity (the ultimate sophistication), and cross-functional excellence (hardware + software + design thinking together).' },
        { heading: 'Common Question Themes', body: 'Apple interviews probe: attention to detail in your past work, genuine product passion (not just Apple products — any products you love and why), collaboration across disciplines (hardware, software, design), quality vs. speed tradeoffs (Apple often chooses quality), and simplicity in complex problem-solving.' },
        { heading: 'Preparation Strategy', body: 'Be ready to discuss products you love in detail — what makes them great, what you\'d improve. Show attention to detail in your own work: "I noticed a 2px misalignment that was causing a 3% drop in tap accuracy." Practice explaining how you balanced quality with deadlines. Research the specific team you\'re interviewing for — Apple teams operate quite independently.' },
      ],
      tips: [
        'Show genuine product passion — discuss products you love and why in detail.',
        'Demonstrate attention to detail with specific micro-examples.',
        'Apple values confidentiality — don\'t push for information about unannounced products.',
        'Balance perfectionism with pragmatism — show when you shipped "good enough."',
        'Research the specific team and product area you\'re interviewing for.',
      ],
      faq: [
        { q: 'Why does Apple have so many interview rounds?', a: 'Apple wants broad consensus. With 5-8 interviews, they ensure you\'ll work well across the cross-functional team. Each interviewer evaluates different aspects: technical skills, collaboration, craft, and cultural fit.' },
        { q: 'How secretive is the process really?', a: 'Very. Apple may not tell you the exact team or product until late in the process. Interviewers may be vague about what they\'re working on. This is normal — show that you respect the culture of confidentiality.' },
      ],
    },
  },
  {
    slug: 'how-to-interview-at-microsoft',
    title: 'How to Interview at Microsoft — Growth Mindset Guide 2026',
    description: 'Prepare for Microsoft interviews with tips on demonstrating growth mindset, inclusive leadership, and customer empathy.',
    category: 'companies',
    keywords: ['microsoft interview', 'microsoft growth mindset', 'microsoft behavioral interview'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['star_structure', 'specificity'],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'Microsoft\'s culture transformed under Satya Nadella to emphasize growth mindset. Interviews focus on learning from mistakes, empathy, collaboration, and inclusive leadership. The "One Microsoft" culture values cross-org collaboration over individual heroics.',
      sections: [
        { heading: 'Interview Process', body: 'Microsoft\'s process: (1) Recruiter screen, (2) Phone interview (45-60 min), (3) On-site/virtual loop of 4-5 interviews. The final interview is often with a senior leader ("As Appropriate" interview). Each interviewer evaluates different competencies. Process takes 3-6 weeks.' },
        { heading: 'Growth Mindset Culture', body: 'Growth mindset is the #1 cultural value at Microsoft. Interviewers look for: how you learned from failures (not just successes), curiosity about areas outside your expertise, willingness to be wrong and adapt, coaching and developing others, and treating challenges as learning opportunities rather than threats.' },
        { heading: 'Common Question Themes', body: 'Microsoft interviews frequently cover: learning from mistakes and changing your approach, inclusive leadership and supporting diverse teams, customer empathy and understanding user needs, cross-organization collaboration ("One Microsoft"), and demonstrating growth mindset in real situations.' },
        { heading: 'Preparation Strategy', body: 'Prepare stories about: a time you were wrong and what you learned, how you helped a colleague grow, when you sought feedback and acted on it, collaborating across teams with different priorities, and understanding a customer need that wasn\'t obvious. Show genuine curiosity in your questions to interviewers.' },
      ],
      tips: [
        'Lead with what you learned, not just what you achieved.',
        'Show how you\'ve helped others grow and succeed.',
        'Demonstrate curiosity — ask thoughtful questions about the team and technology.',
        'Microsoft values empathy — show you understand user and colleague perspectives.',
        'Mention cross-team collaboration and "One Microsoft" thinking.',
      ],
      faq: [
        { q: 'What is the "As Appropriate" (AA) interview?', a: 'The AA is the final interview with a senior leader who makes the hiring recommendation. They evaluate your overall fit, leadership potential, and alignment with Microsoft\'s culture. It\'s typically more conversational than technical.' },
        { q: 'How important is growth mindset really?', a: 'Extremely. It\'s not just a buzzword — interviewers are trained to assess it. Candidates who only talk about successes without demonstrating learning and adaptation are often flagged as lacking growth mindset.' },
      ],
    },
  },
  {
    slug: 'how-to-interview-at-netflix',
    title: 'How to Interview at Netflix — Freedom & Responsibility Guide 2026',
    description: 'Navigate Netflix\'s unique culture with tips on demonstrating independent judgment, candor, and high-performance standards.',
    category: 'companies',
    keywords: ['netflix interview', 'netflix culture', 'netflix freedom and responsibility', 'netflix interview process'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['ownership', 'specificity'],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'Netflix interviews are driven by their famous Culture Memo. The company values "Freedom and Responsibility," independent judgment, and radical candor. Interviewers expect candidates to articulate strong opinions and demonstrate high performance standards.',
      sections: [
        { heading: 'Interview Process', body: 'Netflix\'s process: (1) Recruiter screen, (2) Hiring manager phone call (exploratory), (3) On-site/virtual loop of 5-6 interviews. Netflix interviews are notably conversational — less structured than Amazon or Google. Interviewers assess cultural fit as heavily as technical ability.' },
        { heading: 'Netflix Culture Values', body: 'Key values: Freedom and Responsibility (autonomy with accountability), Context Not Control (leaders set context, not rules), Highly Aligned Loosely Coupled (strategic alignment with tactical freedom), Candor (honest, direct feedback), and the Keeper Test ("Would I fight to keep this person?"). Read the Culture Memo before your interview.' },
        { heading: 'Common Question Themes', body: 'Netflix interviews probe: independent judgment without waiting for permission, giving and receiving candid feedback (even uncomfortable), high performance standards and how you handle underperformance, strategic thinking and strong opinions, and innovation courage (taking bold action).' },
        { heading: 'Preparation Strategy', body: 'Read Netflix\'s Culture Memo thoroughly. Prepare stories about: making bold decisions independently, giving difficult feedback to a peer or manager, raising the performance bar on your team, forming and defending a strong opinion, and times you prioritized context over process. Netflix wants adults who thrive with freedom.' },
      ],
      tips: [
        'Read the Netflix Culture Memo before interviewing — interviewers will reference it.',
        'Show independent judgment — times you acted without waiting for permission.',
        'Demonstrate candor — share examples of giving honest, direct feedback.',
        'Netflix values strong opinions — don\'t be wishy-washy in your answers.',
        'Show you thrive with autonomy and hold yourself to high standards.',
      ],
      faq: [
        { q: 'What is the "Keeper Test"?', a: 'Netflix managers ask themselves: "If this person told me they were leaving, would I fight hard to keep them?" If the answer is no, the person should be let go with a generous severance. In interviews, this means you need to show you\'d be exceptional, not just adequate.' },
        { q: 'How candid should I really be?', a: 'Very. Netflix values radical honesty. If asked about a failure, don\'t sugarcoat it. If asked for your opinion, give a clear, reasoned perspective. Wishy-washy or politically safe answers are a red flag at Netflix.' },
      ],
    },
  },
  {
    slug: 'how-to-interview-at-stripe',
    title: 'How to Interview at Stripe — Craft & Systems Thinking Guide 2026',
    description: 'Prepare for Stripe interviews with tips on demonstrating craft, systems thinking, and clear written communication.',
    category: 'companies',
    keywords: ['stripe interview', 'stripe interview process', 'stripe culture', 'stripe hiring'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['specificity', 'star_structure'],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'Stripe sets a very high bar for craft and ownership. The company values clear writing, systems thinking, and genuine curiosity about payments infrastructure. Interviews often include take-home projects that demonstrate real work quality.',
      sections: [
        { heading: 'Interview Process', body: 'Stripe\'s process often includes: (1) Recruiter screen, (2) Phone interview, (3) Take-home project (1-3 hours), (4) On-site/virtual loop of 4-5 interviews including discussions of your take-home. The take-home is evaluated on code quality, documentation, and design thinking — not just correctness.' },
        { heading: 'What Stripe Values', body: 'Core values: Users First (obsess over developer experience), Move With Urgency (ship fast with quality), Think Rigorously (first-principles reasoning), Trust and Amplify (empower others), and Global Optimization (optimize for Stripe, not just your team). Stripe also heavily values written communication.' },
        { heading: 'Preparation Strategy', body: 'Practice writing clear technical documentation. Prepare stories about end-to-end ownership of a system or feature. Show systems thinking: how your decisions affected upstream and downstream teams. If doing a take-home, invest heavily in documentation, tests, and clean code — Stripe reviewers read everything carefully.' },
      ],
      tips: [
        'Stripe values clear writing — practice explaining complex concepts simply.',
        'Show end-to-end ownership: "I owned the system from design to production monitoring."',
        'Demonstrate systems thinking — consider second-order effects of decisions.',
        'Take-home projects: invest in documentation and code quality, not just features.',
        'Show genuine curiosity about payments, financial infrastructure, or developer tools.',
      ],
      faq: [
        { q: 'Do I need payments domain knowledge?', a: 'Not required, but showing genuine interest in payments infrastructure, fintech, or developer tools is a strong signal. Explore Stripe\'s documentation and products before your interview.' },
        { q: 'How important is the take-home project?', a: 'Very. It\'s often the foundation for on-site discussions. Treat it as a production deliverable: clean code, tests, README, and thoughtful design decisions documented clearly.' },
      ],
    },
  },
  {
    slug: 'how-to-interview-at-salesforce',
    title: 'How to Interview at Salesforce — Ohana Culture Guide 2026',
    description: 'Prepare for Salesforce interviews with tips on demonstrating trust, customer success, and values-driven leadership.',
    category: 'companies',
    keywords: ['salesforce interview', 'salesforce ohana', 'salesforce interview process', 'salesforce culture'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['star_structure', 'ownership'],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'Salesforce\'s "Ohana" (family) culture drives every interview. The company deeply values trust, customer success, innovation, and equality. Behavioral interviews assess whether you\'ll contribute to an inclusive, customer-obsessed team.',
      sections: [
        { heading: 'Interview Process', body: 'Salesforce\'s process: (1) Recruiter screen, (2) Hiring manager call, (3) Panel interview or virtual loop of 3-4 interviews. Technical interviews tend to be collaborative and practical. The process is generally faster than FAANG (2-4 weeks).' },
        { heading: 'Ohana Culture', body: 'Salesforce\'s values: Trust (the #1 value — integrity in everything), Customer Success (your success is our success), Innovation (continuous improvement and creativity), Equality (equal pay, diverse hiring, inclusive culture), and Sustainability (business as a platform for change). Interviewers evaluate cultural alignment seriously.' },
        { heading: 'Preparation Strategy', body: 'Prepare stories about: building trust with customers or stakeholders, driving customer outcomes beyond what was asked, inclusive leadership and supporting diverse teams, innovative solutions to business problems, and giving back to community or mentoring others. Salesforce values the whole person, not just technical skills.' },
      ],
      tips: [
        'Emphasize customer success stories with measurable outcomes.',
        'Show how you\'ve built trust across teams and with stakeholders.',
        'Salesforce values equality — share examples of inclusive behavior.',
        'Demonstrate you care about impact beyond just your immediate work.',
        'Research Salesforce\'s philanthropy model (1-1-1) and show values alignment.',
      ],
      faq: [
        { q: 'What is the 1-1-1 model?', a: 'Salesforce pledges 1% of equity, 1% of product, and 1% of employee time to philanthropy. Showing awareness of this model and genuine interest in social impact is a positive signal.' },
        { q: 'How values-driven is the interview really?', a: 'Very. Unlike pure performance-focused companies, Salesforce actively screens for cultural values alignment. A technically strong candidate who doesn\'t demonstrate trust, equality, or customer focus may not pass.' },
      ],
    },
  },
  {
    slug: 'mckinsey-interview-guide',
    title: 'McKinsey Interview Guide: Case Interview and PEI Mastery (2026)',
    description: 'A complete 2026 guide to the McKinsey interview: the full hiring process, the Case Interview format with hypothesis-driven structure, the Personal Experience Interview (PEI) and its three dimensions, the McKinsey Solve game, and a focused 6-week preparation plan.',
    category: 'companies',
    keywords: ['mckinsey interview', 'mckinsey case interview', 'mckinsey pei', 'mckinsey personal experience interview', 'consulting interview', 'mckinsey solve game', 'mckinsey hypothesis-driven case'],
    relevantDomains: ['business'],
    relevantExperience: [],
    relevantWeakAreas: ['star_structure', 'specificity'],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'McKinsey\'s interview process is the toughest in management consulting and one of the most structured of any company in the world. Every round combines two things: a Case Interview that tests your structured business thinking and a Personal Experience Interview (PEI) that probes your leadership, drive, and personal impact at a level of depth most candidates have never experienced. The bar is extremely high at every step. This guide walks through the full process, the actual mechanics of the case interview McKinsey uses today (which is *not* the same as the cases in older prep books), the three PEI dimensions, and a 6-week preparation plan that consistently produces offers.',
      sections: [
        {
          heading: 'The Full McKinsey Hiring Process',
          body: 'McKinsey\'s end-to-end process is more structured than almost any other employer and runs in five stages, typically over 6 to 12 weeks:\n\n1. **Resume screen.** McKinsey explicitly weights three things: academic performance, leadership, and impact. For undergraduate hires, GPA matters. For MBA hires, the school and ranking matter heavily. For experienced hires, the brand of your previous employer and the scale of your impact matter most. The pass rate at this stage is roughly 5 to 15 percent depending on the office and source.\n\n2. **Online assessment — the "Solve" game.** McKinsey replaced the old Problem Solving Test (PST) with a digital assessment called *Solve*. It is a 60 to 70 minute set of game-style scenarios — typically an "Ecosystem" task (build a sustainable food chain) and a "Redrock" or pattern-matching scenario. It tests systems thinking, decision-making under uncertainty, and pattern recognition. There are no traditional case questions and no math sections in Solve. Pass rate is roughly 30 to 40 percent of those who take it.\n\n3. **First round (2 interviews).** Each interview is ~40 minutes total: ~15 minutes of PEI + ~25 minutes of case. Two interviews back-to-back, one engagement manager and one senior associate, in a single half-day. The case is interactive — the interviewer leads you through a business problem, gives you data to analyze, and probes your reasoning at every step.\n\n4. **Final round (3 interviews).** Same format as the first round but with senior partners as interviewers. The bar rises noticeably — partners are explicitly looking for "future partner material," not just analytical fluency. Many candidates pass the first round and fall in the final round because they fail to convey leadership presence.\n\n5. **Offer and team matching.** Offers are extended within 1 to 2 weeks of the final round. McKinsey practices group placement — you join a "generalist" pool and pick projects with practice areas during your first 12 to 18 months.\n\nThe overall pass rate from application to offer is in the low single digits.',
        },
        {
          heading: 'The McKinsey Case Interview, Decoded',
          body: 'A McKinsey case interview is a *structured business problem* presented by the interviewer, with you working through it interactively over 25 minutes. The format is *not* the loose, candidate-led case style described in older prep books — McKinsey is now strictly *interviewer-led*. The interviewer asks you specific questions, hands you specific exhibits (charts, tables, data), and expects you to follow their lead while still demonstrating structured thinking.\n\nA typical case has five distinct phases:\n\n**1. The prompt (30 seconds).** The interviewer states the business problem in 2 to 3 sentences. Example: "Our client is a mid-size US airline considering whether to launch a low-cost carrier. They want to know whether they should proceed and, if so, how."\n\n**2. Clarification (1 to 2 minutes).** Ask 2 to 3 *specific* clarifying questions that show you are scoping the problem rigorously. Bad clarifications: "What is the timeline?". Good clarifications: "What does the client mean by \'low-cost\' — are they targeting Spirit/Frontier-style or Southwest-style?"\n\n**3. Structure (2 to 3 minutes).** The single most important moment in the case. Ask for 30 seconds to think, then present a clean, MECE (Mutually Exclusive, Collectively Exhaustive) structure for how you would approach the problem. Use 3 to 4 top-level branches. Bad: a generic profitability framework. Good: a structure tailored to *this specific* problem with branches like "Market opportunity", "Operating economics", "Strategic fit with existing operations", "Risk and feasibility".\n\n**4. Analysis (15 to 20 minutes).** The interviewer hands you exhibits and data. You compute, interpret, and draw insights. McKinsey expects mental math at moderate speed — percentages, market sizing, compound growth. Always *say what the number means* in business terms, not just the number itself.\n\n**5. Recommendation (1 to 2 minutes).** State your answer first (top-down). Then 2 to 3 reasons supporting it. Then 1 to 2 risks and how to mitigate them. Example: "Yes, the client should proceed — provided they can secure the regional airport slots. Three reasons: first, the addressable market is large; second, our cost structure is 22 percent below the incumbent; third, our brand can absorb the new offering. The biggest risk is regulatory delay on slot allocation, which I would recommend addressing in parallel with the operational planning."\n\nNotice the structure: *answer first, evidence second, risk third*. McKinsey calls this "top-down communication" and trains every consultant to use it. Demonstrating it in the interview is a strong signal that you would fit the firm.',
          links: [
            { text: 'Interview Frameworks', href: '/learn/guides/interview-frameworks' },
          ],
        },
        {
          heading: 'The Personal Experience Interview (PEI), Explained',
          body: 'The PEI is McKinsey\'s behavioral interview, but with a level of depth that makes most other companies\' behavioral rounds look superficial. Each PEI segment lasts about 15 minutes and focuses on *one* story. The interviewer will ask 10 to 15 follow-up questions about that single story — drilling into your specific role, your decision-making process, what others on the team thought, what you would do differently, and how the experience changed your behavior since.\n\nMcKinsey scores you on three dimensions, and you should expect at least one full PEI segment on each dimension across your loop:\n\n• **Personal Impact.** A time you influenced others without formal authority. The story should show you reading the room, building credibility, and changing someone\'s mind through data or persuasion — not through hierarchy. Strong stories include the moment you realized your initial approach was not working and pivoted.\n\n• **Entrepreneurial Drive.** A time you created something from nothing, or drove change in a context that did not require it. The story should show initiative, scrappiness, and willingness to take ownership of an outcome that was not handed to you. Strong stories include the obstacle you almost gave up at and how you got past it.\n\n• **Leadership.** A time you led a team through a meaningful challenge. The story should show how you set direction, built alignment, handled conflict, and supported individual team members. Strong stories include the moment you had to make an unpopular decision and how you communicated it.\n\nFor each dimension, prepare *2 to 3 distinct stories* — you cannot reuse one across the loop because the interviewers compare notes. That is 6 to 9 deeply detailed stories total.\n\nThe critical preparation insight: do not just memorize the stories. Prepare for the *follow-ups*. For each story, write down the answers to these questions in advance:\n\n• What was your *exact* role versus the team\'s role?\n• What did you do *first*, and why?\n• What did you do *next*, and how did your thinking change?\n• What was the alternative path you considered, and why did you reject it?\n• Who disagreed with you, and how did you handle it?\n• What did you learn, and how have you applied it since?\n• What would you do *differently* now, knowing what you know?\n• What did the result mean *quantitatively*?',
          links: [
            { text: 'Behavioral Interview Questions', href: '/learn/guides/behavioral-questions' },
            { text: 'STAR Method Guide', href: '/learn/guides/star-method-guide' },
          ],
        },
        {
          heading: 'The Three Things McKinsey Interviewers Are Actually Scoring',
          body: 'Both halves of the McKinsey interview — case and PEI — are scored against the same three underlying criteria. Understanding them shifts how you prepare:\n\n**1. Problem Solving.** Can you decompose an unfamiliar problem into a clean structure, then execute on the analysis? The case obviously tests this directly, but PEI does too: McKinsey looks for whether your past experiences include moments of structured thinking under pressure.\n\n**2. Personal Impact.** Can you communicate clearly, build trust quickly, and influence people who do not have to listen to you? The PEI tests this through your stories; the case tests it through how you present your structure and recommendation.\n\n**3. Leadership and Drive.** Will you actively drive change, take ownership, and act on your "obligation to dissent" — McKinsey\'s phrase for the responsibility every consultant has to speak up when they think the team is wrong? Tested in both halves.\n\nThe candidates who succeed at McKinsey are not the ones with the most polished cases. They are the ones who can demonstrate all three dimensions consistently across 5 interviews and 5 different interviewers. Build your prep around these three criteria, not around case frameworks.',
        },
        {
          heading: 'A 6-Week McKinsey Preparation Plan',
          body: '**Weeks 1 and 2 — Foundation.** Read *Case in Point* (Cosentino) and *Case Interview Secrets* (Cheng) to learn the basic case grammar. Do 5 to 10 cases at a slow pace, focusing on structure rather than speed. Start drafting your PEI stories — 2 to 3 per dimension. Take a Solve practice run if you have access to one.\n\n**Weeks 3 and 4 — Volume and feedback.** Do 20 to 25 cases with practice partners, ideally including 5 to 10 with someone who has actually worked at McKinsey or another MBB firm. Quality of the partner matters enormously here — you need someone who can probe your structure, not just read you a case. Continue refining your PEI stories with deep follow-up answers written out.\n\n**Weeks 5 and 6 — Polish.** Do 10 to 15 more cases at full interview pace (40 minutes including PEI). Practice the *transition* between PEI and case smoothly. Do 2 to 3 full mock interviews, ideally with a former MBB consultant. Record yourself if possible. The final week should be primarily about confidence and energy management, not new content.\n\n**Total cases for the 6-week plan:** 35 to 50. **Total PEI stories:** 6 to 9, with extensive follow-up answers prepared. **Total mock interviews:** 5 to 10, at least 2 with experienced consultants.',
        },
      ],
      tips: [
        'State your hypothesis upfront in every case — McKinsey values top-down communication.',
        'For PEI, prepare for the follow-ups, not the opening answer. Expect 10 to 15 follow-up questions per story.',
        'Practice mental math daily: percentages, market sizing, compound growth, percent change.',
        'Show "obligation to dissent" — find a story where you respectfully pushed back on someone senior.',
        'Structure everything before diving in. Asking for 30 seconds to think is *not* a weakness signal — it is exactly what real consultants do on the job.',
        'Pace yourself across the loop. Final-round candidates often peak in interview 2 and crash in interview 5. Sleep, eat, and reset between rounds.',
      ],
      faq: [
        { q: 'How many cases should I actually practice for McKinsey?', a: '30 to 50 cases is the realistic range. Quality matters more than quantity — debrief each case carefully and identify the specific gap that surfaced. Most candidates over-index on volume and under-index on deliberate practice with skilled partners.' },
        { q: 'What is the McKinsey Solve game and how should I prepare for it?', a: 'Solve is McKinsey\'s replacement for the old Problem Solving Test. It is a 60 to 70 minute online assessment with game-style scenarios — typically an "Ecosystem" task and a pattern-matching scenario like "Redrock". It tests systems thinking and decision-making under uncertainty, not traditional business analysis. The best preparation is to time yourself on a few practice sets, learn the format, and stay calm under the time pressure. There is no shortcut: McKinsey deliberately makes the time tight.' },
        { q: 'How is McKinsey case style different from older case interview prep books?', a: 'Older books like *Case in Point* describe candidate-led cases where you frame the problem and drive the analysis. Today\'s McKinsey cases are *strictly* interviewer-led — the interviewer drives the flow and hands you specific exhibits. You should still propose a structure and a recommendation, but follow the interviewer\'s pace rather than charging ahead.' },
        { q: 'How do I prepare for the depth of PEI follow-up questions?', a: 'For each of your 6 to 9 PEI stories, write out the answers to 8 to 10 anticipated follow-up questions in advance. Then practice telling each story with someone who is briefed to interrupt and probe — "what was *your* role exactly?", "why did you do that and not the alternative?", "what did your manager think?". The goal is to have so much depth in each story that you can answer 15 minutes of probing without running out of detail.' },
        { q: 'What is McKinsey\'s "obligation to dissent" and how do I demonstrate it?', a: '"Obligation to dissent" is a phrase McKinsey uses for the responsibility every consultant has to speak up when they think the team is wrong, even if the speaker is junior. To demonstrate it in PEI, prepare a story where you respectfully pushed back on someone senior — using data, framed constructively — and explain what happened. Bonus points if you describe how you committed fully to the eventual decision once it was made.' },
        { q: 'How long does the McKinsey interview process take from application to offer?', a: 'Typically 6 to 12 weeks. Resume screen and Solve assessment take 2 to 4 weeks. First round and final round are usually scheduled 2 to 3 weeks apart. Offer extension is fast — usually within a week of the final round.' },
      ],
    },
  },
  {
    slug: 'bcg-interview-guide',
    title: 'BCG Interview Guide — Creative Problem-Solving 2026',
    description: 'Prepare for BCG interviews with tips on creative case approaches, hypothesis-driven thinking, and behavioral questions.',
    category: 'companies',
    keywords: ['bcg interview', 'bcg case interview', 'boston consulting group interview', 'consulting interview'],
    relevantDomains: ['business'],
    relevantExperience: [],
    relevantWeakAreas: ['star_structure', 'specificity'],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'BCG interviews are similar to McKinsey but value more creative, less formulaic approaches. The firm prizes original thinking, intellectual curiosity, and the ability to push back on assumptions. BCG cases tend to be more open-ended and conversational.',
      sections: [
        { heading: 'Interview Process', body: 'BCG\'s process: (1) Resume screen + online assessment (BCG Casey chatbot), (2) First round — 2 interviews with case + behavioral, (3) Final round — 2-3 interviews with senior partners. BCG also offers "BCG Pymetrics" digital assessment for some roles.' },
        { heading: 'What Makes BCG Different', body: 'BCG values creative thinking over rigid frameworks. While structure matters, interviewers want to see: original insights (not just textbook frameworks), hypothesis-driven approaches (form a view early, then test it), willingness to challenge assumptions, and collaborative problem-solving (the interview is a dialogue, not a presentation).' },
        { heading: 'Preparation Strategy', body: 'Practice cases with a creative twist — go beyond profit trees and market-sizing. Form hypotheses early and test them. Show intellectual curiosity: "What if we looked at this differently?" Practice collaborative casing — BCG interviewers actively participate. Prepare behavioral stories that show diverse thinking and unconventional approaches.' },
      ],
      tips: [
        'Go beyond standard frameworks — BCG values original, creative thinking.',
        'Form hypotheses early and explicitly state them: "My hypothesis is X because..."',
        'The case is a conversation — engage the interviewer, ask their opinion.',
        'Show intellectual curiosity — explore unexpected angles.',
        'BCG values diversity of thought — bring your unique perspective.',
      ],
      faq: [
        { q: 'How is BCG different from McKinsey cases?', a: 'BCG cases tend to be more open-ended and conversational. McKinsey expects more structured, top-down communication. BCG values creative insights over perfect structure. Both require strong analytical skills.' },
        { q: 'What is BCG Casey?', a: 'BCG Casey is a chatbot-based case assessment. You solve a mini-case by interacting with an AI chatbot. It evaluates your structuring ability, analytical skills, and business judgment in a timed format.' },
      ],
    },
  },
  {
    slug: 'goldman-sachs-interview-guide',
    title: 'Goldman Sachs Interview Guide — Super Day Preparation 2026',
    description: 'Navigate Goldman Sachs\' Super Day interview format with tips on technical finance questions, market awareness, and behavioral preparation.',
    category: 'companies',
    keywords: ['goldman sachs interview', 'goldman sachs super day', 'investment banking interview', 'finance interview'],
    relevantDomains: ['finance'],
    relevantExperience: [],
    relevantWeakAreas: ['specificity', 'star_structure'],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'Goldman Sachs interviews blend technical finance questions with behavioral assessment. The "Super Day" consists of multiple back-to-back interviews. The firm values work ethic, attention to detail, analytical rigor, and deep market awareness.',
      sections: [
        { heading: 'Interview Process', body: 'Goldman Sachs process: (1) HireVue video interview (pre-recorded responses), (2) First round phone interviews (1-2 calls), (3) "Super Day" — 4-6 back-to-back interviews in one day with different team members. Each interview is 30-45 minutes. The Super Day is physically and mentally demanding.' },
        { heading: 'What Goldman Looks For', body: 'Core qualities: Client service mindset (clients come first), Excellence (never settle for good enough), Integrity (do the right thing), Teamwork (succeed together under pressure), Commercial mindset (understand how the business makes money). Technical knowledge is expected — you must know finance fundamentals cold.' },
        { heading: 'Preparation Strategy', body: 'Stay current on markets — read WSJ/FT daily for 2 weeks before your interview. Know: recent IPOs, M&A deals, market trends, and Goldman\'s recent transactions. For behavioral: prepare STAR stories about teamwork under pressure, attention to detail, and client focus. For technical: review financial modeling, DCF, accounting concepts, and market analysis.' },
      ],
      tips: [
        'Stay current on financial markets — expect "What\'s happening in the markets?" questions.',
        'Know Goldman\'s recent deals and transactions.',
        'Super Day is a marathon — maintain energy and enthusiasm through all rounds.',
        'Show analytical rigor with specific numbers and financial metrics.',
        'Dress formally — Goldman maintains a professional dress code culture.',
      ],
      faq: [
        { q: 'What is the HireVue interview?', a: 'Goldman\'s first screen is a recorded video interview where you answer 3-5 questions on camera. There\'s no live interviewer — you record responses within a time limit. Focus on clear, structured answers with strong eye contact.' },
        { q: 'How do I prepare for the Super Day?', a: 'Treat it like a final exam: study technical concepts, prepare 10+ behavioral stories, get a good night\'s sleep, bring water and snacks. Each interviewer asks different questions, so your stories need variety. Stay energetic and engaged through all 4-6 rounds.' },
      ],
    },
  },
  {
    slug: 'jpmorgan-interview-guide',
    title: 'JPMorgan Interview Guide — Risk & Analytics Focus 2026',
    description: 'Prepare for JPMorgan interviews with tips on demonstrating risk awareness, analytical rigor, and client relationship skills.',
    category: 'companies',
    keywords: ['jpmorgan interview', 'jp morgan interview', 'chase interview', 'banking interview'],
    relevantDomains: ['finance'],
    relevantExperience: [],
    relevantWeakAreas: ['specificity', 'star_structure'],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'JPMorgan interviews mix technical assessment with behavioral evaluation. The firm values risk awareness, analytical thinking, client relationship skills, and integrity. Market knowledge and awareness of the regulatory landscape are important differentiators.',
      sections: [
        { heading: 'Interview Process', body: 'JPMorgan\'s process: (1) Online application + HireVue, (2) Phone screen with recruiter, (3) Super Day or panel interview (3-5 rounds). The process varies by division (Investment Banking, Asset Management, Technology, etc.). Technology roles include coding assessments.' },
        { heading: 'What JPMorgan Values', body: 'Core qualities: Client focus (understanding and serving client needs), Risk management (aware of risks in every decision), Analytical rigor (data-driven, precise thinking), Integrity (do the right thing even when it\'s hard), Innovation (modernizing banking with technology). JPMorgan also values diversity and community involvement.' },
        { heading: 'Preparation Strategy', body: 'Know the division you\'re interviewing for — JPMorgan is massive and each division has different priorities. Stay current on financial markets and regulations. Prepare stories about: risk assessment in decisions, analytical problem-solving with data, client relationship management, and ethical decision-making. Research JPMorgan\'s recent technology investments and transformation initiatives.' },
      ],
      tips: [
        'Know which division you\'re interviewing for and tailor your preparation.',
        'Demonstrate risk awareness — show you consider downside scenarios.',
        'JPMorgan values analytical rigor — use numbers and data in your stories.',
        'Research their technology transformation (blockchain, AI, cloud initiatives).',
        'Show client focus and relationship-building skills.',
      ],
      faq: [
        { q: 'How does JPMorgan\'s interview differ by division?', a: 'Investment Banking focuses on financial modeling and deal knowledge. Asset Management emphasizes market analysis and client relationships. Technology requires coding assessments and system design. All divisions assess behavioral fit and risk awareness.' },
        { q: 'Do I need to know about regulations?', a: 'Basic awareness of key regulations (Dodd-Frank, Basel III, SOX) shows you understand the banking landscape. You don\'t need to be a regulatory expert, but showing awareness is a strong signal.' },
      ],
    },
  },
]

export function getResourceBySlug(slug: string): Resource | undefined {
  return RESOURCES.find(r => r.slug === slug)
}

export function getResourcesByCategory(category: Resource['category']): Resource[] {
  return RESOURCES.filter(r => r.category === category)
}

export function getAllSlugs(): string[] {
  return RESOURCES.map(r => r.slug)
}

export interface UserProfile {
  targetRole?: string
  experienceLevel?: string
  interviewGoal?: string
  weakAreas?: string[]
  isCareerSwitcher?: boolean
}

export function calculateRelevance(resource: Resource, profile: UserProfile): number {
  let score = 0
  if (resource.relevantDomains.length === 0 || (profile.targetRole && resource.relevantDomains.includes(profile.targetRole))) {
    score += resource.relevantDomains.length > 0 ? 3 : 0
  }
  if (resource.relevantExperience.length === 0 || (profile.experienceLevel && resource.relevantExperience.includes(profile.experienceLevel))) {
    score += resource.relevantExperience.length > 0 ? 2 : 0
  }
  if (profile.weakAreas && resource.relevantWeakAreas.some(w => profile.weakAreas!.includes(w))) {
    score += 4
  }
  if (profile.interviewGoal && resource.relevantGoals.includes(profile.interviewGoal)) {
    score += 3
  }
  if (resource.isCareerSwitcher && profile.isCareerSwitcher) {
    score += 5
  }
  return score
}

export function getPersonalizedResources(profile: UserProfile | null): Resource[] {
  if (!profile) return RESOURCES
  return [...RESOURCES].sort((a, b) => calculateRelevance(b, profile) - calculateRelevance(a, profile))
}
