import { Fragment, type ReactNode } from 'react'
import type { ResumeData } from '../../validators/resume'
import type { EarlyCareerVariantId } from '../../config/earlyCareerThemes'
import { getEarlyCareerTheme } from '../../config/earlyCareerThemes'
import {
  EARLY_CAREER_ACADEMIC_ORDER,
  EARLY_CAREER_GRADUATE_ORDER,
  resolveSectionOrder,
  type BodySectionId,
} from '../../config/sectionOrders'
import TemplateRoot from '../template-primitives/TemplateRoot'
import ResumeSkillsSection from '../ResumeSkillsSection'

interface Props {
  data: ResumeData
  variantId: EarlyCareerVariantId
}

function ContactRow({
  contact,
  rowClass,
}: {
  contact: ResumeData['contactInfo']
  rowClass: string
}) {
  const c = contact || { fullName: '', email: '' }
  const sep = <span>|</span>
  return (
    <div className={rowClass}>
      {c.email && <span>{c.email}</span>}
      {c.phone && (
        <>
          {sep}
          <span>{c.phone}</span>
        </>
      )}
      {c.location && (
        <>
          {sep}
          <span>{c.location}</span>
        </>
      )}
      {c.linkedin && (
        <>
          {sep}
          <span>{c.linkedin}</span>
        </>
      )}
      {c.website && (
        <>
          {sep}
          <span>{c.website}</span>
        </>
      )}
      {c.github && (
        <>
          {sep}
          <span>{c.github}</span>
        </>
      )}
    </div>
  )
}

