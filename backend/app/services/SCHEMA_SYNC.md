## Service Contracts

Critical functionality:
- `node_shapes.py` owns node capability rules and type-change normalization.
- Graph creation, graph patching, subgraph template patching, and run materialization must all use the same node-shape assumptions.
- Template materialization is where schema drift becomes runtime failures, so changes here need regression tests.

Best practices:
- Add or change node capabilities in one shared helper first, then thread that through graph/template/run flows.
- Gate serializers and materializers by `node_type`; never infer behavior from leftover fields alone.
- When adding a new node option, cover all four paths: create, patch, materialize, serialize.
- Prefer additive tests that exercise stale-data transitions, not just happy-path fresh creation.
