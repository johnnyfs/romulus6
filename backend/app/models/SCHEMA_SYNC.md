## Model Contracts

Critical functionality:
- `NodeType` is the shared source of truth for graph nodes, subgraph template nodes, and task template realized types.
- Run nodes are snapshots of concrete executable state plus the special run-only type `subgraph`.
- Task templates may realize only concrete node types: `agent`, `command`.
- Structured node payload fields (`argument_bindings`, `output_schema`, `image_attachments`, `output`) are JSONB-backed and should stay schema-aligned across graph/template/run models.
- Output schema supports field types: `string`, `number`, `boolean`, `image`. Image fields contain URL or data URI strings.

Best practices:
- Reuse `NodeType` instead of cloning enum definitions in sibling models.
- If a capability is added to a node concept, update graph/template/run storage together before shipping.
- Keep template-reference fields separate from concrete-node fields, but keep the allowed capability set aligned.
- Treat type changes as destructive shape changes: stale fields must be cleared, not ignored.
- Shared concepts should be centralized before they are copied: change the shared schema/validator first, then thread it through every expression of that concept.
