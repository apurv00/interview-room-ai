export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-white via-[#f7f9f9] to-indigo-50/30">
      {children}
    </div>
  )
}
