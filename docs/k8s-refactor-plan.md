# Kubernetes Refactor Plan

## Goal

Move Romulus to a Kubernetes-managed in-cluster control plane where:

- backend runs in the cluster with the worker pool
- frontend remains the only host-local long-running dev process
- workers are pooled long-lived pods, not one Deployment/Service per sandbox
- workers push events to backend
- backend provides a single workspace-scoped event stream
- graph progression becomes event-triggered plus reconciliation-driven

## Why This Refactor Exists

Current repo behavior is still centered on sandbox-scoped workers:

- `make dev` starts Minikube, a Docker-managed Postgres, and a host-local backend.
- sandbox creation calls `app.services.workers.create_worker()`, which creates a dedicated Deployment and Service per sandbox.
- run dispatch assumes one sandbox maps to one worker URL.
- agent and run event handling still pulls/streams directly from worker APIs.
- worker/session state is in-memory inside the worker process.

That model is fine for early iteration, but it creates the exact problems we now need to remove:

- provisioning latency on every sandbox/run
- Kubernetes object churn
- direct backend-to-worker coupling
- no durable worker liveness model
- no single backend-owned event stream for the frontend

## North Star Architecture

### Control plane ownership

- Kubernetes owns runtime placement and scaling for:
  - backend
  - Postgres
  - worker pool
- Backend is the system of record for:
  - workspaces
  - sandboxes
  - workers
  - leases
  - runs
  - events
  - reconciliation state
- Frontend talks only to backend.

### Worker contract

Workers become long-lived execution engines that:

- register with backend on startup
- heartbeat periodically
- advertise readiness/capabilities
- accept leased sandbox work
- execute commands / agent sessions for the lease they hold
- push execution events to backend

### Backend contract

Backend becomes responsible for:

- assigning work to pooled workers
- persisting worker lifecycle state
- persisting normalized events
- exposing workspace-scoped SSE
- applying immediate event-driven state transitions
- recovering from worker loss or lease expiry

### Controller contract

The controller is a periodic orchestration loop that:

- reevaluates which pending work is dispatchable
- triggers dispatch for eligible nodes
- reevaluates worker heartbeat freshness
- forces stale-worker consequences to be applied
- later can own retry scheduling

Important boundary:

- backend owns event receipt, persistence, and immediate state mutation
- controller owns periodic reevaluation and triggering next actions
- if the controller lives in the backend codebase, it should call service-layer orchestration code directly rather than self-HTTP unless we intentionally split it into a separate process later

## Non-Goals For This Refactor

These are intentionally out of scope unless a stage explicitly pulls them in:

- production-grade multi-cluster deployment
- service mesh / ingress redesign
- multi-tenant security hardening beyond current local-dev needs
- true multi-sandbox concurrency within a single worker pod
- replacing Postgres with another queue or event bus
- perfect autoscaling before the worker-pool model is stable

## Guiding Constraints

### Constraints we should preserve during rollout

- local development should stay one-command to start
- frontend hot reload should remain host-local
- we should keep the system usable between stages
- schema changes should be additive first, destructive later
- backend should remain the single compatibility layer while worker APIs evolve

### Temporary simplifications we should accept

- one sandbox leases one worker
- one worker handles at most one active sandbox lease at a time
- worker registration can be backend-driven over HTTP without introducing a message broker
- Stage 1 can keep direct backend-to-worker execution calls for sessions and commands
- polling compatibility can remain briefly while worker-push event ingestion lands
- if a worker dies while work is running, that work fails immediately for now

## Current Code Touchpoints

The first implementation slices will primarily move through these files:

- `Makefile`
- `backend/app/k8s.py`
- `backend/app/database.py`
- `backend/app/services/workers.py`
- `backend/app/services/sandboxes.py`
- `backend/app/services/runs.py`
- `backend/app/services/agents.py`
- `backend/app/models/worker.py`
- `backend/app/models/sandbox.py`
- `backend/app/models/event.py`
- `worker/app/main.py`
- `worker/app/session_manager.py`
- `worker/app/config.py`
- `worker/k8s/*.yaml`

