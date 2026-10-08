/** Read actual assets; all editing/saving takes place in an isolated temporary copy. */
import { mkdtemp, mkdir, copyFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { Store } from "../src/server/store";
import { createServer } from "../src/server/http";
const dir = await mkdtemp(path.join(os.tmpdir(), "lifetime-scene-qa-"));
for (const kind of ["actors", "maps", "performances"])
  await mkdir(path.join(dir, "data", kind), { recursive: true });
await copyFile(
  "data/actors/ad884db6-3f98-4402-9bf5-a28293a4bbd3.json",
  path.join(dir, "data/actors/ad884db6-3f98-4402-9bf5-a28293a4bbd3.json"),
);
await copyFile(
  "data/maps/139a63d1-44bf-4bbf-a2f4-b5e705e3ad36.json",
  path.join(dir, "data/maps/139a63d1-44bf-4bbf-a2f4-b5e705e3ad36.json"),
);
const demo = "2d833328-fe63-40de-90af-ec6ad8871e6c.json";
if (
  await access(`data/performances/${demo}`).then(
    () => true,
    () => false,
  )
)
  await copyFile(
    `data/performances/${demo}`,
    path.join(dir, "data/performances", demo),
  );
await build({
  build: { outDir: path.join(dir, "dist") },
  define: {
    "import.meta.env.VITE_GENERATION_API": JSON.stringify(
      "http://127.0.0.1:5294",
    ),
  },
});
createServer(new Store(path.join(dir, "data")), path.join(dir, "dist")).listen(
  5294,
  "127.0.0.1",
  () => console.log(`Scene QA http://127.0.0.1:5294/ ; temporary data ${dir}`),
);
