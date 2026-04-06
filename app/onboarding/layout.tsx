export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-white via-[#f8fafc] to-blue-50/30">
      {children}
    </div>
  )
}
