## Service Contracts

Critical functionality:
- `node_shapes.py` owns node capability rules and type-change normalization.
- Graph creation, graph patching, subgraph template patching, and run materialization must all use the same node-shape assumptions.
- Template materialization is where schema drift becomes runtime failures, so changes here need regression tests.
- `node_references.py` owns workspace-scoped template reference validation; no graph/template/run path should bypass it.
- `node_configs.py` owns router-level agent/command/view config translation so config changes land everywhere together.

Best practices:
- Add or change node capabilities in one shared helper first, then thread that through graph/template/run flows.
- Gate serializers and materializers by `node_type`; never infer behavior from leftover fields alone.
- When adding a new node option, cover all four paths: create, patch, materialize, serialize.
- Prefer additive tests that exercise stale-data transitions, not just happy-path fresh creation.
- Prefer structured JSON fields over ad-hoc text blobs for repeated node payloads.
