// Feedback module barrel export.
//
// Most consumers (app/feedback/[sessionId]/page.tsx) reach the components via
// dynamic `import('@feedback/components/X')` calls, which need real file paths
// — those bypass this barrel by design. This file is here so other domain
// modules and tests have a single, stable surface to import from rather than
// reaching into internal paths.
//
// Add an export here when another module needs to consume a feedback symbol;
// the @feedback/* deep-import path stays usable from app/ and tests only.

export { default as OverviewTab } from './components/OverviewTab'
export { default as ScoresTab } from './components/ScoresTab'
export { default as AudioPlayer } from './components/AudioPlayer'
export { type PeerData } from './components/PeerComparison'
