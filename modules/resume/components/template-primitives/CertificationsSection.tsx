import type { ResumeData } from '../../validators/resume'
import type { ClassicTheme } from '../../config/classicThemes'
import SectionBlock from './SectionBlock'

interface Props {
  certifications: NonNullable<ResumeData['certifications']>
  theme: ClassicTheme
  sectionTitle?: string
}

export default function CertificationsSection({ certifications, theme, sectionTitle }: Props) {
  const { certifications: certTheme } = theme
  const isMinimal = certTheme.nameClass === 'font-medium'

  return (
    <SectionBlock sectionId="certifications" title={sectionTitle ?? theme.sectionLabels.certifications} theme={theme}>
      {certifications.map((cert, i) => (
        <div key={i} className={certTheme.unitGap} data-resume-section-unit>
          <span className={certTheme.nameClass}>{cert.name}</span>
          {isMinimal ? (
            <span className="text-gray-500"> — {cert.issuer}</span>
          ) : (
            <> — {cert.issuer}</>
          )}
          {cert.date && (
            <span className={isMinimal ? 'text-gray-400' : (certTheme.dateClass ?? 'text-gray-500')}> ({cert.date})</span>
          )}
        </div>
      ))}
    </SectionBlock>
  )
}
