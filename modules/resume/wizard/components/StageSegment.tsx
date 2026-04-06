'use client'

import { motion } from 'framer-motion'
import { WIZARD_SEGMENTS } from '../config/wizardConfig'
import type { WizardSegment } from '../validators/wizardSchemas'

interface Props {
  selected: WizardSegment | null
  onSelect: (segment: WizardSegment) => void
  isLoading: boolean
}

export default function StageSegment({ selected, onSelect, isLoading }: Props) {
  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-xl font-bold text-[#0f1419]">What best describes you?</h2>
        <p className="text-sm text-[#6b7280]">This helps us tailor questions and suggestions to your situation</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {WIZARD_SEGMENTS.map((segment, i) => (
          <motion.button
            key={segment.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            onClick={() => onSelect(segment.id)}
            disabled={isLoading}
            className={`
              p-4 rounded-xl text-left transition-all duration-150
              border
              ${selected === segment.id
                ? 'bg-[#2563eb]/10 border-[#2563eb]/50 ring-1 ring-[#2563eb]/20'
                : 'bg-[#f7f9f9] border-[#e1e8ed] hover:border-[#e1e8ed]'
              }
              disabled:opacity-50 disabled:cursor-not-allowed
            `}
          >
            <span className="text-2xl">{segment.icon}</span>
            <h3 className="text-sm font-semibold text-[#0f1419] mt-2">{segment.label}</h3>
            <p className="text-xs text-[#6b7280] mt-1">{segment.description}</p>
          </motion.button>
        ))}
      </div>
    </div>
  )
}