## Stage Breakdown

## Stage 1: In-Cluster Dev Baseline

### Goal

Run backend, worker pool, and database inside Kubernetes for local dev, with frontend as the only host-local long-running process.

### Why Stage 1 comes first

The rest of the refactor depends on backend and workers sharing in-cluster networking and configuration. Until that exists, every later worker-pool and eventing change gets distorted by local-vs-cluster routing workarounds.

### Deliverables

- add backend Kubernetes manifests
- add dev Postgres Kubernetes manifests
- convert the current worker deployment into a dev worker-pool deployment
- update `Makefile` so `make dev`:
  - ensures Minikube is running
  - ensures namespace exists
  - builds required images
  - applies db/backend/worker manifests
  - applies config/secrets
  - waits for readiness
  - runs migrations inside the backend container or via a one-shot Job
  - starts frontend locally and blocks there
- add:
  - `make dev-down`
  - `make dev-clean`
  - `make dev-restart-backend`
- rename:
  - `backend` -> `dev-backend`
  - `frontend` -> `dev-frontend`
  - `db` -> `dev-db`
  - `migrate` -> `dev-db-migrate`

### Concrete execution plan

#### 1. Add Kubernetes resources for backend and dev database

Files likely involved:

- `backend/k8s/deployment.yaml`
- `backend/k8s/service.yaml`
- `backend/k8s/configmap.yaml`
- `backend/k8s/secret.yaml` or secret generation in `Makefile`
- `backend/k8s/migrate-job.yaml` or equivalent
- `infra/k8s/dev-db/*.yaml` or `backend/k8s/postgres-*.yaml`

Work:

- deploy backend as a single-replica Deployment
- expose backend internally as a ClusterIP Service
- deploy Postgres with a PVC for dev persistence
- inject `DB_HOST` as the in-cluster Postgres service DNS name
- inject `DEPLOY_MODE=kubernetes` for in-cluster backend startup
- ensure backend can load in-cluster k8s config without special host setup

#### 2. Normalize dev manifest layout

Work:

- stop treating `worker/k8s` as the only Kubernetes folder
- choose a stable manifest layout for backend, worker, and database
- keep namespace/config/secret conventions consistent across workloads
- decide whether shared resources live under one top-level `k8s/` tree or per-service trees

Recommendation:

- prefer a repo-level `k8s/dev/` layout or similarly obvious shared location, because this refactor is becoming system-wide rather than worker-only

#### 3. Update worker deployment into a configurable pool

Current state:

- `worker/k8s/deployment.yaml` defines a single static `worker` Deployment
- config points workers at `http://romulus-backend:8000/api/v1`

Work:

- rename semantics from “the worker” to “worker pool”
- set replica count from `WORKER_POOL_TARGET`
- keep a single Service only if backend still needs direct access to pooled worker pods in Stage 1
- remove the static NodePort once frontend no longer needs direct worker access
- keep resource requests/limits explicit so Minikube scheduling is predictable

#### 4. Replace Docker Postgres in dev workflow

Current state:

- `make db` launches Docker Postgres with `.pg-data`
- backend migrations run against host env

Work:

- move dev database into Kubernetes
- keep `dev-clean` responsible for deleting DB PVC state
- make migration execution target the in-cluster database
- keep the user-facing flow simple enough that no manual port-forward should be required for normal `make dev`

#### 5. Rewrite Make targets around the new topology

Work:

- `make dev`: cluster bootstrap, image build, apply manifests, wait, migrate, run frontend
- `make dev-down`: delete backend/worker/db workloads but preserve DB PVC
- `make dev-clean`: run `dev-down`, then remove PVCs and any generated local build artifacts
- `make dev-restart-backend`: re-apply config/secret, restart backend deployment, wait for rollout
- rename legacy targets without breaking muscle memory abruptly

