## Router Contracts

Critical functionality:
- Routers translate API config payloads into shared backend node shapes.
- Graph, subgraph template, and run responses should expose the same concept with type-appropriate config fields.
- Child runs are fetched workspace-wide, so run responses must remain valid even when `graph_id` is `null`.

Best practices:
- Keep config extraction/serialization type-gated so stale fields cannot produce invalid response schemas.
- When a field is optional in patch APIs, distinguish "not provided" from "clear this" whenever type changes are possible.
- If a create endpoint supports a node capability, matching put/patch endpoints should support it too.
