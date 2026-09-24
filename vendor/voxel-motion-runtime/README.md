# Official motion evaluator snapshot

Downloaded 2026-09-23 from the public Voxel Studio runtime:
https://voxel-studio-backend.zeabur.app/api/templates/module.js
and its relative dependencies geometry-schema.js, world-anim-core.js, obb.js.

Source files are preserved unchanged. Lifetime injects its own Three.js instance.
This snapshot makes legacy plan evaluation available to the local compiler without
executing dynamically fetched code on the server. Unsupported non-pose effects and
world templates requiring unavailable lookups are explicitly rejected by Lifetime.
Update the complete dependency set together and run motion/compiler regression tests.
