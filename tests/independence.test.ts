import { it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
it("has no sibling-project imports or generation clients in the rendering slice", () => {
  const source = path.resolve("src");
  function visit(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      if (!/\.(ts|js)$/.test(file)) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(
        /(?:from\s*|import\s*\()['"](\.[^'"]+)['"]/g,
      )) {
        const target = path.resolve(path.dirname(file), match[1]);
        expect(target.startsWith(path.resolve(".") + path.sep), file).toBe(
          true,
        );
      }
      if (file.includes(`${path.sep}rendering${path.sep}`))
        expect(text, file).not.toMatch(
          /fetch\(|\/api\/(generate|chat)|worldforge-baseline/,
        );
    }
  }
  visit(source);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(pkg.dependencies["@voxel-studio/render-runtime"]).toBe(
    "file:vendor/voxel-render-runtime",
  );
});
