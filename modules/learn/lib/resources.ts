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
  category: 'questions' | 'tips' | 'frameworks'
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
    relevantDomains: ['swe', 'ds', 'devops'],
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
]

// ─── Helper Functions ────────────────────────────────────────────────────────

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
