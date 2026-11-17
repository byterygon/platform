## Temporal (TSK-83)

- A Temporal Web UI replacement over Temporal's gRPC API: add a profile (address, namespace, TLS and
  mutual TLS, a Temporal Cloud API key over TLS) and connect. Nothing but your own Temporal server
  is contacted.
- **Workflows**: every namespace of the cluster; a visibility-query bar with saved queries, quick
  status chips, the count, and paging.
- **Workflow detail**: a Timeline of the history (workflow, activities with their attempts, timers,
  child workflows, signals and updates), the History table with each event's attributes, the input
  and the result or the failure chain, pending activities (state, attempt, last failure, heartbeat)
  and child workflows, the stack trace through the worker, and queries. The history is followed live
  while the run is open. Payloads are decoded by encoding (JSON, text, null; Protobuf in binary and
  encrypted payloads are shown as opaque bytes for now).
- **Actions**, each behind a confirmation that names the workflow: signal (JSON arguments), request
  cancellation, terminate and reset (a reason is required), with a picker of the events to reset to.
- **Schedules**: list, describe, pause and resume with a note, run now with an overlap policy, and
  delete (type the id to confirm). **Task queues**: the workflow and activity pollers and the
  backlog when the server reports it.
- New generic component: `Timeline` in `packages/ui` (MIT OR Apache-2.0).
