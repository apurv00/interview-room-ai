'use client'

import Input from '@shared/ui/Input'
import type { WizardContactInfo } from '../hooks/useWizard'

interface Props {
  contactInfo: WizardContactInfo
  onChange: (info: WizardContactInfo) => void
}

export default function StageContact({ contactInfo, onChange }: Props) {
  function update(field: keyof WizardContactInfo, value: string) {
    onChange({ ...contactInfo, [field]: value })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold text-white">Contact Information</h2>
        <p className="text-sm text-slate-500">How should employers reach you?</p>
      </div>

      <div className="space-y-4">
        <Input
          label="Full Name"
          value={contactInfo.fullName}
          onChange={e => update('fullName', e.target.value)}
          placeholder="Jane Doe"
          required
        />
        <Input
          label="Email"
          type="email"
          value={contactInfo.email}
          onChange={e => update('email', e.target.value)}
          placeholder="jane@example.com"
          required
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Phone"
            type="tel"
            value={contactInfo.phone || ''}
            onChange={e => update('phone', e.target.value)}
            placeholder="+1 (555) 123-4567"
          />
          <Input
            label="City"
            value={contactInfo.city || ''}
            onChange={e => update('city', e.target.value)}
            placeholder="San Francisco, CA"
          />
        </div>
        <Input
          label="LinkedIn URL (optional)"
          value={contactInfo.linkedInUrl || ''}
          onChange={e => update('linkedInUrl', e.target.value)}
          placeholder="https://linkedin.com/in/janedoe"
        />
      </div>
    </div>
  )
}