Recommendation:

- keep compatibility aliases for one iteration if helpful, but the doc and default workflow should use the `dev-*` names immediately

### Stage 1 acceptance criteria

- `make dev` deploys backend + db + worker pool in Kubernetes and starts frontend locally
- no Docker-managed local Postgres is required
- backend reaches Postgres via cluster DNS
- backend reaches worker pool via cluster DNS or pod DNS as needed
- `make dev-down`, `make dev-clean`, and `make dev-restart-backend` are reliable
- renamed `dev-*` targets exist
- a developer can delete the namespace and recover with `make dev`

### Stage 1 risks

- image build/load mechanics into Minikube may be brittle
- migrations as a Job can race backend startup if not sequenced carefully
- worker access may still assume stable per-worker URLs even after moving in-cluster
- if we keep direct worker calls in Stage 1, we need a clear temporary access pattern before Stage 2 rewrites it

## Stage 2: Replace Per-Sandbox Worker Provisioning With Worker Pool

### Goal

Stop creating Kubernetes resources per sandbox and instead lease work onto long-lived pooled workers.

### Required model changes

#### Worker model

Current `Worker` fields are centered on ephemeral k8s objects:

- `deployment_name`
- `service_name`
- `nodeport_service_name`
- `node_port`
- `worker_url`

Target direction:

- keep a persistent worker row per pool member
- store worker identity and liveness fields, for example:
  - `worker_key` or registration token
  - `status`
  - `last_heartbeat_at`
  - `registered_at`
  - `capabilities`
  - `current_lease_id`
  - `pod_name`
  - `pod_ip` if temporarily needed
- treat Kubernetes metadata as observational, not the primary identity

#### Lease model

Add a first-class lease table instead of encoding assignment only through `sandbox.worker_id`.

Suggested initial fields:

- `id`
- `workspace_id`
- `sandbox_id`
- `worker_id`
- `status` (`pending`, `active`, `expired`, `released`, `failed`)
- `leased_at`
- `heartbeat_expires_at`
- `released_at`
- `failure_reason`

#### Sandbox model

Target direction:

- sandbox remains a logical workspace execution environment
- sandbox should have a current worker assignment tracked by backend
- that assignment should be modeled through a lease/current-assignment concept rather than making sandbox identity equal worker identity
- avoid making sandbox lifetime equal worker pod lifetime

### API and workflow changes

#### Backend APIs to add

- `POST /workers/register`
- `POST /workers/{id}/heartbeat`
- `POST /workers/{id}/leases/{lease_id}/claim` or equivalent
- possibly `POST /workers/{id}/leases/{lease_id}/release`

#### Worker startup flow

1. pod starts
2. worker registers with backend
3. backend creates/updates worker row
4. worker begins heartbeating
5. worker becomes eligible for leasing

#### Sandbox creation flow

1. backend creates sandbox row
2. backend finds an idle healthy worker
3. backend creates lease row
4. backend marks lease active when worker claims it or backend assigns it directly
5. sandbox becomes usable without any k8s object creation

### Code changes expected

- remove k8s resource creation from `backend/app/services/workers.py`
- stop calling dynamic manifest builders in normal sandbox creation flow
- update `backend/app/services/sandboxes.py` to lease a worker rather than create one
- separate “worker registration” from “sandbox allocation”
- review all places that assume `sandbox.worker_id` is enough to find an active worker URL

### Phase-1 constraints

- one sandbox leases one worker
- one active lease per worker
- no packing multiple sandboxes onto one worker yet

### Stage 2 acceptance criteria

- sandbox creation does not create a Deployment or Service
- worker rows represent pooled pods, not per-sandbox resources
- backend can allocate an idle worker to a sandbox
- basic worker restart/re-registration works without orphaning the whole system

## Stage 3: Push Event Ingestion To Backend

### Goal

Move from backend polling and worker SSE passthrough to worker-pushed event ingestion with backend-owned persistence and streaming.

