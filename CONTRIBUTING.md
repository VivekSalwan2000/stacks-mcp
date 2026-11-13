# Contributing to Stacks

Thanks for helping. Stacks is meant to grow through small, focused contributions.

## Setup

```bash
git clone https://github.com/VivekSalwan2000/stacks-mcp.git
cd stacks-mcp
npm install
cp .env.example .env    # add your TinyFish key; .env is git-ignored
```

| Command | What it does | Needs a TinyFish key |
|---|---|---|
| `npm test` | Unit tests against recorded pages | no |
| `npm run test:coverage` | The same tests, with a coverage report and a minimum that must be met | no |
| `npm run test:update` | Re-records the tool contract snapshot after an intended change | no |
| `npm run lint` | ESLint | no |
| `npm run typecheck` | TypeScript, strict | no |
| `npm run e2e` | Calls every core tool on three live libraries, through MCP | yes |
| `npm run e2e -- --all` | Also runs the Agent tool and a Monitor round trip | yes |
| `npm run health -- --library tpl` | The live health check | yes |
| `npm run docs` | Regenerates `docs/TOOLS.md` from the tool definitions | no |
| `npm run bundle` | Builds `stacks.mcpb`, the one-click bundle for Claude Desktop | no |

Never commit a real API key. `.env.example` must stay blank.

## Three kinds of contribution

### 1. Add a library to the directory

If a library's catalogue is at `https://<id>.bibliocommons.com`:

1. Add `{ "id": "<id>", "city": "...", "region": "...", "country": "..." }` to `scripts/registry-candidates.json`.
2. Run `npm run refresh-registry`. It checks every candidate live with TinyFish Fetch and writes the ones that respond to `registry.json`.
3. Open a PR with both files.

### 2. Fix a tool after a site change

When the daily canary fails it opens an issue labelled `site-broke` with the broken fields.

1. Reproduce: `npm run health -- --library <id> --deep`.
2. The contract lives in `src/adapters/bibliocommons/contracts.ts`; the mapping to the public model is in `parse.ts`. Most fixes touch only these two files.
3. Record the new page shape as a fixture in `test/fixtures/` (strip anything not in the contract, and never include staff-only fields or personal data).
4. Add or update a test. If you loosened a contract, add a case to `test/breaks-loudly.test.ts` proving the tool still fails when the field is truly gone.
5. If the platform version changed, update `KNOWN_PLATFORM_VERSION` in `src/health/checks.ts`.

### 3. Add a platform adapter

See [docs/ADDING_AN_ADAPTER.md](docs/ADDING_AN_ADAPTER.md).

## Rules the code follows

- **TinyFish does the web work.** All network access goes through `src/core/web.ts`. Do not add `fetch`, axios, cheerio or a local browser.
- **Typed in, typed out.** Every tool has Zod input and output schemas. Outputs use the shared models in `src/schemas.ts`.
- **Never fail silently.** If the site does not give you what the contract expects, throw a `StacksError`. Do not return `[]`, `null` or a default to paper over it. "Nothing found" is only a valid answer when the site itself says so.
- **Every error says what to do next.** Include a `hint`.
- **Read-only and polite.** No logins, no form submissions, no crawling. Cache what you read.
- **The tool contract is recorded.** `test/__snapshots__/tool-schemas.json` holds every tool's name, description and input and output shape, and a test fails when any of them changes. If you meant the change, run `npm run test:update` and `npm run docs`, and commit both files so reviewers see exactly what clients will see. Removing or renaming a field is a breaking change: say so in the PR.
- **Anything that deletes takes `dry_run`.** A tool that removes something must offer a preview that changes nothing.
- **No `console.log` in `src/`.** In stdio mode, stdout carries the MCP protocol. Use `console.error`.
- **Small contracts.** Only require a field in `contracts.ts` if a tool uses it. Every required field is a way for the site to break us.

## Pull requests

Keep them small and say how you tested. CI runs lint, typecheck, unit tests with a coverage minimum, and a build on Node 20 and 22.

Found a security problem? Do not open an issue: see [SECURITY.md](SECURITY.md).
