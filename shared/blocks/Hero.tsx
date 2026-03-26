'use client'

import Link from 'next/link'
import { ArrowRight, Sparkles } from 'lucide-react'
import { Badge } from '@/shared/ui/shadcn/badge'
import { Button } from '@/shared/ui/shadcn/button'

export default function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-white via-indigo-50/30 to-white pointer-events-none" />

      {/* Decorative grid pattern */}
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(circle, #6366f1 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      />

      {/* Decorative blurred orbs */}
      <div className="absolute top-20 left-[15%] w-80 h-80 bg-indigo-200 rounded-full blur-[100px] opacity-30 pointer-events-none" />
      <div className="absolute top-40 right-[15%] w-64 h-64 bg-violet-200 rounded-full blur-[100px] opacity-20 pointer-events-none" />

      <div className="relative max-w-[900px] mx-auto px-4 sm:px-6 pt-24 pb-20 text-center">
        {/* Badge */}
        <div className="animate-slide-up">
          <Badge variant="primary" className="gap-1.5 py-1 px-3">
            <Sparkles className="size-3" />
            AI-Powered Interview Practice
          </Badge>
        </div>

        {/* Headline */}
        <h1
          className="mt-8 text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight text-[#0f1419] animate-slide-up"
          style={{ animationDelay: '80ms' }}
        >
          Practice interviews that{' '}
          <span className="bg-gradient-to-r from-[#6366f1] to-[#a855f7] bg-clip-text text-transparent">
            feel real.
          </span>
        </h1>

        {/* Sub-headline */}
        <p
          className="mt-6 text-lg sm:text-xl text-[#536471] max-w-[600px] mx-auto leading-relaxed animate-slide-up"
          style={{ animationDelay: '160ms' }}
        >
          Mock interviews with an AI interviewer who adapts to your domain,
          experience level, and career goals. Scored feedback after every session.
        </p>

        {/* CTAs */}
        <div
          className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-10 animate-slide-up"
          style={{ animationDelay: '240ms' }}
        >
          <Link href="/signup">
            <Button size="lg" className="gap-2 btn-glow">
              Get Started Free
              <ArrowRight className="size-4" />
            </Button>
          </Link>
          <Link href="/pricing">
            <Button variant="outline" size="lg">
              View Pricing
            </Button>
          </Link>
        </div>

        {/* Social proof line */}
        <p
          className="mt-8 text-sm text-[#8b98a5] animate-slide-up"
          style={{ animationDelay: '320ms' }}
        >
          No credit card required &middot; 12+ career domains &middot; Instant AI feedback
        </p>
      </div>
    </section>
  )
}
