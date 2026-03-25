'use client'

import { motion } from 'framer-motion'
import Button from '@shared/ui/Button'
import { RESUME_TEMPLATES } from '@resume/config/templates'
import FontStyleControls from '@resume/components/FontStyleControls'

interface Props {
  selectedTemplate: string
  strengthScore: number
  strengthBreakdown: { contact: number; experience: number; education: number; skills: number; extras: number }
  isSaving: boolean
  fontFamily: string
  headingSize: number
  bodySize: number
  onSelectTemplate: (template: string) => void
  onFontFamilyChange: (id: string) => void
  onHeadingSizeChange: (size: number) => void
  onBodySizeChange: (size: number) => void
  onExport: () => void
}

export default function StageExport({
  selectedTemplate, strengthScore, strengthBreakdown, isSaving,
  fontFamily, headingSize, bodySize,
  onSelectTemplate, onFontFamilyChange, onHeadingSizeChange, onBodySizeChange, onExport,
}: Props) {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold text-[#0f1419]">Export Your Resume</h2>
        <p className="text-sm text-[#6b7280]">Choose a template and download your polished resume</p>
      </div>

      {/* Strength Score Card */}
      <div className="bg-[#f7f9f9] border border-[#e1e8ed] rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-[#0f1419]">Resume Strength</span>
          <motion.span
            key={strengthScore}
            className={`text-2xl font-bold ${
              strengthScore >= 75 ? 'text-[#059669]'
                : strengthScore >= 50 ? 'text-amber-400'
                  : 'text-[#6366f1]'
            }`}
            initial={{ scale: 0.8 }}
            animate={{ scale: 1 }}
          >
            {strengthScore}/100
          </motion.span>
        </div>
        <div className="space-y-1.5">
          {Object.entries(strengthBreakdown).map(([key, value]) => (
            <div key={key} className="flex items-center gap-2">
              <span className="text-[10px] text-[#6b7280] w-16 capitalize">{key}</span>
              <div className="flex-1 h-1.5 rounded-full bg-card overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-[#6366f1]"
                  initial={false}
                  animate={{ width: `${(value / getMax(key)) * 100}%` }}
                  transition={{ duration: 0.4 }}
                />
              </div>
              <span className="text-[10px] text-[#8b98a5] w-8 text-right">{value}/{getMax(key)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Template Selector */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-[#536471]">Choose Template</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {RESUME_TEMPLATES.slice(0, 6).map(template => (
            <button
              key={template.id}
              onClick={() => onSelectTemplate(template.id)}
              className={`p-3 rounded-xl border text-left transition-all ${
                selectedTemplate === template.id
                  ? 'border-[#6366f1]/50 bg-[#6366f1]/10 ring-1 ring-[#6366f1]/20'
                  : 'border-[#e1e8ed] bg-[#f7f9f9] hover:border-[#e1e8ed]'
              }`}
            >
              <div className="w-full h-12 rounded bg-card mb-2 flex items-center justify-center">
                <span className="text-[8px] text-[#8b98a5] uppercase tracking-wider">{template.id}</span>
              </div>
              <p className="text-xs font-medium text-[#0f1419] truncate">{template.name}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Font & Size */}
      <FontStyleControls
        fontFamily={fontFamily}
        headingSize={headingSize}
        bodySize={bodySize}
        onFontFamilyChange={onFontFamilyChange}
        onHeadingSizeChange={onHeadingSizeChange}
        onBodySizeChange={onBodySizeChange}
      />

      {/* Export Button */}
      <div className="space-y-3 pt-2">
        <Button
          variant="primary"
          size="lg"
          isFullWidth
          glow
          onClick={onExport}
          isLoading={isSaving}
        >
          Download PDF
        </Button>
        <p className="text-[10px] text-center text-[#8b98a5]">
          Your resume will also be saved to your dashboard for future editing
        </p>
      </div>
    </div>
  )
}

function getMax(key: string): number {
  const maxes: Record<string, number> = { contact: 10, experience: 40, education: 15, skills: 20, extras: 15 }
  return maxes[key] || 10
}
