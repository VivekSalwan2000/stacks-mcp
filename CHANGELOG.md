# Changelog

## 0.1.0

First release.

- 14 typed MCP tools for public libraries on BiblioCommons: `find_library`, `search_catalog`, `get_title`, `check_availability`, `estimate_wait`, `list_branches`, `get_branch`, `list_events`, `ask_library`, `get_job_result`, `watch_title`, `list_watches`, `cancel_watch`, `health_check`.
- Uses all five TinyFish endpoints: Search, Fetch, Browser, Agent and Monitor.
- stdio and Streamable HTTP transports.
- Directory of 54 library systems, verified live.
- Site contracts with typed `SITE_CHANGED` errors, a three-layer health check, and a daily CI canary.
