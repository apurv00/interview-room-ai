'use client'

import { ReactNode } from 'react'
import { motion } from 'framer-motion'

interface VideoTileProps {
  label: string
  sublabel?: string
  children: ReactNode
  isActive?: boolean
  indicator?: ReactNode
}

export default function VideoTile({ label, sublabel, children, isActive, indicator }: VideoTileProps) {
  return (
    <motion.div
      className="relative flex-1 rounded-2xl overflow-hidden bg-slate-900"
      animate={{
        borderColor: isActive ? 'rgba(99,102,241,0.5)' : 'rgba(51,65,85,0.4)',
        boxShadow: isActive
          ? '0 0 0 1px rgba(99,102,241,0.3), 0 8px 32px rgba(99,102,241,0.12)'
          : '0 0 0 1px rgba(51,65,85,0.2), 0 4px 16px rgba(0,0,0,0.2)',
      }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      style={{ border: '1px solid' }}
    >
      {/* Content */}
      <div className="absolute inset-0">{children}</div>

      {/* Top-right indicator */}
      {indicator && (
        <motion.div
          className="absolute top-3 right-3 z-10"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2 }}
        >
          {indicator}
        </motion.div>
      )}

      {/* Name tag */}
      <div className="absolute bottom-3 left-3 z-10">
        <div className="flex items-center gap-2 bg-black/50 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/[0.06]">
          {/* Active dot */}
          {isActive && (
            <motion.div
              className="w-1.5 h-1.5 rounded-full bg-indigo-400"
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            />
          )}
          <span className="text-sm font-medium text-white/90">{label}</span>
          {sublabel && (
            <span className="text-[11px] text-slate-400 border-l border-slate-600/50 pl-2">{sublabel}</span>
          )}
        </div>
      </div>

      {/* Active speaking ring — subtle inner glow */}
      {isActive && (
        <motion.div
          className="absolute inset-0 rounded-2xl pointer-events-none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          style={{
            boxShadow: 'inset 0 0 60px rgba(99,102,241,0.06)',
          }}
        />
      )}
    </motion.div>
  )
}
