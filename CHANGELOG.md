# Changelog

## 0.1.3

Fixes and guards from a full audit and live test run.

- **HTTP mode refuses to expose the server's TinyFish key.** With a server key and no `STACKS_HTTP_TOKEN`, Stacks now refuses to start on any address other than this machine. Before, the Docker image (which listens on all addresses) would serve the key to anyone who could reach the port. Deployments made from `render.yaml` always had a token and were not affected.
- **At most 4 pages are open at once in a remote browser.** Further calls wait their turn, in order. A burst of parallel tool calls can no longer push every page towards the 80 second deadline.
- **One log line per tool call, on stderr**: tool, duration, cache hit or miss, and the error code. No arguments, results or keys. Turn it off with `STACKS_LOG=off`.
- **`list_watches` no longer hides a failed live check.** With `check_now`, a title that cannot be read has the new `check_error` field (`code`, `message`) instead of a silent `current: null`.
- **`search_catalog` rejects a page past the last one** with `INVALID_INPUT` and the real page count. Before, it returned page 1 as if it were the page asked for.
- **An unknown branch is `NOT_FOUND` in every tool.** `search_catalog` and `list_events` used to answer `INVALID_INPUT`.
- A failed connection to the remote browser no longer puts the session's address in the error.
- `/healthz` reports `status` and `uptime_seconds`.
- `PORT` and `STACKS_AGENT_WAIT_MS` are checked at start-up; a value that is not a sensible number is a `CONFIG_ERROR`.
- `ask_library` says it waits about 40 seconds (the real default), explains itself when the Agent's result is unusable, and ignores a malformed address in a search result instead of failing.

## 0.1.2

- Stacks can be installed in Claude Desktop as a one-click bundle (`stacks.mcpb`, built with `npm run bundle`), with its own icon and a settings box for the TinyFish key.
- An interactive system explorer at https://viveksalwan2000.github.io/stacks-mcp/architecture.html, and a shorter, more visual README.

- `cancel_watch` takes `dry_run`: it reports which watch would be cancelled and deletes nothing. Its output now also names the watch (`library`, `title_id`, `title`).
- The tool contract is recorded in `test/__snapshots__/tool-schemas.json`; a test fails when any tool's name, description, input or output changes.
- New offline tests for the MCP protocol layer and for who the HTTP server lets in.
- CI runs ESLint and enforces a test coverage minimum.
- `SECURITY.md`, and a "Library compatibility report" issue form.

## 0.1.1

Fixes found by a full test pass of 0.1.0.

- **Agent fallback and `health_check --deep` now start.** TinyFish rejected the output schema Stacks sent for nullable fields, and the error was hidden. Nullable fields are now written as `nullable: true`. If a run still cannot start, the reason is reported in `details.fallback` or the new `diagnosis_error` field.
- **A fallback that reads nothing is a failed job**, not an empty result.
- **A `title_id` from another library no longer reports `SITE_CHANGED`.** The site redirects it to the library's own record for the same work; Stacks follows that and returns the library's own `title_id`.
- **A page that loads once without its data is read again** before `SITE_CHANGED` is declared, which removes a rare false alarm in tools and in the health check. The health check's Fetch layer does the same for a partly rendered page.

### Also in 0.1.1: data, input and hardening fixes

Data
- Availability status `library_use_only` for titles whose only copy in is for reading inside the library; these were reported as `available`.
- Copy counts are `null`, not `0`, when the site sends "available" without counts.
- Copy statuses are read from the library's own wording when the site only says `UNAVAILABLE` (Chicago's "Checked Out", Toronto's "On Loan").
- `registration_required` is true for events that use the library's sign-up system or an outside organiser; an ended sign-up window counts as closed.
- ISBNs are returned as bare numbers, once each.

Inputs and errors
- Unknown `format` and queries the site's firewall rejects are `INVALID_INPUT` with advice, not site errors.
- `check_availability` with a name that is no branch is `NOT_FOUND`.
- Queries are capped at 200 characters; impossible dates and private or localhost webhook addresses are refused.
- `get_job_result` with an unknown id is `NOT_FOUND`.
- `health_check` on an unknown library is `UNKNOWN_LIBRARY`; a site that refuses access is reported as `BLOCKED`, not changed.

Behaviour
- `watch_title` returns the existing watch (`already_existed: true`) instead of creating a duplicate.
- `list_events` takes a `limit`.
- `cancel_watch` is annotated as destructive.
- An unknown CLI argument exits with an error instead of starting the server.
- `--http` without a token listens on 127.0.0.1 only and refuses cross-site requests; tokens are compared in constant time. Set `HOST` to change the address.
- A page read can no longer hang: every read has an 80 s deadline, remote browser sessions are replaced after 4 minutes, and a broken session is retried once on a fresh one.
- `npm run qa` runs the live test matrix (`scripts/qa.ts`).
- vitest upgraded to 4.1.12: `npm audit` reports 0 vulnerabilities.

## 0.1.0

First release.

- 14 typed MCP tools for public libraries on BiblioCommons: `find_library`, `search_catalog`, `get_title`, `check_availability`, `estimate_wait`, `list_branches`, `get_branch`, `list_events`, `ask_library`, `get_job_result`, `watch_title`, `list_watches`, `cancel_watch`, `health_check`.
- Uses all five TinyFish endpoints: Search, Fetch, Browser, Agent and Monitor.
- stdio and Streamable HTTP transports.
- Directory of 54 library systems, verified live.
- Site contracts with typed `SITE_CHANGED` errors, a three-layer health check, and a daily CI canary.
