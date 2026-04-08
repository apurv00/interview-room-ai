import Link from 'next/link'

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-white px-4 py-16 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold text-[#0f1419] mb-8">Privacy Policy</h1>
      <p className="text-sm text-[#8b98a5] mb-10">Last updated: April 2026</p>

      <div className="space-y-8 text-sm text-[#536471] leading-relaxed">
        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">1. Information We Collect</h2>
          <ul className="list-disc pl-5 space-y-2 text-[#536471]">
            <li><strong className="text-[#0f1419]">Account information:</strong> Name, email address, and profile photo when you sign in with Google, GitHub, or email.</li>
            <li><strong className="text-[#0f1419]">Interview data:</strong> Audio/video recordings, transcripts, and feedback generated during mock interview sessions.</li>
            <li><strong className="text-[#0f1419]">Uploaded documents:</strong> Job descriptions and resumes you upload to personalize your sessions.</li>
            <li><strong className="text-[#0f1419]">Usage data:</strong> Pages visited, session counts, and feature usage to improve the service.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">2. How We Use Your Information</h2>
          <ul className="list-disc pl-5 space-y-2 text-[#536471]">
            <li>To provide AI-powered interview practice and generate personalized feedback.</li>
            <li>To track your progress and interview history across sessions.</li>
            <li>To improve our AI models and interview question quality.</li>
            <li>To communicate service updates and respond to support requests.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">3. Third-Party Services</h2>
          <p className="text-[#536471]">
            We use the following third-party services to operate Interview Prep Guru. Where a service receives your interview audio, video, or transcript, that is noted explicitly below.
          </p>
          <ul className="list-disc pl-5 space-y-2 text-[#536471] mt-2">
            <li><strong className="text-[#0f1419]">Authentication providers:</strong> Google and GitHub OAuth for sign-in.</li>
            <li><strong className="text-[#0f1419]">Anthropic (Claude):</strong> Generates interview questions, real-time coaching, scoring, and post-interview fusion analysis. Receives your interview transcript, aggregated facial and voice signals, and any job description or resume text you provide. Anthropic does not use this data to train their models under our API terms.</li>
            <li><strong className="text-[#0f1419]">OpenAI:</strong> Used for select content-generation tasks on the learning side of the product. Does not receive your interview recordings.</li>
            <li><strong className="text-[#0f1419]">Deepgram:</strong> Real-time speech-to-text during live interviews. Receives your raw microphone audio over an encrypted WebSocket while a session is active. Audio is processed in-flight and not retained by Deepgram under our agreement.</li>
            <li><strong className="text-[#0f1419]">Groq:</strong> Used as a fallback transcription path for older sessions recorded before our live-transcript pipeline. Receives an audio recording of the interview when that fallback runs. This path is being retired.</li>
            <li><strong className="text-[#0f1419]">MediaPipe (Google):</strong> Face-landmark and expression detection. The MediaPipe model file and WebAssembly runtime are delivered from Google&rsquo;s CDN (<code className="text-xs">storage.googleapis.com</code>, <code className="text-xs">cdn.jsdelivr.net</code>), but <strong className="text-[#0f1419]">all inference runs inside your browser</strong>. Your camera feed and facial landmarks are never transmitted to Google. Google&rsquo;s CDN sees only the request for the model file itself.</li>
            <li><strong className="text-[#0f1419]">Cloudflare R2:</strong> Storage for any interview video or audio you choose to record, plus the compact JSON of facial-landmark summaries used for post-interview analysis.</li>
            <li><strong className="text-[#0f1419]">MongoDB Atlas &amp; Redis:</strong> Primary database and session/rate-limit store for interview metadata, transcripts, feedback, and usage tracking.</li>
            <li><strong className="text-[#0f1419]">Payment processing:</strong> Stripe for subscription billing (Pro plan).</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">4. Data Retention</h2>
          <p className="text-[#536471]">
            Interview recordings, landmark JSON, transcripts, and feedback are stored indefinitely while your account is active. You can delete individual interview records from your <Link href="/history" className="text-[#2563eb] hover:text-blue-700">history page</Link>, which removes the corresponding recordings from Cloudflare R2 as well. If you delete your account from <Link href="/settings" className="text-[#2563eb] hover:text-blue-700">account settings</Link>, all associated data will be permanently removed within 30 days.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">5. Data Security</h2>
          <p className="text-[#536471]">
            We use industry-standard encryption (TLS) for data in transit and encrypt sensitive data at rest. Access to user data is restricted to authorized personnel only.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">6. Your Rights</h2>
          <p className="text-[#536471]">
            You have the right to access, correct, or delete your personal data at any time. You can manage your data from your <Link href="/settings" className="text-[#2563eb] hover:text-blue-700">account settings</Link> or by contacting us directly.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">7. Contact</h2>
          <p className="text-[#536471]">
            For privacy-related questions, contact us at{' '}
            <a href="mailto:privacy@interviewprep.guru" className="text-[#2563eb] hover:text-blue-700">privacy@interviewprep.guru</a>.
          </p>
        </section>
      </div>

      <div className="mt-12 pt-8 border-t border-[#e1e8ed] text-sm text-[#8b98a5]">
        <Link href="/" className="text-[#2563eb] hover:text-blue-700 transition">
          ← Back to home
        </Link>
      </div>
    </main>
  )
}
