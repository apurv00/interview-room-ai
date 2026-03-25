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
          <div className="bg-white border border-[#e1e8ed] text-[#0f1419] px-5 py-3 rounded-xl shadow-lg flex items-center gap-3">
            <span className="text-2xl">{icon}</span>
            <div>
              <p className="text-sm font-bold text-[#0f1419]">Badge Earned!</p>
              <p className="text-xs text-[#536471]">{name} — +{xpReward} XP</p>
            </div>
            <button
              onClick={() => { setVisible(false); onDismiss() }}
              className="ml-2 text-[#71767b] hover:text-[#0f1419] text-sm"
            >
              ✕
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
