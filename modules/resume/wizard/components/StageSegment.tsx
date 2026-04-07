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
        <h2 className="text-xl font-bold text-slate-900">What best describes you?</h2>
        <p className="text-sm text-slate-500">This helps us tailor questions and suggestions to your situation</p>
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
                ? 'bg-blue-600/10 border-blue-600/50 ring-1 ring-blue-600/20'
                : 'bg-slate-50 border-slate-200 hover:border-slate-200'
              }
              disabled:opacity-50 disabled:cursor-not-allowed
            `}
          >
            <span className="text-2xl">{segment.icon}</span>
            <h3 className="text-sm font-semibold text-slate-900 mt-2">{segment.label}</h3>
            <p className="text-xs text-slate-500 mt-1">{segment.description}</p>
          </motion.button>
        ))}
      </div>
    </div>
  )
}
