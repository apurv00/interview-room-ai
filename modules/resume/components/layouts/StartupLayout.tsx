import type { ResumeData } from '../../validators/resume'
import type { StartupVariantId } from '../../config/startupThemes'
import { getStartupTheme } from '../../config/startupThemes'
import { partitionStartupCustomSections } from '../../lib/partitionStartupCustomSections'
import TemplateRoot from '../template-primitives/TemplateRoot'
import ResumeSkillsSection from '../ResumeSkillsSection'

interface Props {
  data: ResumeData
  variantId: StartupVariantId
}

function CustomBlock({
  sectionId,
  title,
  content,
  titleClass,
}: {
  sectionId: string
  title: string
  content: string
  titleClass: string
}) {
  return (
    <div className="mb-3" data-resume-section={sectionId}>
      <h2 data-resume-section-header={title} className={titleClass}>
        {title}
      </h2>
      <p className="text-gray-700 whitespace-pre-wrap">{content}</p>
    </div>
  )
}

export default function StartupLayout({ data, variantId }: Props) {
  const theme = getStartupTheme(variantId)
  const contact = data.contactInfo || { fullName: '', email: '' }
  const titleClass = theme.sectionTitleClass
  const { sideProjects, interests, other } = partitionStartupCustomSections(data.customSections)
  const sep = theme.contactSeparator

  return (
    <TemplateRoot className="text-gray-900 leading-snug">
      <div className="mb-3 pb-2 border-b border-gray-200">
        <h1
          className="font-extrabold tracking-tight bg-clip-text text-transparent"
          style={{ fontSize: 'var(--r-title, 20px)', backgroundImage: theme.headerGradient }}
        >
          {contact.fullName || 'Your Name'}
        </h1>
        <div className="flex items-center gap-2 text-[8px] text-gray-500 mt-1 flex-wrap">
          {contact.email && <span>{contact.email}</span>}
          {contact.phone && (
            <>
              <span>{sep}</span>
              <span>{contact.phone}</span>
            </>
          )}
          {contact.location && (
            <>
              <span>{sep}</span>
              <span>{contact.location}</span>
            </>
          )}
          {contact.linkedin && (
            <>
              <span>{sep}</span>
              <span>{contact.linkedin}</span>
            </>
          )}
          {contact.website && (
            <>
              <span>{sep}</span>
              <span>{contact.website}</span>
            </>
          )}
          {contact.github && (
            <>
              <span>{sep}</span>
              <span>{contact.github}</span>
            </>
          )}
        </div>
      </div>

      {data.summary && (
        <div className="mb-3" data-resume-section="summary">
          <h2 data-resume-section-header={theme.summaryTitle} className={titleClass}>
            {theme.summaryTitle}
          </h2>
          <p className="text-gray-700 leading-relaxed">{data.summary}</p>
        </div>
      )}

      {data.skills && data.skills.length > 0 && (
        <ResumeSkillsSection
          skills={data.skills}
          title="Skills"
          sectionClassName="mb-3"
          headerClassName={titleClass}
          renderCategory={(cat, ci) => (
            <div className="mb-1.5">
              <div className="text-[8px] font-semibold text-gray-600 mb-0.5">{cat.category}</div>
              <div className="flex flex-wrap gap-1">
                {cat.items.map((item, ii) => {
                  const color = theme.tagColors[(ci + ii) % theme.tagColors.length]
                  return (
                    <span key={`${ci}-${ii}`} className={`text-[8px] px-1.5 py-0.5 rounded-full ${color}`}>
                      {item}
                    </span>
                  )
                })}
              </div>
            </div>
          )}
        />
      )}

      {data.experience && data.experience.length > 0 && (
        <div className="mb-3" data-resume-section="experience">
          <h2 data-resume-section-header="Experience" className={titleClass}>
            Experience
          </h2>
          {data.experience.map(exp => (
            <div key={exp.id} className="mb-2" data-resume-section-unit>
              <div className="flex justify-between items-baseline">
                <div>
                  <span className="font-bold">{exp.title}</span>
                  {exp.company && (
                    <span className={theme.companyAtClass}> @ {exp.company}</span>
                  )}
                </div>
                <span className="text-[8px] text-gray-400 shrink-0 ml-2">
                  {exp.startDate} - {exp.endDate || 'Present'}
                </span>
              </div>
              {exp.location && <div className="text-[8px] text-gray-400">{exp.location}</div>}
              {exp.bullets.filter(b => b.trim()).length > 0 && (
                <ul className="mt-0.5 space-y-0.5">
                  {exp.bullets.filter(b => b.trim()).map((bullet, i) => (
                    <li key={i} className="text-gray-700 flex items-start gap-1">
                      <span
                        className={`shrink-0 mt-[3px] w-1 h-1 rounded-full ${theme.bulletGradientClass}`}
                      />
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {data.projects && data.projects.length > 0 && (
        <div className="mb-3" data-resume-section="projects">
          <h2 data-resume-section-header="Projects" className={titleClass}>
            Projects
          </h2>
          {data.projects.map(proj => (
            <div key={proj.id} className="mb-1.5" data-resume-section-unit>
              <div className="flex items-baseline gap-1">
                <span className="font-bold">{proj.name}</span>
                {proj.url && <span className={theme.projectUrlClass}>{proj.url}</span>}
              </div>
              {proj.technologies?.length ? (
                <div className="flex flex-wrap gap-0.5 mt-0.5">
                  {proj.technologies.map((tech, i) => (
                    <span
                      key={i}
                      className="text-[7px] px-1 py-0.5 rounded bg-gray-100 text-gray-600"
                    >
                      {tech}
                    </span>
                  ))}
                </div>
              ) : null}
              <p className="text-gray-700 mt-0.5">{proj.description}</p>
            </div>
          ))}
        </div>
      )}

      {sideProjects.map(section => (
        <CustomBlock
          key={section.id}
          sectionId={`custom-${section.id}`}
          title={section.title}
          content={section.content}
          titleClass={titleClass}
        />
      ))}

      {data.education && data.education.length > 0 && (
        <div className="mb-3" data-resume-section="education">
          <h2 data-resume-section-header="Education" className={titleClass}>
            Education
          </h2>
          {data.education.map(edu => (
            <div key={edu.id} className="mb-1.5" data-resume-section-unit>
              <div className="flex justify-between items-baseline">
                <div>
                  <span className="font-bold">{edu.degree}</span>
                  {edu.field && <span> in {edu.field}</span>}
                  {edu.institution && <span className="text-gray-500"> — {edu.institution}</span>}
                </div>
                {edu.graduationDate && (
                  <span className="text-[8px] text-gray-400 shrink-0 ml-2">
                    {edu.graduationDate}
                  </span>
                )}
              </div>
              {(edu.gpa || edu.honors) && (
                <div className="text-[8px] text-gray-400">
                  {edu.gpa && <span>GPA: {edu.gpa}</span>}
                  {edu.gpa && edu.honors && <span> · </span>}
                  {edu.honors && <span>{edu.honors}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {data.certifications && data.certifications.length > 0 && (
        <div className="mb-3" data-resume-section="certifications">
          <h2 data-resume-section-header="Certifications" className={titleClass}>
            Certifications
          </h2>
          {data.certifications.map((cert, i) => (
            <div key={i} className="mb-0.5" data-resume-section-unit>
              <span className="font-semibold">{cert.name}</span> — {cert.issuer}
              {cert.date && <span className="text-gray-400"> ({cert.date})</span>}
            </div>
          ))}
        </div>
      )}

      {interests.map(section => (
        <CustomBlock
          key={section.id}
          sectionId={`custom-${section.id}`}
          title={section.title}
          content={section.content}
          titleClass={titleClass}
        />
      ))}

      {other.map(section => (
        <CustomBlock
          key={section.id}
          sectionId={`custom-${section.id}`}
          title={section.title}
          content={section.content}
          titleClass={titleClass}
        />
      ))}
    </TemplateRoot>
  )
}
