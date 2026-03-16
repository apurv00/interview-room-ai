'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface BadgeToastProps {
  icon: string
  name: string
  xpReward: number
  onDismiss: () => void
}

export default function BadgeToast({ icon, name, xpReward, onDismiss }: BadgeToastProps) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false)
      setTimeout(onDismiss, 300)
    }, 5000)
    return () => clearTimeout(timer)
  }, [onDismiss])

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed bottom-20 md:bottom-8 right-4 z-[100]"
          initial={{ opacity: 0, x: 50, scale: 0.9 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 30, scale: 0.95 }}
          transition={{ type: 'spring', damping: 15 }}
        >
          <div className="bg-[#1e293b] border border-[rgba(255,255,255,0.1)] text-white px-5 py-3 rounded-xl shadow-lg flex items-center gap-3">
            <span className="text-2xl">{icon}</span>
            <div>
              <p className="text-sm font-bold text-[#f0f2f5]">Badge Earned!</p>
              <p className="text-xs text-[#9ca3af]">{name} — +{xpReward} XP</p>
            </div>
            <button
              onClick={() => { setVisible(false); onDismiss() }}
              className="ml-2 text-[#6b7280] hover:text-[#f0f2f5] text-sm"
            >
              ✕
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
