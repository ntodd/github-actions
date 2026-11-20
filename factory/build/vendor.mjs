// Development-only build. The generated parser and license travel with the
// workflow's pinned tools checkout; callers never need npm install.
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "node_modules/yaml/package.json"), "utf8"));
const result = await build({ absWorkingDir: root, entryPoints: ["factory/build/yaml-entry.mjs"], bundle: true,
  format: "esm", platform: "browser", target: "es2022", minify: true, write: false, legalComments: "eof",
  banner: { js: `// Generated from yaml ${pkg.version}; ISC license in YAML-LICENSE. Run npm run vendor:build.` } });
const files = [["factory/vendor/yaml.mjs", result.outputFiles[0].text],
  ["factory/vendor/YAML-LICENSE", await readFile(join(root, "node_modules/yaml/LICENSE"), "utf8")]];
for (const [path, text] of files) {
  if (process.argv.includes("--check")) {
    if (await readFile(join(root, path), "utf8") !== text) throw new Error(`${path} differs from the pinned source; run npm run vendor:build`);
  } else await writeFile(join(root, path), text);
}
console.log(process.argv.includes("--check") ? "Vendored YAML parser matches its pinned source." : "Built vendored YAML parser.");
