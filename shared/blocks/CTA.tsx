import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/shared/ui/shadcn/button'

export default function CTA() {
  return (
    <section className="relative px-4 sm:px-6 py-20 overflow-hidden">
      {/* Gradient background */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-blue-50/40 to-transparent pointer-events-none" />
      <div className="absolute bottom-0 left-1/3 w-72 h-72 bg-blue-100 rounded-full blur-[100px] opacity-25 pointer-events-none" />

      <div className="relative max-w-[600px] mx-auto text-center">
        <h2 className="text-2xl sm:text-3xl font-bold text-[#0f1419] tracking-tight">
          Ready to practice?
        </h2>
        <p className="mt-3 text-[#536471]">
          Free to start — no credit card required.
        </p>
        <Link href="/signup" className="inline-block mt-8">
          <Button size="lg" className="gap-2 btn-glow">
            Start Your First Interview
            <ArrowRight className="size-4" />
          </Button>
        </Link>
      </div>
    </section>
  )
}
