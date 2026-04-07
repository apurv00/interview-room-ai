'use client'

import { useState, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuthGate } from '@shared/providers/AuthGateProvider'
import { track } from '@shared/analytics/track'
import {
  Play, Eye, Mic, Brain, Activity,
  ChevronRight, CheckCircle2, User,
  AlertTriangle, TrendingDown, TrendingUp, BarChart3,
  MonitorPlay, Sparkles, FileText, BookOpen, RotateCcw, ArrowRight
} from 'lucide-react'

interface HeroTab {
  icon: React.ReactNode
  label: string
}

interface ScoreMetric {
  label: string
  score: number
  color: string
}

interface JourneyStep {
  step: string
  title: string
  desc: string
  icon: React.ReactNode
  iconBg: string
  /** Either a regular path, or `'__cta__'` to trigger the start-interview auth gate. */
  href: string
  label: string
  core?: boolean
}

export default function MarketingHomepage() {
  const [activeTab, setActiveTab] = useState(0)
  const router = useRouter()
  const { requireAuth } = useAuthGate()

  // Single hero/CTA click handler. Authenticated users go straight into
  // the interview setup; anonymous users see the auth modal first and
  // are redirected to setup once they sign in.
  const handleStartCta = useCallback(() => {
    track('cta_clicked', { cta: 'start_interview', location: 'marketing_home' })
    requireAuth('start_interview', () => router.push('/interview/setup'))
  }, [requireAuth, router])

  // Sentinel used inside the JourneyStep array below to mark steps that
  // should trigger handleStartCta instead of a normal navigation.
  const CTA_SENTINEL = '__cta__'

  const heroTabs: HeroTab[] = [
    { icon: <Mic className="w-4 h-4" />, label: 'Live Interview' },
    { icon: <MonitorPlay className="w-4 h-4" />, label: 'AI Replay' },
    { icon: <BarChart3 className="w-4 h-4" />, label: 'Scoring' },
  ]

  return (
    <div className="bg-slate-50 text-slate-900 font-sans selection:bg-blue-500/20">

      {/* ── FOLD 1: HERO ── */}
      <section className="relative pt-12 pb-16 lg:pt-24 lg:pb-24 bg-white overflow-hidden">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="grid md:grid-cols-2 gap-10 md:gap-12 items-center">

            <div className="max-w-xl">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-50 border border-blue-100 text-blue-600 text-[11px] font-semibold uppercase tracking-wider mb-6">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
                AI-Powered Interview Coaching
              </div>

              <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-slate-900 leading-[1.1] mb-5">
                You bombed your last interview.{' '}
                <span className="text-blue-600">You just don&apos;t know why yet.</span>
              </h1>

              <p className="text-base text-slate-500 leading-relaxed mb-8">
                AI that tracks your facial expressions, voice patterns, and answer quality simultaneously — then gives you a second-by-second replay showing the exact moment your confidence dropped, your pace doubled, and your answer lost structure.
              </p>

              <button
                type="button"
                onClick={handleStartCta}
                className="inline-block px-8 py-3.5 text-[15px] font-semibold rounded-full bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-600/20 transition-all text-center"
              >
                Take Your First Interview — Free
              </button>
              <p className="mt-4 text-sm text-slate-400">No credit card · No downloads · Takes 30 seconds to start</p>

              <div className="mt-10 pt-8 border-t border-slate-200 grid grid-cols-3 gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-indigo-50 flex items-center justify-center flex-shrink-0">
                    <Eye className="w-4 h-4 text-indigo-600" />
                  </div>
                  <div>
                    <div className="text-xl font-extrabold text-slate-800 leading-none">147</div>
                    <div className="text-[11px] text-slate-400 font-medium mt-0.5">Facial Landmarks</div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-cyan-50 flex items-center justify-center flex-shrink-0">
                    <Mic className="w-4 h-4 text-cyan-600" />
                  </div>
                  <div>
                    <div className="text-xl font-extrabold text-slate-800 leading-none">12</div>
                    <div className="text-[11px] text-slate-400 font-medium mt-0.5">Vocal Metrics</div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
                    <Brain className="w-4 h-4 text-emerald-600" />
                  </div>
                  <div>
                    <div className="text-xl font-extrabold text-slate-800 leading-none">5</div>
                    <div className="text-[11px] text-slate-400 font-medium mt-0.5">Answer Dimensions</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Tabbed Product Preview */}
            <div className="relative w-full max-w-lg mx-auto md:max-w-none">
              <div className="rounded-2xl bg-white border border-slate-200 shadow-xl shadow-slate-200/50 overflow-hidden">
                <div className="flex p-2 gap-1.5 bg-slate-50 border-b border-slate-100">
                  {heroTabs.map((tab, i) => (
                    <button
                      key={i}
                      onClick={() => setActiveTab(i)}
                      className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-[12px] font-semibold rounded-xl transition-all ${
                        activeTab === i
                          ? 'bg-white text-slate-800 shadow-sm border border-slate-200'
                          : 'text-slate-400 hover:text-slate-600'
                      }`}
                    >
                      {tab.icon}
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="relative bg-slate-50 overflow-hidden" style={{ minHeight: '440px' }}>
                  {/* TAB 1: Live Interview */}
                  <div className={`absolute inset-0 p-4 flex flex-col transition-opacity duration-300 ${activeTab === 0 ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
                    <div className="flex-1 flex gap-3">
                      <div className="relative flex-1 bg-white border border-slate-200 rounded-xl flex flex-col items-center justify-center">
                        <div className="w-14 h-14 rounded-xl bg-blue-50 flex items-center justify-center">
                          <Sparkles className="w-7 h-7 text-blue-500" />
                        </div>
                        <div className="absolute bottom-3 bg-white border border-slate-100 shadow-sm px-2.5 py-1 rounded-full text-[10px] font-medium text-slate-500 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span> AI Interviewer
                        </div>
                      </div>
                      <div className="relative flex-1 bg-slate-100 border border-slate-200 rounded-xl flex flex-col items-center justify-center">
                        <div className="w-14 h-14 rounded-full bg-slate-200 flex items-center justify-center">
                          <User className="w-7 h-7 text-slate-400" />
                        </div>
                        <div className="absolute top-3 right-3 flex flex-col gap-1.5 w-28">
                          <div className="bg-white border border-slate-200 p-1.5 rounded-lg shadow-sm">
                            <div className="flex justify-between text-[9px] font-medium text-slate-500 mb-0.5"><span>Eye Contact</span><span>92%</span></div>
                            <div className="h-1 bg-slate-100 rounded-full"><div className="h-full bg-green-500 rounded-full" style={{ width: '92%' }}></div></div>
                          </div>
                          <div className="bg-white border border-slate-200 p-1.5 rounded-lg shadow-sm">
                            <div className="flex justify-between text-[9px] font-medium text-slate-500 mb-0.5"><span>Pace</span><span>140 wpm</span></div>
                            <div className="h-1 bg-slate-100 rounded-full"><div className="h-full bg-blue-500 rounded-full" style={{ width: '60%' }}></div></div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 bg-white border border-slate-200 shadow-sm p-3 rounded-xl">
                      <p className="text-[13px] text-slate-700 leading-relaxed">
                        &quot;I led the migration to microservices, which <span className="bg-amber-100 text-amber-700 px-1 rounded">like</span> reduced our latency by 40%...&quot;
                      </p>
                    </div>
                  </div>

                  {/* TAB 2: AI Replay */}
                  <div className={`absolute inset-0 p-4 flex flex-col gap-3 transition-opacity duration-300 ${activeTab === 1 ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
                    <div className="flex-1 bg-slate-800 rounded-xl relative flex items-center justify-center">
                      <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center">
                        <Play className="w-5 h-5 text-white ml-0.5" />
                      </div>
                      <div className="absolute top-3 left-3 text-[10px] font-medium text-slate-400 bg-slate-900/80 px-2 py-1 rounded">Q2 · System Design</div>
                      <div className="absolute top-3 right-3 bg-red-500 text-white px-2 py-1 rounded text-[10px] font-semibold flex items-center gap-1">
                        <Activity className="w-3 h-3" /> Pace Warning
                      </div>
                    </div>
                    <div className="bg-white border border-slate-200 shadow-sm p-4 rounded-xl">
                      <div className="relative h-1.5 bg-slate-100 rounded-full mb-4">
                        <div className="absolute top-0 left-0 h-full w-1/3 bg-blue-500 rounded-full"></div>
                        <div className="absolute top-1/2 -translate-y-1/2 left-[15%] w-2.5 h-2.5 bg-amber-500 rounded-full border-2 border-white shadow-sm"></div>
                        <div className="absolute top-1/2 -translate-y-1/2 left-[33%] w-3 h-3 bg-red-500 rounded-full border-2 border-white shadow-md"></div>
                        <div className="absolute top-1/2 -translate-y-1/2 left-[58%] w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-white shadow-sm"></div>
                      </div>
                      <div className="flex items-start gap-2.5 p-2.5 bg-red-50 border border-red-100 rounded-lg">
                        <div className="bg-white border border-red-200 text-red-600 font-mono text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5 font-semibold">2:34</div>
                        <div>
                          <h5 className="text-slate-800 font-semibold text-[11px] mb-0.5">Confidence dip detected</h5>
                          <p className="text-slate-500 text-[10px] leading-snug">Eye contact dropped to 20%. Pace doubled to 182 wpm.</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* TAB 3: Scoring */}
                  <div className={`absolute inset-0 p-4 flex flex-col justify-center transition-opacity duration-300 ${activeTab === 2 ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
                    <div className="bg-white border border-slate-200 shadow-sm rounded-xl p-5 h-full flex flex-col">
                      <div className="flex justify-between items-center mb-4 pb-4 border-b border-slate-100">
                        <div>
                          <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Overall Score</div>
                          <div className="text-3xl font-extrabold text-slate-800">78<span className="text-lg text-slate-400">/100</span></div>
                        </div>
                        <div className="w-10 h-10 rounded-full bg-emerald-50 flex items-center justify-center">
                          <TrendingUp className="w-5 h-5 text-emerald-500" />
                        </div>
                      </div>
                      <div className="space-y-3 flex-1">
                        {([
                          { label: 'Relevance', score: 85, color: 'bg-emerald-500' },
                          { label: 'STAR Structure', score: 78, color: 'bg-blue-500' },
                          { label: 'Specificity', score: 41, color: 'bg-red-500' },
                          { label: 'Ownership', score: 72, color: 'bg-amber-500' },
                          { label: 'JD Alignment', score: 88, color: 'bg-emerald-500' },
                        ] as ScoreMetric[]).map((m, i) => (
                          <div key={i}>
                            <div className="flex justify-between text-[11px] mb-1">
                              <span className="text-slate-500 font-medium">{m.label}</span>
                              <span className="text-slate-700 font-semibold">{m.score}</span>
                            </div>
                            <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${m.color}`} style={{ width: `${m.score}%` }}></div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="mt-3 pt-3 border-t border-slate-100 text-[10px] text-red-500 flex items-center gap-1.5 font-medium">
                        <TrendingDown className="w-3 h-3" /> Specificity: &quot;improved performance&quot; → add concrete metrics
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── FOLD 2: THREE AI SYSTEMS ── */}
      <section className="py-20 bg-slate-50 border-y border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl mb-14">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-600 mb-2">
              3 AI Systems · 1 Session · 0 Guesswork
            </p>
            <h2 className="text-3xl md:text-4xl font-extrabold text-slate-900 mb-3">
              Every other interview tool reads your text. We read <em className="text-blue-600 not-italic">you</em>.
            </h2>
            <p className="text-slate-500 text-base">
              Three specialized analysis pipelines run in parallel during every session. No other interview tool does this.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-5">
            {/* Card 1: Face */}
            <div className="bg-white border border-slate-200 rounded-2xl p-6 hover:shadow-lg hover:shadow-slate-200/50 transition-all flex flex-col">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center mb-5">
                <Eye className="w-5 h-5 text-indigo-600" />
              </div>
              <h3 className="text-lg font-bold text-slate-800 mb-2">Facial Expression Analysis</h3>
              <p className="text-[14px] text-slate-500 leading-relaxed mb-1">
                Your eyes dart left every time you improvise. Your jaw tightens on questions you didn&apos;t prep for. You&apos;ve done this in every real interview. No one told you — until now.
              </p>
              <p className="text-[11px] font-mono text-slate-400 mb-5">
                Computer Vision · 147 landmarks · Real-time coaching nudges
              </p>
              <div className="mt-auto bg-slate-50 border border-slate-200 rounded-xl p-4">
                <div className="space-y-2.5">
                  <div className="flex justify-between items-center text-[12px]">
                    <span className="text-slate-500 font-medium">Eye Contact</span>
                    <span className="text-red-500 font-semibold font-mono">Dropped — 20%</span>
                  </div>
                  <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                    <div className="bg-red-500 h-full rounded-full" style={{ width: '20%' }}></div>
                  </div>
                  <div className="flex items-center gap-2 bg-red-50 border border-red-100 text-red-600 p-2.5 rounded-lg text-[12px] font-medium">
                    <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                    Look back at the camera — 8 seconds away
                  </div>
                </div>
              </div>
            </div>

            {/* Card 2: Voice */}
            <div className="bg-white border border-slate-200 rounded-2xl p-6 hover:shadow-lg hover:shadow-slate-200/50 transition-all flex flex-col">
              <div className="w-10 h-10 rounded-xl bg-cyan-50 flex items-center justify-center mb-5">
                <Mic className="w-5 h-5 text-cyan-600" />
              </div>
              <h3 className="text-lg font-bold text-slate-800 mb-2">Voice Pattern Analysis</h3>
              <p className="text-[14px] text-slate-500 leading-relaxed mb-1">
                You said &quot;um&quot; fourteen times in six minutes. Your pace hit 180 wpm the moment they asked about leadership. That four-second silence sounded like panic, not thought. We caught all of it.
              </p>
              <p className="text-[11px] font-mono text-slate-400 mb-5">
                Streaming speech-to-text · Pace, fillers, confidence markers
              </p>
              <div className="mt-auto bg-slate-50 border border-slate-200 rounded-xl p-4">
                <div className="space-y-2.5">
                  <div className="flex justify-between items-center text-[12px]">
                    <span className="text-slate-500 font-medium">Speaking Pace</span>
                    <span className="text-cyan-600 font-semibold font-mono">182 wpm ↑</span>
                  </div>
                  <div className="flex items-end gap-[3px] h-8 px-1">
                    {[35, 55, 25, 75, 100, 85, 60, 95, 70, 40, 90, 65].map((h, i) => (
                      <div
                        key={i}
                        className="flex-1 rounded-t-sm"
                        style={{
                          height: `${h}%`,
                          backgroundColor: h > 80 ? 'rgba(245,158,11,0.5)' : 'rgba(8,145,178,0.25)',
                        }}
                      ></div>
                    ))}
                  </div>
                  <div className="text-[12px] text-slate-500 font-medium">
                    <span className="text-amber-600 font-semibold">14 filler words</span> detected · Pace spiked at Q3
                  </div>
                </div>
              </div>
            </div>

            {/* Card 3: Content */}
            <div className="bg-white border border-slate-200 rounded-2xl p-6 hover:shadow-lg hover:shadow-slate-200/50 transition-all flex flex-col">
              <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center mb-5">
                <Brain className="w-5 h-5 text-emerald-600" />
              </div>
              <h3 className="text-lg font-bold text-slate-800 mb-2">Answer Intelligence</h3>
              <p className="text-[14px] text-slate-500 leading-relaxed mb-1">
                You said &quot;improved performance&quot; when you should have said &quot;reduced p95 latency from 800ms to 120ms across 3 services.&quot; The scoring is honest — even when your friends aren&apos;t.
              </p>
              <p className="text-[11px] font-mono text-slate-400 mb-5">
                5-dimension scoring · STAR analysis · Per-question with follow-ups
              </p>
              <div className="mt-auto bg-slate-50 border border-slate-200 rounded-xl p-4">
                <div className="space-y-2">
                  {([
                    { label: 'Relevance', score: 85, color: 'emerald' },
                    { label: 'Structure', score: 78, color: 'emerald' },
                    { label: 'Specificity', score: 41, color: 'red' },
                    { label: 'Ownership', score: 72, color: 'amber' },
                  ] as { label: string; score: number; color: string }[]).map((m, i) => (
                    <div key={i} className="flex items-center gap-2 text-[12px]">
                      <span className="text-slate-500 w-20 flex-shrink-0 font-medium">{m.label}</span>
                      <div className="flex-1 bg-slate-200 h-1 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${m.color === 'emerald' ? 'bg-emerald-500' : m.color === 'red' ? 'bg-red-500' : 'bg-amber-500'}`} style={{ width: `${m.score}%` }}></div>
                      </div>
                      <span className={`font-mono font-semibold w-6 text-right ${m.color === 'emerald' ? 'text-emerald-600' : m.color === 'red' ? 'text-red-500' : 'text-amber-600'}`}>{m.score}</span>
                    </div>
                  ))}
                  <div className="pt-1 text-[11px] text-red-500 flex items-center gap-1.5 font-medium">
                    <TrendingDown className="w-3 h-3" /> &quot;improved performance&quot; → add concrete metrics
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── FOLD 3: THE REPLAY ── */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl mb-12">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-600 mb-2">Post-Session Multimodal Replay</p>
            <h2 className="text-3xl md:text-4xl font-extrabold text-slate-900 mb-3">
              Athletes review game tape. You&apos;ve never reviewed an interview.
            </h2>
            <p className="text-slate-500 text-base">
              Video, transcript, and three signal streams — voice, face, content — synchronized to every second. Tap any moment. See what went wrong. Learn what went right.
            </p>
          </div>

          <div className="max-w-5xl bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xl shadow-slate-200/50">
            <div className="grid md:grid-cols-5">
              <div className="md:col-span-3 aspect-video bg-slate-800 relative flex items-center justify-center group cursor-pointer">
                <div className="w-14 h-14 rounded-full bg-white/10 border border-white/20 flex items-center justify-center group-hover:bg-white/20 transition-colors">
                  <Play className="w-6 h-6 text-white/60 ml-0.5" />
                </div>
                <div className="absolute top-3 left-3 bg-slate-900/80 px-2.5 py-1 rounded text-[10px] font-mono text-slate-400">Q2 · System Design · 3:42</div>
                <div className="absolute top-3 right-3 bg-red-500 px-2.5 py-1 rounded text-[10px] font-semibold text-white flex items-center gap-1">
                  <Activity className="w-3 h-3" /> Pace Warning
                </div>
              </div>
              <div className="md:col-span-2 p-5 border-t md:border-t-0 md:border-l border-slate-200 flex flex-col">
                <h4 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-4">Transcript</h4>
                <div className="space-y-3 overflow-hidden relative flex-1">
                  <p className="text-[13px] text-slate-400">&quot;So initially, we looked at the monolithic structure and decided it was...&quot;</p>
                  <div className="bg-slate-50 border border-slate-200 p-3 rounded-lg">
                    <p className="text-[13px] text-slate-700">
                      &quot;...getting too difficult to scale.{' '}
                      <span className="bg-amber-100 text-amber-700 px-1 rounded border-b border-dashed border-amber-300">Umm, so like</span>
                      , we broke it down into smaller microservices using Docker.&quot;
                    </p>
                  </div>
                  <p className="text-[13px] text-slate-400">&quot;This allowed distinct teams to deploy independently...&quot;</p>
                  <div className="absolute bottom-0 left-0 w-full h-10 bg-gradient-to-t from-white to-transparent"></div>
                </div>
              </div>
            </div>

            <div className="p-5 border-t border-slate-200 bg-slate-50">
              <div className="relative h-1.5 bg-slate-200 rounded-full mb-6">
                <div className="absolute top-0 left-0 h-full w-[35%] bg-blue-500 rounded-full"></div>
                <div className="absolute top-1/2 -translate-y-1/2 left-[15%] w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-white shadow-sm"></div>
                <div className="absolute top-1/2 -translate-y-1/2 left-[35%] w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-white shadow-sm"></div>
                <div className="absolute top-1/2 -translate-y-1/2 left-[60%] w-2.5 h-2.5 bg-amber-500 rounded-full border-2 border-white shadow-sm"></div>
              </div>

              <div className="grid md:grid-cols-3 gap-3">
                <div className="flex items-start gap-2.5 p-3 bg-red-50 border border-red-100 rounded-xl">
                  <div className="bg-white border border-red-200 text-red-600 font-mono text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5 font-semibold">2:34</div>
                  <div>
                    <h5 className="text-slate-800 font-semibold text-[12px] mb-0.5 flex items-center gap-1">Confidence dip <TrendingDown className="w-3 h-3 text-red-500" /></h5>
                    <p className="text-slate-500 text-[11px] leading-snug">Eye contact 20%, pace doubled to 182 wpm. Three fillers in one sentence.</p>
                  </div>
                </div>
                <div className="flex items-start gap-2.5 p-3 bg-emerald-50 border border-emerald-100 rounded-xl">
                  <div className="bg-white border border-emerald-200 text-emerald-600 font-mono text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5 font-semibold">4:12</div>
                  <div>
                    <h5 className="text-slate-800 font-semibold text-[12px] mb-0.5 flex items-center gap-1">Strongest moment <TrendingUp className="w-3 h-3 text-emerald-500" /></h5>
                    <p className="text-slate-500 text-[11px] leading-snug">Steady 130 wpm, strong eye contact. Cited &quot;reduced latency by 40%.&quot;</p>
                  </div>
                </div>
                <div className="flex items-start gap-2.5 p-3 bg-amber-50 border border-amber-100 rounded-xl">
                  <div className="bg-white border border-amber-200 text-amber-600 font-mono text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5 font-semibold">7:45</div>
                  <div>
                    <h5 className="text-slate-800 font-semibold text-[12px] mb-0.5 flex items-center gap-1">Filler spike <AlertTriangle className="w-3 h-3 text-amber-500" /></h5>
                    <p className="text-slate-500 text-[11px] leading-snug">&quot;Um&quot; tripled. Answer lacked STAR — described situation, skipped result.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-10 text-center">
            <button
              type="button"
              onClick={handleStartCta}
              className="inline-flex items-center gap-2 text-blue-600 font-semibold text-[14px] hover:text-blue-700 transition-colors"
            >
              Experience a free interview with replay <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </section>

      {/* ── FOLD 4: JOURNEY PIPELINE ── */}
      <section id="journey" className="py-20 bg-slate-50 border-y border-slate-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl mb-14">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-600 mb-2">More Than Mock Interviews</p>
            <h2 className="text-3xl md:text-4xl font-extrabold text-slate-900 mb-3">One platform. Every step between you and the offer.</h2>
            <p className="text-slate-500 text-base">The mock interview is the centerpiece — but getting hired is a journey. We cover every stage.</p>
          </div>

          <div className="space-y-3">
            {([
              { step: '1', title: 'Resume gets you in', desc: 'AI-powered resume builder with 10 templates, ATS scoring, and JD-specific tailoring.', icon: <FileText className="w-5 h-5 text-amber-600" />, iconBg: 'bg-amber-50 border-amber-100', href: '/resume', label: 'Resume Tools' },
              { step: '2', title: 'Guides prep your mind', desc: 'Company-specific guides for Google, Amazon, McKinsey, and 8 more. STAR frameworks, negotiation scripts — all free.', icon: <BookOpen className="w-5 h-5 text-sky-600" />, iconBg: 'bg-sky-50 border-sky-100', href: '/resources', label: '26+ Guides' },
              { step: '3', title: 'Live AI coaching', desc: 'Voice conversation with an AI that watches your face, listens to your voice, and scores your answers. Real-time nudges. 12+ domains.', icon: <Mic className="w-5 h-5 text-blue-600" />, iconBg: 'bg-blue-50 border-blue-100', href: CTA_SENTINEL, label: 'Try Free', core: true },
              { step: '4', title: 'Replay the truth', desc: 'Synchronized video + transcript + signal timeline. See the exact second you lost confidence.', icon: <MonitorPlay className="w-5 h-5 text-emerald-600" />, iconBg: 'bg-emerald-50 border-emerald-100', href: CTA_SENTINEL, label: 'View Replays' },
              { step: '5', title: 'Track and repeat', desc: 'Session comparison. Score trends. Competency tracking showing which skills improve and which decay.', icon: <RotateCcw className="w-5 h-5 text-teal-600" />, iconBg: 'bg-teal-50 border-teal-100', href: '/learn/progress', label: 'Progress' },
            ] as JourneyStep[]).map((s, i) => {
              const isCta = s.href === CTA_SENTINEL
              const Wrapper: React.ElementType = isCta ? 'button' : Link
              const wrapperProps = isCta
                ? { type: 'button' as const, onClick: handleStartCta }
                : { href: s.href }
              return (
              <Wrapper
                key={i}
                {...wrapperProps}
                className={`group flex flex-col md:flex-row md:items-center gap-4 md:gap-6 p-5 rounded-2xl transition-all no-underline text-left w-full ${
                  s.core
                    ? 'bg-blue-50 border border-blue-200 hover:shadow-lg hover:shadow-blue-100/50'
                    : 'bg-white border border-slate-200 hover:shadow-lg hover:shadow-slate-100/50'
                }`}
              >
                <div className="flex items-center gap-4 md:w-60 flex-shrink-0">
                  <div className={`w-10 h-10 rounded-xl border flex items-center justify-center flex-shrink-0 ${s.iconBg}`}>
                    {s.icon}
                  </div>
                  <div>
                    <div className={`text-[10px] font-semibold uppercase tracking-wider mb-0.5 ${s.core ? 'text-blue-500' : 'text-slate-400'}`}>
                      Step {s.step}{s.core ? ' · Core' : ''}
                    </div>
                    <h4 className="text-[15px] font-bold text-slate-800">{s.title}</h4>
                  </div>
                </div>
                <p className="text-[14px] text-slate-500 flex-1 m-0">{s.desc}</p>
                <div className="hidden md:flex items-center gap-2 flex-shrink-0">
                  <span className={`text-[12px] font-medium ${s.core ? 'text-blue-500 group-hover:text-blue-600' : 'text-slate-400 group-hover:text-slate-600'} transition-colors`}>{s.label}</span>
                  <ArrowRight className={`w-4 h-4 ${s.core ? 'text-blue-400 group-hover:text-blue-500' : 'text-slate-300 group-hover:text-slate-500'} transition-colors`} />
                </div>
              </Wrapper>
              )
            })}
          </div>

          <div className="mt-8 pt-6 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-sm text-slate-400">
              Every tool points to one outcome: <span className="text-slate-700 font-semibold">you walk into the interview room and perform.</span>
            </p>
            <button
              type="button"
              onClick={handleStartCta}
              className="inline-flex items-center gap-2 text-blue-600 font-semibold text-sm hover:text-blue-700 transition-colors flex-shrink-0"
            >
              Start the journey free <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </section>

      {/* ── FOLD 5: DOMAINS + SOCIAL PROOF ── */}
      <section className="py-16 bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400 mb-6">Calibrated for your field</p>
          <div className="flex flex-wrap justify-center gap-2.5 mb-12">
            {['Software Engineering', 'Data Science', 'Product Management', 'Design / UX', 'Finance & Banking', 'Management Consulting'].map((d, i) => (
              <div key={i} className="px-5 py-2.5 bg-slate-50 border border-slate-200 rounded-full text-[13px] font-medium text-slate-600 hover:border-slate-300 transition-colors cursor-pointer">
                {d}
              </div>
            ))}
          </div>
          <p className="text-[13px] text-slate-400 mb-14">
            + 8 more including Marketing, DevOps, HR, and Legal. <Link href="/resources" className="text-blue-600 hover:underline">See all domains →</Link>
          </p>

          <div className="pt-12 border-t border-slate-100">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400 mb-8">Company-specific guides and AI-matched practice for:</p>
            <div className="flex flex-wrap justify-center items-center gap-8 md:gap-14">
              {[
                { name: 'Google', style: 'font-bold tracking-tighter', href: '/resources/how-to-interview-at-google' },
                { name: 'Amazon', style: 'font-bold tracking-tight', href: '/resources/amazon-leadership-principles-guide' },
                { name: 'Meta', style: 'font-bold', href: '/resources/how-to-interview-at-meta' },
                { name: 'McKinsey', style: 'font-serif italic', href: '/resources/mckinsey-interview-guide' },
                { name: 'Stripe', style: 'font-bold tracking-tighter', href: '/resources/how-to-interview-at-stripe' },
              ].map((c, i) => (
                <Link key={i} href={c.href} className={`text-2xl text-slate-700 hover:text-slate-900 transition-colors no-underline ${c.style}`}>
                  {c.name}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── FOLD 6: TECH STATS ── */}
      <section className="py-14 bg-slate-50 border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap justify-center gap-8 md:gap-14 text-center">
            {[
              { num: '147', label: 'data points analyzing your body language', highlight: false },
              { num: '12', label: 'vocal metrics tracked continuously', highlight: false },
              { num: '5', label: 'answer dimensions scored per question', highlight: false },
              { num: '3', label: 'AI pipelines running in parallel', highlight: false },
              { num: '1', label: 'synchronized replay with ms precision', highlight: true },
            ].map((s, i) => (
              <div key={i} className="w-36">
                <div className={`text-3xl md:text-4xl font-extrabold mb-1 ${s.highlight ? 'text-blue-600' : 'text-slate-800'}`}>{s.num}</div>
                <div className="text-[11px] text-slate-400 leading-snug">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FOLD 7: PRICING ── */}
      <section className="py-20 bg-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-14">
            <h2 className="text-3xl md:text-4xl font-extrabold text-slate-900 mb-3">
              Free. Because you should know what you&apos;re doing wrong before you pay to fix it.
            </h2>
            <p className="text-base text-slate-500">No credit card. No trial countdown.</p>
          </div>

          <div className="grid md:grid-cols-2 gap-5 max-w-4xl mx-auto">
            <div className="bg-white border border-slate-200 rounded-2xl p-7 hover:shadow-lg hover:shadow-slate-100/50 transition-all flex flex-col">
              <h3 className="text-xl font-bold text-slate-800 mb-1">Free</h3>
              <div className="flex items-baseline gap-1 mb-6 pb-6 border-b border-slate-100">
                <span className="text-4xl font-extrabold text-slate-800">$0</span>
                <span className="text-slate-400">/ forever</span>
              </div>
              <ul className="space-y-3 mb-8 flex-1">
                {[
                  'Unlimited AI voice interviews',
                  'Real-time face + voice + content coaching',
                  '5-dimension scoring per question',
                  '1 detailed video replay with full analysis per month',
                  '12+ career domains',
                ].map((f, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-[14px] text-slate-600">
                    <CheckCircle2 className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" /> {f}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={handleStartCta}
                className="block w-full py-3 text-[14px] font-semibold rounded-xl bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors text-center"
              >
                Get Started Free
              </button>
            </div>

            <div className="bg-slate-800 rounded-2xl p-7 relative flex flex-col">
              <div className="absolute top-0 right-5 -translate-y-1/2 px-3 py-1 bg-blue-500 text-white text-[10px] font-semibold uppercase tracking-wider rounded-full">
                Coming Soon
              </div>
              <h3 className="text-xl font-bold text-white mb-1">Pro</h3>
              <div className="flex items-baseline gap-1 mb-6 pb-6 border-b border-slate-700">
                <span className="text-4xl font-extrabold text-white">$11</span>
                <span className="text-slate-400">/ month</span>
              </div>
              <ul className="space-y-3 mb-8 flex-1">
                {[
                  { text: 'Everything in Free', bold: true },
                  { text: 'Unlimited video replays with full analysis' },
                  { text: 'Session comparison across attempts' },
                  { text: 'Resume builder + ATS checker + JD tailor' },
                  { text: 'JD-matched practice with gap analysis' },
                  { text: 'Priority AI processing' },
                ].map((f, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-[14px] text-slate-300">
                    <CheckCircle2 className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
                    {f.bold ? <strong className="text-white">{f.text}</strong> : f.text}
                  </li>
                ))}
              </ul>
              <Link href="/pricing" className="block w-full py-3 text-[14px] font-semibold rounded-xl bg-white/10 text-white hover:bg-white/20 transition-colors text-center">
                Get Notified When Pro Launches
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── FOLD 8: FINAL CTA ── */}
      <section className="py-20 bg-slate-50 border-t border-slate-200">
        <div className="max-w-3xl mx-auto px-4 text-center">
          <h2 className="text-3xl md:text-[2.5rem] font-extrabold text-slate-900 mb-5 leading-tight">
            Your next interviewer won&apos;t tell you what went wrong. We will.
          </h2>
          <p className="text-lg text-slate-500 mb-10">
            3 AI systems. 5 scoring dimensions. 147 facial landmarks. 1 question — what are you waiting for?
          </p>
          <button
            type="button"
            onClick={handleStartCta}
            className="inline-block px-10 py-4 text-[16px] font-bold rounded-full bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-600/20 transition-all"
          >
            Take Your First Interview — Free
          </button>
        </div>
      </section>

    </div>
  )
}
