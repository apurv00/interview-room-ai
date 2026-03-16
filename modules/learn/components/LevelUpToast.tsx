'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface LevelUpToastProps {
  level: number
  title: string
  onDismiss: () => void
}

export default function LevelUpToast({ level, title, onDismiss }: LevelUpToastProps) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false)
      setTimeout(onDismiss, 300)
    }, 4000)
    return () => clearTimeout(timer)
  }, [onDismiss])

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed top-20 left-1/2 z-[100] -translate-x-1/2"
          initial={{ opacity: 0, y: -30, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.95 }}
          transition={{ type: 'spring', damping: 15 }}
        >
          <div className="bg-gradient-to-r from-[#6366f1] to-[#818cf8] text-white px-6 py-4 rounded-xl shadow-lg flex items-center gap-3">
            <span className="text-2xl">🎉</span>
            <div>
              <p className="text-sm font-bold">Level Up!</p>
              <p className="text-xs opacity-90">
                You reached Level {level} — {title}
              </p>
            </div>
            <button
              onClick={() => { setVisible(false); onDismiss() }}
              className="ml-2 text-white/70 hover:text-white"
            >
              ✕
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
