# Changelog

## Unreleased

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
