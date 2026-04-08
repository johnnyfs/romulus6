## Frontend API Contracts

Critical functionality:
- Frontend graph/template/run types should mirror backend response shapes, especially for shared node concepts.
- Subgraph template node types should reuse the shared node type union rather than drifting into a sibling copy.
- Run detail views must tolerate child runs and run-only node type `subgraph`.

Best practices:
- When backend adds a node capability, update graph/template/run TS models in the same change.
- Keep create/update request bodies aligned with backend support so one endpoint is not missing a sibling capability.
- Prefer shared config interfaces (`agent_config`, `command_config`, `view_config`) over ad hoc per-surface fields when possible.