### Current behavior to unwind

- `backend/app/services/agents.py` fetches and streams worker session events directly
- `backend/app/services/runs.py` watches worker SSE directly
- event persistence stores source event data, but the frontend stream is not backend-owned at workspace scope

### Target event model

Persist worker-originated events with both:

- `event_time`: timestamp from the worker/origin event
- `received_at`: backend receipt time

Recommended schema direction:

- keep raw payload
- store events in one receipt-ordered table using backend arrival time as the primary stream ordering
- add normalized routing fields for:
  - `workspace_id`
  - `run_id`
  - `node_id`
  - `agent_id`
  - `sandbox_id`
  - `worker_id`
  - `event_type`
- preserve source identifiers for audit/debugging

Recommended ordering semantics:

- `received_at` is the authoritative stream cursor for frontend consumption
- origin `event_time` is preserved for display/debugging and causal analysis
- frontend should be able to consume a workspace stream via addressable `since` / `limit` pagination or SSE resume semantics

### Backend additions

- worker-to-backend event ingestion endpoint
- durable event persistence path
- workspace-scoped SSE endpoint that reads from backend-owned state
- optional agent-scoped and run-scoped filtered views backed by the same event store

### Worker additions

- event forwarder that posts normalized events to backend
- retry/backoff on transient backend failure
- idempotency key usage if worker retries can duplicate events

### Transitional compatibility

For a short period we may keep existing pull paths:

- backend polling of worker events for compatibility
- agent event endpoints backed by a mix of DB state and direct worker reads

But the exit criteria for this stage should explicitly remove them.

### Stage 3 acceptance criteria

- worker events are pushed to backend
- backend persists `event_time` and `received_at`
- frontend can subscribe to one workspace-scoped SSE stream from backend
- direct worker SSE passthrough is no longer required for steady-state behavior

## Stage 4: Event-Driven Reconciliation

### Goal

Graph progression is driven by persisted events plus explicit reconciliation instead of inline graph traversal buried inside event handlers.

### Target pattern

1. event arrives
2. backend persists it
3. backend applies immediate state transition
4. backend enqueues reconciliation
5. reconciler recomputes eligible work and dispatches it

In practice, “dispatches it” should mean triggering the same backend service-layer dispatch logic we use elsewhere, not necessarily making an HTTP round-trip back into the same backend process.

### Required pieces

- reconcile queue/table or dirty-run mechanism
- idempotent reconcile function
- controller loop/process for dequeueing and evaluating runs
- dispatch logic that can safely run multiple times without duplicating work

### Why this matters

Right now run progression is tightly coupled to live event watchers. That makes recovery, retries, and worker-loss handling harder because “what should happen next?” depends too much on who happened to be watching when the event arrived.

### Recommended first implementation

- add a simple `run_reconcile` table or equivalent dirty flag
- enqueue by `run_id`
- dedupe enqueues cheaply
- run a single background reconciler/controller loop in backend first
- only later consider separate processes or queue infra

Suggested node state progression:

- node is created as `pending`
- controller identifies it as dispatchable
- controller triggers dispatch
- dispatch path moves it through `dispatching` into `running`
- backend finalizes it from worker events into terminal state

### Stage 4 acceptance criteria

- event handlers do not perform full graph traversal inline
- reconcile logic can be rerun safely after retries or restarts
- eligible work is derived from stored run/node state, not volatile watcher state

## Stage 5: Worker Failure And Timeout Handling

### Goal

Recover predictably from stale, unhealthy, or lost workers.

### Required behavior

- heartbeat timeout marks worker unhealthy or lost
- stale-worker scan expires active leases
- affected runs are enqueued for reconciliation
- backend/controller marks all work running on that worker failed for now
- later stages can layer retries and fresh sandbox assignment on top

### Implementation direction

- add periodic stale-worker scan in backend
- define lease expiry duration and worker heartbeat interval together
- mark worker rows with health status transitions rather than deleting immediately
- make reconciliation the single place that determines resulting run/node state

