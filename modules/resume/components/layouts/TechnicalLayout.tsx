import { Fragment, type ReactNode } from 'react'
import type { ResumeData } from '../../validators/resume'
import type { TechnicalVariantId } from '../../config/technicalThemes'
import { getTechnicalTheme } from '../../config/technicalThemes'
import { TECHNICAL_ORDER, resolveSectionOrder, type BodySectionId } from '../../config/sectionOrders'
import TemplateRoot from '../template-primitives/TemplateRoot'
import ResumeSkillsSection from '../ResumeSkillsSection'

interface Props {
  data: ResumeData
  variantId: TechnicalVariantId
}

export default function TechnicalLayout({ data, variantId }: Props) {
  const theme = getTechnicalTheme(variantId)
  const contact = data.contactInfo || { fullName: '', email: '' }
  const sectionTitle = theme.accentSectionTitle

  const blocks: Partial<Record<BodySectionId, ReactNode>> = {
    skills:
      data.skills && data.skills.length > 0 ? (
        <ResumeSkillsSection
          skills={data.skills}
          title="Technical Skills"
          sectionClassName={theme.skillsSectionClass}
          headerClassName={theme.skillsHeaderClass}
          renderCategory={(cat) => (
            <div>
              <span className="font-semibold">{cat.category}:</span>{' '}
              <span className="text-gray-700">{cat.items.join(', ')}</span>
            </div>
          )}
        />
      ) : undefined,
    summary: data.summary ? (
      <div className="mb-3" data-resume-section="summary">
        <h2 data-resume-section-header={theme.summaryTitle} className={sectionTitle}>
          {theme.summaryTitle}
        </h2>
        <p className={theme.bodyText}>{data.summary}</p>
      </div>
    ) : undefined,
    experience:
      data.experience && data.experience.length > 0 ? (
        <div className="mb-3" data-resume-section="experience">
          <h2 data-resume-section-header="Experience" className={sectionTitle}>Experience</h2>
          {data.experience.map(exp => (
            <div key={exp.id} className="mb-2" data-resume-section-unit>
              <div className="flex justify-between">
                <span className="font-bold">
                  {exp.title} @ {exp.company}
                </span>
                <span className={theme.metaText}>
                  {exp.startDate} - {exp.endDate || 'Present'}
                </span>
              </div>
              {exp.bullets.filter(b => b.trim()).length > 0 && (
                <ul className="mt-0.5 space-y-0.5 ml-2">
                  {exp.bullets.filter(b => b.trim()).map((bullet, i) => (
                    <li
                      key={i}
                      className={`text-gray-700 before:content-['▸'] before:mr-1 ${theme.bulletAccentClass}`}
                    >
                      {bullet}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      ) : undefined,
    projects:
      data.projects && data.projects.length > 0 ? (
        <div className="mb-3" data-resume-section="projects">
          <h2 data-resume-section-header="Projects" className={sectionTitle}>Projects</h2>
          {data.projects.map(proj => (
            <div key={proj.id} className="mb-1.5" data-resume-section-unit>
              <div className="flex items-baseline gap-1">
                <span className="font-bold">{proj.name}</span>
                {proj.url && (
                  <span className={theme.projectUrlClass}>[{proj.url}]</span>
                )}
              </div>
              {proj.technologies?.length ? (
                <div className={theme.metaText}>Stack: {proj.technologies.join(' · ')}</div>
              ) : null}
              <p className={theme.bodyText}>{proj.description}</p>
            </div>
          ))}
        </div>
      ) : undefined,
    education:
      data.education && data.education.length > 0 ? (
        <div className="mb-3" data-resume-section="education">
          <h2 data-resume-section-header="Education" className={sectionTitle}>Education</h2>
          {data.education.map(edu => (
            <div key={edu.id} className="mb-1" data-resume-section-unit>
              <span className="font-bold">{edu.degree}</span>
              {edu.field && <span> in {edu.field}</span>}
              {edu.institution && <span> — {edu.institution}</span>}
              {edu.graduationDate && (
                <span className="text-gray-500"> ({edu.graduationDate})</span>
              )}
            </div>
          ))}
        </div>
      ) : undefined,
    certifications:
      data.certifications && data.certifications.length > 0 ? (
        <div className="mb-3" data-resume-section="certifications">
          <h2 data-resume-section-header="Certifications" className={sectionTitle}>
            Certifications
          </h2>
          {data.certifications.map((cert, i) => (
            <div key={i} data-resume-section-unit>
              {cert.name} — {cert.issuer} {cert.date && `(${cert.date})`}
            </div>
          ))}
        </div>
      ) : undefined,
    customSections:
      data.customSections && data.customSections.length > 0 ? (
        <>
          {data.customSections.map(section => (
            <div key={section.id} className="mb-3" data-resume-section={`custom-${section.id}`}>
              <h2 data-resume-section-header={section.title} className={sectionTitle}>
                {section.title}
              </h2>
              <p className={`${theme.bodyText} whitespace-pre-wrap`}>{section.content}</p>
            </div>
          ))}
        </>
      ) : undefined,
  }

  const order = resolveSectionOrder(data.sectionOrder, TECHNICAL_ORDER)

  return (
    <TemplateRoot className="text-gray-900 leading-snug">
      <div className={theme.headerBorder}>
        <h1 className="font-bold" style={{ fontSize: 'var(--r-title, 18px)' }}>
          {contact.fullName || 'Your Name'}
        </h1>
        <div className={theme.contactRow}>
          {contact.email && <span>{contact.email}</span>}
          {contact.phone && <><span>|</span><span>{contact.phone}</span></>}
          {contact.location && <><span>|</span><span>{contact.location}</span></>}
          {contact.github && <><span>|</span><span>{contact.github}</span></>}
          {contact.linkedin && <><span>|</span><span>{contact.linkedin}</span></>}
        </div>
      </div>
      {order.map(id => (blocks[id] ? <Fragment key={id}>{blocks[id]}</Fragment> : null))}
    </TemplateRoot>
  )
}
