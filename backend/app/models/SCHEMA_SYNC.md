## Model Contracts

Critical functionality:
- `NodeType` is the shared source of truth for graph nodes, subgraph template nodes, and task template realized types.
- Run nodes are snapshots of concrete executable/view state plus the special run-only type `subgraph`.
- Task templates may realize only concrete node types: `agent`, `command`, `view`.

Best practices:
- Reuse `NodeType` instead of cloning enum definitions in sibling models.
- If a capability is added to a node concept, update graph/template/run storage together before shipping.
- Keep template-reference fields separate from concrete-node fields, but keep the allowed capability set aligned.
- Treat type changes as destructive shape changes: stale fields must be cleared, not ignored.
