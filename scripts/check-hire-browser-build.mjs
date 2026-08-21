import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const nextDir = resolve(process.cwd(), '.next')
const requiredFiles = JSON.parse(
  await readFile(resolve(nextDir, 'required-server-files.json'), 'utf8'),
)
const marker = requiredFiles?.config?.env?.HIRE_MULTIMODAL_BUILD_ENABLED
if (marker !== 'true') {
  throw new Error('Hire browser build marker is not enabled in the built artifact')
}

const healthBundle = await readFile(
  resolve(nextDir, 'server/app/api/health/route.js'),
  'utf8',
)
if (
  healthBundle.includes('process.env.NEXT_PUBLIC_FEATURE_MULTIMODAL') ||
  healthBundle.includes('process.env.HIRE_MULTIMODAL_BUILD_ENABLED')
) {
  throw new Error('Hire health bundle still reads its build marker at runtime')
}
if (!healthBundle.includes('hireInterviewBuild')) {
  throw new Error('Hire health bundle does not expose authenticated build evidence')
}

console.log('Hire browser build marker is compiled and enabled.')
