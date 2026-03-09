'use client'

import { ReactNode } from 'react'

interface VideoTileProps {
  label: string
  sublabel?: string
  children: ReactNode
  isActive?: boolean    // highlighted border when speaking
  indicator?: ReactNode
}

export default function VideoTile({ label, sublabel, children, isActive, indicator }: VideoTileProps) {
  return (
    <div
      className={`
        relative flex-1 rounded-2xl overflow-hidden
        border transition-all duration-300
        ${isActive
          ? 'border-indigo-500/60 shadow-lg shadow-indigo-500/20'
          : 'border-slate-700/50'
        }
        bg-slate-900
      `}
    >
      {/* Content */}
      <div className="absolute inset-0">{children}</div>

      {/* Top-right indicator slot */}
      {indicator && (
        <div className="absolute top-3 right-3 z-10">{indicator}</div>
      )}

      {/* Name tag */}
      <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2">
        <div className="bg-black/60 backdrop-blur-sm px-3 py-1 rounded-full">
          <span className="text-sm font-medium text-white">{label}</span>
          {sublabel && (
            <span className="text-xs text-slate-400 ml-1.5">{sublabel}</span>
          )}
        </div>
      </div>

      {/* Active speaking ring */}
      {isActive && (
        <div className="absolute inset-0 rounded-2xl ring-2 ring-indigo-500/40 pointer-events-none" />
      )}
    </div>
  )
}
