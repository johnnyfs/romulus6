This directory holds shared Python contract code used by both the backend and worker.

Right now we are intentionally keeping this simple:

- shared runtime/model registries
- shared structured-output schema helpers
- shared worker API request/response models

The backend and worker are still expected to ship together from the same repo, so
we are not versioning these contracts yet.

Before full productionization, we will need explicit contract versioning and
backward-compatibility rules so rolling deploys can tolerate mixed backend/worker
revisions more deliberately.
