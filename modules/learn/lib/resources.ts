// ─── Resource Hub Data ──────────────────────────────────────────────────────
// Single source of truth for all self-serve learning content.
// Used by: resource pages (SSR/SEO), homepage personalization, footer links, sitemap.

export interface ResourceFAQ {
  q: string
  a: string
}

export interface ResourceSection {
  heading: string
  body: string
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
    title: 'Behavioral Interview Questions',
    description: 'Learn how to answer behavioral interview questions using the STAR method with real examples for leadership, teamwork, conflict resolution, and more.',
    category: 'questions',
    keywords: ['behavioral interview questions', 'STAR method examples', 'tell me about a time', 'situational interview questions', 'competency-based questions'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['star_structure', 'storytelling', 'specificity'],
    relevantGoals: ['improve_scores', 'general_practice'],
    content: {
      intro: 'Behavioral questions ask you to describe past experiences to predict future performance. They typically start with "Tell me about a time when..." and are best answered using structured frameworks like STAR (Situation, Task, Action, Result).',
      sections: [
        {
          heading: 'What Are Behavioral Interview Questions?',
          body: 'Behavioral interview questions are based on the premise that past behavior is the best predictor of future performance. Instead of asking hypothetical "what would you do" questions, interviewers ask about specific situations you\'ve actually experienced. Common themes include leadership, teamwork, conflict resolution, failure, and initiative.'
        },
        {
          heading: 'The STAR Method Explained',
          body: 'STAR stands for Situation, Task, Action, Result. Start by setting the scene (Situation), explain your specific responsibility (Task), describe exactly what you did (Action — this should be the longest part), and share the measurable outcome (Result). Always quantify results when possible: "increased revenue by 15%" is more impactful than "improved sales."'
        },
        {
          heading: 'Leadership & Teamwork Questions',
          body: '"Tell me about a time you led a team through a difficult project." Focus on how you communicated vision, delegated tasks, handled disagreements, and supported team members. Show both strategic thinking and empathy. Include metrics like team size, timeline, and measurable outcomes.'
        },
        {
          heading: 'Conflict Resolution Questions',
          body: '"Describe a time you had a disagreement with a colleague." The key is showing emotional intelligence and professionalism. Explain the situation factually, how you sought to understand the other perspective, the specific steps you took to resolve the conflict, and what you learned from the experience.'
        },
        {
          heading: 'Failure & Growth Questions',
          body: '"Tell me about a time you failed." This tests self-awareness and resilience. Choose a genuine failure (not a disguised success), take ownership without making excuses, explain what you learned, and — critically — show how you applied that learning to future situations. The growth matters more than the failure itself.'
        },
      ],
      tips: [
        'Prepare 8-10 detailed stories from your career that cover different competencies — you can adapt them to various questions.',
        'Always quantify your results: numbers, percentages, and timelines make your answers more credible.',
        'Focus 60% of your answer on the Action step — this is where interviewers learn most about you.',
        'Use "I" instead of "we" to clearly show your personal contribution.',
        'Practice transitioning between stories smoothly so your delivery feels natural, not rehearsed.',
      ],
      faq: [
        { q: 'How is the STAR method different from just telling a story?', a: 'STAR provides a clear structure that ensures you cover all key elements interviewers are evaluating. Without it, candidates often spend too long on context and not enough on their specific actions and results. STAR keeps you focused and concise.' },
        { q: 'What if I don\'t have relevant work experience for a behavioral question?', a: 'Draw from academic projects, volunteer work, internships, or personal projects. The principles of leadership, teamwork, and problem-solving apply across contexts. Just be transparent: "In my university capstone project, I..."' },
        { q: 'How many STAR stories should I prepare?', a: 'Prepare 8-10 versatile stories that cover: leadership, teamwork, conflict, failure, initiative, time pressure, stakeholder management, and technical problem-solving. Each story can often be adapted to answer 2-3 different question types.' },
        { q: 'Should I always use STAR for every question?', a: 'STAR is ideal for behavioral questions. For other question types (hypothetical, technical, or opinion-based), other frameworks may be more appropriate. Use STAR when the question asks about a specific past experience.' },
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
    title: 'STAR Method Guide',
    description: 'Master the STAR interview method (Situation, Task, Action, Result) with examples, templates, and practice exercises for behavioral interviews.',
    category: 'frameworks',
    keywords: ['STAR method', 'STAR interview technique', 'situation task action result', 'behavioral interview framework', 'STAR method examples'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['star_structure', 'specificity', 'storytelling'],
    relevantGoals: ['improve_scores', 'general_practice'],
    content: {
      intro: 'The STAR method is the gold standard for answering behavioral interview questions. It provides a clear framework that ensures your answers are structured, specific, and impactful.',
      sections: [
        {
          heading: 'S — Situation: Set the Scene',
          body: 'Briefly describe the context. Include: where you were working, the team/project involved, and why the situation was significant. Keep this to 2-3 sentences. The goal is to give enough context for the interviewer to understand the challenge, without over-explaining. Example: "At my previous company, our team of 8 engineers was tasked with migrating our legacy payment system to a new microservices architecture under a 3-month deadline."'
        },
        {
          heading: 'T — Task: Define Your Responsibility',
          body: 'Clarify your specific role and what was expected of you. Differentiate between the team\'s goal and your personal responsibility. This shows ownership and helps the interviewer understand the scope of your contribution. Example: "As the tech lead, I was responsible for designing the migration plan, coordinating with the payments team, and ensuring zero downtime during the transition."'
        },
        {
          heading: 'A — Action: What You Did (The Main Event)',
          body: 'This is the most important part — spend 60% of your answer here. Describe the specific steps you took. Use "I" instead of "we." Explain your reasoning and decision-making process. Include obstacles you overcame. Show skills relevant to the job you\'re interviewing for. Example: "I first mapped all dependencies and identified three critical integration points. I then proposed a phased migration approach..."'
        },
        {
          heading: 'R — Result: Quantify the Impact',
          body: 'Share the outcome with specific metrics whenever possible. Include both direct results and broader impact. If the result wasn\'t entirely positive, explain what you learned and how you applied it. Example: "The migration was completed 2 weeks ahead of schedule with zero customer-facing downtime. Processing speed improved by 40%, and the new architecture reduced maintenance costs by $50K annually."'
        },
        {
          heading: 'STAR in Practice: Full Example',
          body: 'Question: "Tell me about a time you had to meet a tight deadline."\n\nS: "Last year, our team received an urgent request from our biggest client to implement a custom reporting feature within 2 weeks — a project that would normally take 6 weeks."\n\nT: "As the project lead, I needed to scope the work, get stakeholder buy-in on a phased delivery approach, and coordinate 4 developers."\n\nA: "I immediately broke the feature into must-have and nice-to-have components. I negotiated with the client to deliver core functionality in 2 weeks with enhancements in phase 2. I restructured sprint assignments, set up daily 15-minute standups, and personally took on the most complex integration work."\n\nR: "We delivered the core feature on time. The client was so pleased with the transparency and speed that they expanded their contract by 30%. The phased approach became our standard template for urgent requests."'
        },
      ],
      tips: [
        'Write out 8-10 STAR stories before your interview, covering different competencies.',
        'Keep the Situation and Task brief (30 seconds each). Spend most time on Action (90 seconds) and Result (30 seconds).',
        'Always quantify your Result — use numbers, percentages, timelines, or dollar amounts.',
        'Practice transitions like "Specifically, what I did was..." to keep your stories flowing naturally.',
      ],
      faq: [
        { q: 'What\'s the ideal length for a STAR answer?', a: 'Aim for 2-3 minutes total. Situation: 15-30 seconds. Task: 15-30 seconds. Action: 60-90 seconds. Result: 15-30 seconds. If the interviewer wants more detail, they\'ll ask follow-up questions.' },
        { q: 'Can I use the same STAR story for different questions?', a: 'Yes, with modifications. A good story about leading a project can answer questions about leadership, tight deadlines, teamwork, or stakeholder management — just emphasize different aspects. Prepare versatile stories that can be adapted.' },
        { q: 'What if my result wasn\'t positive?', a: 'Failure stories are valuable. Share what happened honestly, take ownership, and — most importantly — explain what you learned and how you\'ve applied that learning since. Interviewers respect self-awareness and growth more than a perfect track record.' },
        { q: 'How is STAR different from SPAR or CAR?', a: 'SPAR (Situation, Problem, Action, Result) emphasizes the problem more explicitly. CAR (Challenge, Action, Result) is a condensed version. All follow the same principle: context → your action → the outcome. STAR is the most widely recognized and recommended by interviewers.' },
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
    title: 'How to Interview at Google — Complete Guide 2026',
    description: 'Master the Google interview process with insider tips on Googleyness, structured interviews, and what hiring committees look for.',
    category: 'companies',
    keywords: ['google interview', 'googleyness', 'google behavioral interview', 'google interview process'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['star_structure', 'specificity'],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'Google uses structured interviews with scorecards. Behavioral questions evaluate "Googleyness" — intellectual humility, collaboration, and comfort with ambiguity. Technical rounds emphasize your problem-solving approach over memorized answers.',
      sections: [
        { heading: 'Interview Process', body: 'Google\'s hiring process typically includes: (1) Recruiter phone screen (30 min), (2) Phone/video technical screen (45 min), (3) On-site loop of 4-5 interviews (behavioral + technical), (4) Hiring committee review, (5) Team matching, (6) Offer. The entire process takes 4-8 weeks. A "bar raiser" interviewer may be present to maintain hiring standards.' },
        { heading: 'What Is Googleyness?', body: 'Googleyness is Google\'s cultural fit assessment. It measures: intellectual humility (admitting what you don\'t know), comfort with ambiguity (thriving without clear direction), collaborative nature (making others around you better), conscientiousness (following through on commitments), and bias toward action (doing rather than just planning). Weave these qualities into every answer.' },
        { heading: 'Common Question Themes', body: 'Google behavioral interviews frequently cover: handling ambiguity without clear direction, influencing without authority across teams, scaling your impact beyond your immediate role, learning from failures and iterating, and demonstrating user empathy in decision-making. Prepare 2-3 strong STAR stories for each theme.' },
        { heading: 'What Interviewers Look For', body: 'Google interviewers score candidates on structured scorecards. They evaluate: general cognitive ability (problem-solving approach, not trivia), role-related knowledge (depth in your domain), leadership (formal and informal), and Googleyness (cultural alignment). Each interviewer submits independent feedback to the hiring committee.' },
        { heading: 'Preparation Strategy', body: 'Research Google\'s products and recent initiatives. Practice explaining technical concepts to non-technical audiences. Prepare stories that demonstrate cross-functional collaboration. Quantify your impact with specific metrics. Practice thinking aloud — Google values seeing your reasoning process, not just your conclusions.' },
      ],
      tips: [
        'Show intellectual curiosity — ask thoughtful questions about the role and team.',
        'Use the STAR format but emphasize the "why" behind your decisions.',
        'Quantify impact: "improved latency by 40%" beats "made things faster."',
        'Demonstrate collaboration — Google values making others better.',
        'Be comfortable saying "I don\'t know, but here\'s how I\'d find out."',
      ],
      faq: [
        { q: 'How long does the Google interview process take?', a: 'Typically 4-8 weeks from first contact to offer. The on-site loop is usually scheduled within 2-3 weeks of passing the phone screen. Hiring committee review can add 1-2 weeks.' },
        { q: 'What is the Google hiring committee?', a: 'Unlike most companies, Google\'s hiring decision is made by a committee (not the hiring manager). This committee reviews all interviewer feedback to make an unbiased decision, which is why each interviewer scores independently.' },
        { q: 'Can I re-apply to Google if I\'m rejected?', a: 'Yes — Google typically asks candidates to wait 6-12 months before reapplying. Use this time to address specific feedback areas and build new experiences to discuss.' },
      ],
    },
  },
  {
    slug: 'amazon-leadership-principles-guide',
    title: 'Amazon Interview Guide — Leadership Principles Mastery 2026',
    description: 'Ace the Amazon interview by mastering the 16 Leadership Principles with STAR-format answers, bar raiser tips, and LP-specific preparation.',
    category: 'companies',
    keywords: ['amazon interview', 'amazon leadership principles', 'amazon behavioral interview', 'bar raiser interview'],
    relevantDomains: [],
    relevantExperience: [],
    relevantWeakAreas: ['star_structure', 'ownership'],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'Amazon interviews are driven entirely by their 16 Leadership Principles (LPs). Every behavioral answer should map to 1-2 LPs. The STAR format is essential — Amazon interviewers are trained to probe for specific data points, metrics, and your individual contribution.',
      sections: [
        { heading: 'Interview Process', body: 'Amazon\'s process: (1) Recruiter screen (30 min), (2) Phone interview with hiring manager (45-60 min, LP-focused), (3) "Loop" day — 4-5 back-to-back interviews (45 min each), including a Bar Raiser. Each interviewer is assigned 2-3 LPs to evaluate. The loop typically happens in one day (virtual or on-site).' },
        { heading: 'Key Leadership Principles', body: 'The most frequently tested LPs: Customer Obsession (start with the customer and work backwards), Ownership (think long-term, act on behalf of the entire company), Bias for Action (speed matters — many decisions are reversible), Dive Deep (leaders operate at all levels and audit frequently), Earn Trust (listen attentively, speak candidly, treat others respectfully), Deliver Results (focus on key inputs and deliver with the right quality and timeliness).' },
        { heading: 'The Bar Raiser', body: 'One interviewer in your loop is a "Bar Raiser" — a specially trained interviewer from outside the hiring team. Their job is to ensure Amazon\'s hiring bar stays high. They have veto power. The Bar Raiser evaluates whether you raise the bar for at least 50% of people in the role. They probe deeply and ask tough follow-up questions.' },
        { heading: 'Common Question Themes', body: 'Amazon loves: customer obsession examples with real customer data, situations where you disagreed with your manager (Disagree and Commit), times you made a frugal decision (Frugality), diving deep into data to solve a problem, and earning trust across teams. Every question maps to 1-2 LPs.' },
        { heading: 'Preparation Strategy', body: 'Prepare 2-3 STAR stories per LP (that\'s 30+ stories). Each story should include specific metrics (revenue, users, time saved). Practice connecting stories to LPs explicitly: "This demonstrates Customer Obsession because..." Prepare for aggressive follow-ups — Amazon interviewers dig deep with "Tell me more about YOUR role specifically."' },
      ],
      tips: [
        'Start every answer by connecting to a Leadership Principle.',
        'Use specific metrics: "$2M revenue impact" not "significant impact."',
        'Emphasize YOUR individual contribution, not the team\'s.',
        'Prepare for "Tell me about a time you failed" — Amazon loves failure + learning stories.',
        'The Bar Raiser will probe hard — have depth in every story.',
      ],
      faq: [
        { q: 'How many Leadership Principles should I prepare for?', a: 'All 16, but focus on the top 6: Customer Obsession, Ownership, Bias for Action, Dive Deep, Earn Trust, and Deliver Results. These come up most frequently.' },
        { q: 'What does the Bar Raiser look for?', a: 'The Bar Raiser evaluates whether you\'d raise the average performance bar. They look for strong LP examples with depth, self-awareness, and genuine ownership. They also check for red flags like blame-shifting or vague answers.' },
        { q: 'How should I handle the "Disagree and Commit" question?', a: 'Show a time you disagreed with a decision, explained your reasoning with data, but ultimately committed fully once the decision was made. Amazon values strong opinions loosely held.' },
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
    title: 'McKinsey Interview Guide — Case & PEI Mastery 2026',
    description: 'Master McKinsey\'s case interview and Personal Experience Interview (PEI) with frameworks, tips, and preparation strategies.',
    category: 'companies',
    keywords: ['mckinsey interview', 'mckinsey case interview', 'mckinsey pei', 'consulting interview'],
    relevantDomains: ['business'],
    relevantExperience: [],
    relevantWeakAreas: ['star_structure', 'specificity'],
    relevantGoals: ['first_interview', 'general_practice'],
    content: {
      intro: 'McKinsey interviews combine Case Interviews (structured problem-solving) with the Personal Experience Interview (PEI). Cases test your analytical and structured thinking. PEI probes leadership, personal impact, and entrepreneurial drive using deep behavioral questions.',
      sections: [
        { heading: 'Interview Process', body: 'McKinsey\'s process: (1) Resume screen and online assessment (PST or Solve game), (2) First round — 2 interviews (1 case + 1 PEI each), (3) Final round — 3 interviews (same format, senior partners). Each interview is ~40 minutes: ~15 min PEI + ~25 min case. The bar is extremely high at every stage.' },
        { heading: 'The Case Interview', body: 'Case interviews present a business problem (e.g., "Should this airline launch a low-cost carrier?"). You must: clarify the problem, propose a structured framework, analyze data provided, synthesize findings, and deliver a recommendation. McKinsey expects top-down communication — state your answer first, then support it.' },
        { heading: 'The PEI (Personal Experience Interview)', body: 'PEI evaluates three dimensions: (1) Personal Impact — a time you influenced others without authority, (2) Entrepreneurial Drive — a time you created something from nothing or drove change, (3) Leadership — a time you led a team through a challenge. Prepare 2-3 detailed stories for each. McKinsey probes deeply — expect 10+ follow-up questions per story.' },
        { heading: 'Preparation Strategy', body: 'For cases: practice 30-50 cases using frameworks (profitability, market entry, pricing). Master mental math. Practice top-down communication. For PEI: prepare 6-9 deeply detailed stories. Practice telling each story in 2 minutes, then be ready for 10 minutes of follow-ups. McKinsey values "obligation to dissent" — show you speak up when you disagree.' },
      ],
      tips: [
        'State your hypothesis upfront in cases — McKinsey values top-down communication.',
        'For PEI, prepare stories with extreme depth — expect 10+ follow-up questions.',
        'Practice mental math: percentages, market sizing, compound growth.',
        'Show "obligation to dissent" — times you respectfully pushed back.',
        'Structure is king — always lay out your approach before diving into analysis.',
      ],
      faq: [
        { q: 'How many cases should I practice?', a: '30-50 cases minimum. Focus on quality over quantity — debrief each case to understand what you could improve. Practice with partners who can give real-time feedback.' },
        { q: 'What is the McKinsey Solve game?', a: 'McKinsey replaced the Problem Solving Test (PST) with an online assessment called "Solve." It includes ecosystem-building and pattern-matching games that evaluate problem-solving, decision-making, and systems thinking.' },
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