### Stage 5 acceptance criteria

- killing a worker pod no longer leaves runs permanently stuck
- expired leases are visible in the database
- affected runs transition predictably after reconciliation

## Stage 6: Autoscaling

### Goal

Let Kubernetes manage pool size once the worker-pool model and lease accounting are stable.

### Rollout

- start with fixed replica count from `WORKER_POOL_TARGET`
- later add HPA or KEDA
- treat `WORKER_POOL_MAX` as the upper bound where sensible

### Preferred scaling signals

- pending lease count
- idle worker count
- dispatch/reconcile backlog

Avoid relying only on CPU if the bottleneck is availability of idle workers rather than compute saturation.

### Stage 6 acceptance criteria

- autoscaling decisions are based on work availability, not only pod CPU
- scale-up does not break worker registration or lease assignment
- scale-down does not strand active leases without recovery logic

## Recommended Execution Order

This is the lowest-risk order to begin implementation:

1. land Stage 1 dev topology and `Makefile` changes
2. add additive schema for pooled workers and leases
3. implement worker registration and heartbeat
4. switch sandbox creation from “create worker” to “lease worker”
5. remove per-sandbox k8s resource creation
6. add backend event ingestion endpoint and worker event forwarder
7. move frontend/event consumers onto backend-owned workspace SSE
8. introduce reconciliation queue/mechanism
9. add stale-worker recovery
10. add autoscaling only after the above is stable

## First Execution Slice

This should be small enough to start immediately after agreement on a few open questions.

### Slice A

Make local dev run fully in-cluster except for frontend.

Scope:

- add backend Deployment/Service manifests
- add Postgres Deployment/Service/PVC manifests
- refactor `Makefile` to `dev-*` targets
- make migrations run against in-cluster DB
- keep current direct backend-to-worker execution behavior unchanged

Out of scope for Slice A:

- worker registration
- lease model
- event ingestion redesign
- reconciliation changes

### Slice B

Introduce pooled worker registration and leasing without changing event delivery yet.

Scope:

- add worker registration/heartbeat tables and endpoints
- add lease table
- update sandbox creation to lease existing worker
- stop creating per-sandbox Deployments/Services

Out of scope for Slice B:

- backend-owned workspace SSE
- removal of all direct worker event streaming

## Open Questions Requiring Decisions

These are the main questions that still affect implementation shape:

1. Should we reorganize manifests under a new shared `k8s/` tree now, or keep per-service `backend/k8s` and `worker/k8s` folders for the first pass?
2. For Stage 1 migrations, do we prefer a one-shot Kubernetes Job or an imperative `kubectl exec`/`kubectl run` flow in `Makefile`?
3. Do we want the backend to call workers through a stable Service in Stage 1, or is per-pod addressing acceptable until leasing is implemented?
4. When a worker pod restarts during an active lease, should the first recovery policy be “retry on a new worker” or “fail the affected run and surface it clearly”?
5. Do we want to preserve the existing `sandbox.worker_id` relationship as a compatibility field during Stage 2, or replace it quickly with lease-centric lookup?

## Recommendation On The Open Questions

Unless you want a different direction, I would proceed with:

- a shared repo-level `k8s/dev/` manifest tree
- a migration Job for reproducibility
- a temporary stable worker Service for Stage 1 only
- “fail clearly, then reconcile” as the first worker-loss policy before adding retries
- keeping `sandbox.worker_id` temporarily as a compatibility field while introducing leases

## Definition Of Done For The Refactor

This refactor is complete when:

- `make dev` gives us frontend-on-host and everything else in Kubernetes
- sandbox creation no longer creates k8s resources
- workers are durable pooled pods with registration and heartbeats
- events are pushed to backend and persisted with origin and receipt time
- frontend consumes backend-owned workspace SSE
- graph progression is driven through reconciliation
- worker loss is recoverable and visible
- pool size can be scaled without changing application logic
