/** Private company identity assets for Hire workspaces. */
export {
  uploadHireWorkspaceLogo,
  readHireWorkspaceLogo,
  decodeHireWorkspaceLogoDataUrl,
  type HireWorkspaceLogoUploadInput,
  type HireWorkspaceLogoView,
} from './services/workspaceBrandingService'
export {
  HIRE_WORKSPACE_LOGO_MAX_BYTES,
  hireWorkspaceBrandingStorage,
  hireWorkspaceLogoKey,
  parseHireWorkspaceLogoKey,
  assertHireWorkspaceLogoKeyScope,
  type HireWorkspaceBrandingStoragePort,
} from './services/workspaceBrandingStorage'
export {
  UploadHireWorkspaceLogoSchema,
  type UploadHireWorkspaceLogoPayload,
} from './validators/workspaceBranding'
