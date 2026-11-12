# Changelog

## 0.1.1

Fixes found by a full test pass of 0.1.0.

- **Agent fallback and `health_check --deep` now start.** TinyFish rejected the output schema Stacks sent for nullable fields, and the error was hidden. Nullable fields are now written as `nullable: true`. If a run still cannot start, the reason is reported in `details.fallback` or the new `diagnosis_error` field.
- **A fallback that reads nothing is a failed job**, not an empty result.
- **A `title_id` from another library no longer reports `SITE_CHANGED`.** The site redirects it to the library's own record for the same work; Stacks follows that and returns the library's own `title_id`.
- **A page that loads once without its data is read again** before `SITE_CHANGED` is declared, which removes a rare false alarm in tools and in the health check. The health check's Fetch layer does the same for a partly rendered page.

## 0.1.0

First release.

- 14 typed MCP tools for public libraries on BiblioCommons: `find_library`, `search_catalog`, `get_title`, `check_availability`, `estimate_wait`, `list_branches`, `get_branch`, `list_events`, `ask_library`, `get_job_result`, `watch_title`, `list_watches`, `cancel_watch`, `health_check`.
- Uses all five TinyFish endpoints: Search, Fetch, Browser, Agent and Monitor.
- stdio and Streamable HTTP transports.
- Directory of 54 library systems, verified live.
- Site contracts with typed `SITE_CHANGED` errors, a three-layer health check, and a daily CI canary.
