# Hire ingestion revision protocol v2 rollout

This cutover must be performed independently on the isolated Hire control and
runtime surfaces. Do not allow result or full-analysis delivery while the old
attempt-unaware indexes are being replaced.

1. Deploy the v2 code to control with
   `HIRE_INGESTION_REVISION_PROTOCOL_MODE=draining` and set
   `HIRE_INGESTION_REVISION_PROTOCOL_DRAIN_STARTED_AT` to the deployment time
   in ISO-8601 format. Both affected routes now return retryable HTTP 503.
2. Deploy the v2 runtime. Its result and analysis publishers send
   `x-hire-ingestion-revision-protocol: 2`; delivery remains queued while
   control is draining.
3. Wait at least six minutes. This exceeds the affected route's five-minute
   execution ceiling, so no old admitted request remains in flight.
4. On `IPG_SURFACE=hire-control`, run
   `npm run prepare:hire-ingestion-revision-protocol -- --apply`.
5. On `IPG_SURFACE=hire-engine`, run the same apply command. The command
   refuses to mutate indexes unless draining mode and the elapsed timestamp
   are both present. It also blocks on any already-attempted legacy result or
   analysis publisher row without an immutable payload snapshot. Reconcile
   those rows against control-plane event state; never synthesize a snapshot
   from the current mutable session after an ambiguous old send.
6. Run `npm run check:hire-ingestion-revision-protocol` on both surfaces.
   Before release, run the opt-in real transaction gate against a disposable
   replica-set database whose name ends in `_test`:
   `HIRE_INGESTION_REPLICA_SET_TEST_URI=... HIRE_INGESTION_REPLICA_SET_TEST_DATABASE=hire_ingestion_test npm exec vitest -- run modules/hire/__tests__/ingestionRevisionReservation.replica.integration.test.ts`.
7. Change control to `HIRE_INGESTION_REVISION_PROTOCOL_MODE=required`, retaining
   the original drain timestamp. Re-run the check. Only senders presenting
   protocol version 2 can now enter ingestion. Authenticated control health
   must report `hireIngestionRevisionProtocol={protocolVersion:"2",mode:"required",releaseReady:true}`
   before handoff issuance may leave smoke/draining mode.

Do not enable mixed runtime workers after the drain. Version-2 publishers
persist an exact serialized result/analysis payload before the first network
send; an ambiguous acknowledgement is retried from that snapshot without
reading the mutable engine session. Control copies checksum-verified media into
inactive staging checkpoints and activates the complete batch only in the
event/result terminal transaction. Operators must therefore preserve
`pendingResultPayloadJson`, analysis `payloadSnapshotJson`, and staging media
rows during retries; privacy purge and terminal acknowledgement clear them.

The control merge must retain the P0 opaque object-key authority: every new
checkpoint generation has a fresh random nonce, every Put is conditional with
`If-None-Match: *`, and a retry may adopt only the exact GET-verified staged
object. A `purged` or `purge_failed` generation is sealed history and always
advances to a fresh id/nonce.

Rollback is ingress-first: set control back to `draining`, wait six minutes,
and investigate. Do not restore old unique indexes while attempt-aware rows
exist. The runtime outboxes retain retry state during the closed window.
