/**
 * Build stacks.mcpb, the one-click bundle for Claude Desktop.
 *
 * It contains the compiled server, its production dependencies, the icon and a
 * manifest. The manifest's version and tool list are filled in from the code, so
 * they cannot drift. Run with `npm run bundle` (which builds first).
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const stage = `${root}.mcpb-build`;
const out = `${root}stacks.mcpb`;
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
const { TOOLS } = await import(`${root}dist/tools/index.js`);

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage);
cpSync(`${root}dist`, `${stage}/server`, { recursive: true, filter: (src) => !/\.(map|d\.ts)$/.test(src) });
cpSync(`${root}mcpb/icon.png`, `${stage}/icon.png`);
cpSync(`${root}LICENSE`, `${stage}/LICENSE`);
cpSync(`${root}package-lock.json`, `${stage}/package-lock.json`);
// Only what the server needs to run: no scripts, no dev dependencies.
writeFileSync(`${stage}/package.json`, JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", license: pkg.license, dependencies: pkg.dependencies }, null, 2));

const manifest = JSON.parse(readFileSync(`${root}mcpb/manifest.json`, "utf8"));
manifest.version = pkg.version;
manifest.tools = TOOLS.map((t) => ({ name: t.name, description: t.title }));
writeFileSync(`${stage}/manifest.json`, JSON.stringify(manifest, null, 2));

run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
run("npx", ["--yes", "@anthropic-ai/mcpb@2.1.2", "validate", "manifest.json"], stage);
run("npx", ["--yes", "@anthropic-ai/mcpb@2.1.2", "pack", ".", out], stage);
console.log(`\nBuilt stacks.mcpb ${pkg.version} (${(statSync(out).size / 1e6).toFixed(1)} MB, ${TOOLS.length} tools).`);