export default function EarlyCareerLayout({ data, variantId }: Props) {
  const theme = getEarlyCareerTheme(variantId)
  const contact = data.contactInfo || { fullName: '', email: '' }
  const titleClass = theme.sectionTitleClass
  const gap = theme.sectionGap
  const isGraduate = theme.layoutMode === 'graduate'

  const summaryBlock = data.summary ? (
    <div className={gap} data-resume-section="summary">
      <h2 data-resume-section-header={theme.summaryTitle} className={titleClass}>
        {theme.summaryTitle}
      </h2>
      <p className="text-gray-700 leading-relaxed">{data.summary}</p>
    </div>
  ) : null

  const educationBlock =
    data.education && data.education.length > 0 ? (
      <div className={gap} data-resume-section="education">
        <h2 data-resume-section-header="Education" className={titleClass}>
          Education
        </h2>
        {data.education.map(edu => (
          <div key={edu.id} className={theme.educationUnitGap} data-resume-section-unit>
            <div className="flex justify-between items-baseline">
              <div>
                <span className="font-bold">{edu.degree}</span>
                {edu.field && <span> in {edu.field}</span>}
                {edu.institution && <span> — {edu.institution}</span>}
              </div>
              {edu.graduationDate && (
                <span className="text-[8px] text-gray-500 shrink-0 ml-2">
                  {edu.graduationDate}
                </span>
              )}
            </div>
            {(edu.gpa || edu.honors) && (
              <div className="text-[8px] text-gray-500">
                {edu.gpa && <span>GPA: {edu.gpa}</span>}
                {edu.gpa && edu.honors && <span> | </span>}
                {edu.honors && <span>{edu.honors}</span>}
              </div>
            )}
          </div>
        ))}
      </div>
    ) : null

  const projectsBlock =
    data.projects && data.projects.length > 0 ? (
      <div className={gap} data-resume-section="projects">
        <h2 data-resume-section-header="Projects" className={titleClass}>
          Projects
        </h2>
        {data.projects.map(proj => (
          <div key={proj.id} className={isGraduate ? 'mb-1.5' : 'mb-1'} data-resume-section-unit>
            {isGraduate ? (
              <>
                <div className="flex items-baseline gap-1">
                  <span className="font-bold">{proj.name}</span>
                  {proj.url && <span className={theme.projectUrlClass}>{proj.url}</span>}
                </div>
                {proj.technologies?.length ? (
                  <div className="text-[8px] text-gray-500">{proj.technologies.join(' · ')}</div>
                ) : null}
                <p className="text-gray-700">{proj.description}</p>
              </>
            ) : (
              <>
                <span className="font-bold">{proj.name}</span>
                {proj.technologies?.length ? (
                  <span className="text-[8px] text-gray-500">
                    {' '}
                    ({proj.technologies.join(', ')})
                  </span>
                ) : null}
                {proj.url && <span className={theme.projectUrlClass}>{proj.url}</span>}
                <p className="text-gray-700">{proj.description}</p>
              </>
            )}
          </div>
        ))}
      </div>
    ) : null

  const skillsBlock =
    data.skills && data.skills.length > 0 ? (
      <ResumeSkillsSection
        skills={data.skills}
        title={theme.skillsTitle}
        sectionClassName={gap}
        headerClassName={titleClass}
        renderCategory={cat => (
          <div className="mb-0.5">
            <span className="font-semibold">{cat.category}:</span>{' '}
            <span className="text-gray-700">{cat.items.join(', ')}</span>
          </div>
        )}
      />
    ) : null

  const experienceBlock =
    data.experience && data.experience.length > 0 ? (
      <div className={gap} data-resume-section="experience">
        <h2 data-resume-section-header={theme.experienceTitle} className={titleClass}>
          {theme.experienceTitle}
        </h2>
        {data.experience.map(exp => (
          <div key={exp.id} className={isGraduate ? 'mb-2' : 'mb-1.5'} data-resume-section-unit>
            <div className="flex justify-between items-baseline">
              <div>
                <span className="font-bold">{exp.title}</span>
                {exp.company && <span> — {exp.company}</span>}
              </div>
              <span className="text-[8px] text-gray-500 shrink-0 ml-2">
                {exp.startDate} - {exp.endDate || 'Present'}
              </span>
            </div>
            {exp.location && <div className="text-[8px] text-gray-500">{exp.location}</div>}
            {exp.bullets.filter(b => b.trim()).length > 0 && (
              <ul className="mt-0.5 space-y-0.5">
                {exp.bullets.filter(b => b.trim()).map((bullet, i) => (
                  <li key={i} className="text-gray-700 flex items-start gap-1">
                    <span
                      className={`shrink-0 mt-[3px] w-1 h-1 rounded-full ${theme.bulletDotClass}`}
                    />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    ) : null

  const certificationsBlock =
    data.certifications && data.certifications.length > 0 ? (
      <div className={gap} data-resume-section="certifications">
        <h2 data-resume-section-header="Certifications" className={titleClass}>
          Certifications
        </h2>
        {data.certifications.map((cert, i) => (
          <div key={i} className="mb-0.5" data-resume-section-unit>
            <span className="font-semibold">{cert.name}</span> — {cert.issuer}
            {cert.date && <span className="text-gray-500"> ({cert.date})</span>}
          </div>
        ))}
      </div>
    ) : null

  const customBlock =
    data.customSections && data.customSections.length > 0 ? (
      <>
        {data.customSections.map(section => (
          <div key={section.id} className={gap} data-resume-section={`custom-${section.id}`}>
            <h2 data-resume-section-header={section.title} className={titleClass}>
              {section.title}
            </h2>
            <p className="text-gray-700 whitespace-pre-wrap">{section.content}</p>
          </div>
        ))}
      </>
    ) : undefined

  const blocks: Partial<Record<BodySectionId, ReactNode>> = {
    summary: summaryBlock ?? undefined,
    education: educationBlock ?? undefined,
    projects: projectsBlock ?? undefined,
    skills: skillsBlock ?? undefined,
    experience: experienceBlock ?? undefined,
    certifications: certificationsBlock ?? undefined,
    customSections: customBlock,
  }

  const order = resolveSectionOrder(
    data.sectionOrder,
    isGraduate ? EARLY_CAREER_GRADUATE_ORDER : EARLY_CAREER_ACADEMIC_ORDER,
  )

  return (
    <TemplateRoot className="text-gray-900 leading-snug">
      <div className={theme.headerBorderClass}>
        <h1 className={theme.nameClass} style={{ fontSize: theme.nameSize }}>
          {contact.fullName || 'Your Name'}
        </h1>
        <ContactRow contact={contact} rowClass={theme.contactRowClass} />
      </div>
      {order.map(id => (blocks[id] ? <Fragment key={id}>{blocks[id]}</Fragment> : null))}
    </TemplateRoot>
  )
}
