# Manual QA: Long Interview Upload And Analysis

Use this checklist after deploying recording compression, multipart replay upload, and transcript-first analysis.

## Setup

- Use a staging/prod environment with valid MongoDB, Redis, R2, Deepgram, auth, and Inngest configuration.
- Set `REPLAY_RECORDING_RETENTION_DAYS` in Vercel.
- Run `node scripts/set-r2-cors.js` against the target R2 bucket and confirm it succeeds.
- Open browser DevTools Network tab with throttling disabled for the happy path.

## Happy Path: 20-30 Minute Interview

- Start a 20-30 minute camera-enabled interview.
- Confirm the browser requests camera at 720p/24fps or lower where supported.
- End the interview and confirm the app navigates to feedback without waiting for the camera replay upload to finish.
- Confirm `/api/generate-feedback` and `/api/analysis/start` are requested soon after completion.
- Confirm `/api/analysis/start` returns `200` or an existing-job response, not `400` due to missing recording upload.
- Confirm replay upload uses `/api/storage/multipart` for large camera/screen blobs.
- Confirm each uploaded part PUT returns an exposed `ETag` header.
- Refresh the feedback page after analysis completes and confirm the AI Analysis tab loads.
- Confirm the replay video appears once `recordingR2Key` is patched to the session.

## Interrupted Upload Path

- Start another long interview and end it.
- During replay upload, switch DevTools to offline or block R2 requests.
- Confirm feedback and analysis remain usable.
- Return online and reload the feedback page.
- Confirm queued replay upload retries from IndexedDB and eventually patches the session recording key.

## Privacy Mode Path

- Start an interview with privacy mode enabled.
- Confirm camera/screen replay uploads are skipped.
- Confirm transcript-based feedback and multimodal analysis still run.
- Confirm no replay video button is shown when no replay URL exists.

## Retention Cleanup

- In staging, set `REPLAY_RECORDING_RETENTION_DAYS` to a small value or seed an old completed session.
- Trigger or wait for the `recording-retention-cleanup` Inngest job.
- Confirm old `recordingR2Key` and `screenRecordingR2Key` objects are deleted from R2.
- Confirm transcript, feedback, `multimodalAnalysisId`, `audioRecordingR2Key`, and `facialLandmarksR2Key` remain intact.

## Failure Signals To Watch

- `/api/storage/multipart` returns `403`: key/session ownership mismatch.
- R2 part PUT succeeds but no `ETag` is readable: CORS expose headers are wrong.
- `/api/analysis/start` returns `400`: transcript/live words were not persisted.
- Feedback page waits for replay upload before rendering: replay upload has become blocking again.
