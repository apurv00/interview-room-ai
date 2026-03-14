// Resume module barrel export

// Services
export { listResumes, getResume, saveResume, deleteResume, getUserProfileContext, getProfileForResume } from './services/resumeService'
export { enhanceSection, enhanceBullets, generateFullResume, checkATS, tailorResume, parseResumeToStructured } from './services/resumeAIService'

// Validators & Types
export { ResumeSchema, GenerateSchema, ATSCheckSchema, TailorSchema, ParseResumeSchema, PDFGenerateSchema } from './validators/resume'
export type {
  ResumeData, ResumeContactInfo, ResumeExperience, ResumeEducation,
  ResumeSkillCategory, ResumeProject, ResumeCertification, ResumeCustomSection,
} from './validators/resume'

// Config
export { RESUME_TEMPLATES, TEMPLATE_COLOR_MAP } from './config/templates'
export type { ResumeTemplate } from './config/templates'

// Wizard
export {
  calculateStrengthScore, WIZARD_SEGMENTS, WIZARD_STAGES, WIZARD_COST_CAP_USD,
  CreateWizardSessionSchema, SubmitStageSchema, GenerateFollowUpsSchema,
  EnhanceWizardSchema, ReviewSubmitSchema, ExportWizardSchema,
} from './wizard'
