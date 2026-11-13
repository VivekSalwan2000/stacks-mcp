# Stacks

**Give your AI agent a library card.**

Stacks is an [MCP](https://modelcontextprotocol.io) server that turns public-library websites into typed tools an AI agent can call. Ask Claude or ChatGPT *"Is Project Hail Mary on the shelf near me, and is that branch open tonight?"* and it gets a real answer, read live from the library's website.

Public libraries have no API. Their catalogues, branch pages and event calendars are websites built for people. Stacks uses [TinyFish](https://tinyfish.ai) to read and operate those sites, and hands the agent clean, structured data.

[![CI](https://github.com/VivekSalwan2000/stacks-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/VivekSalwan2000/stacks-mcp/actions/workflows/ci.yml)
[![Canary](https://github.com/VivekSalwan2000/stacks-mcp/actions/workflows/canary.yml/badge.svg)](https://github.com/VivekSalwan2000/stacks-mcp/actions/workflows/canary.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

- **One server, hundreds of library systems.** Stacks targets [BiblioCommons](https://www.bibliocommons.com), the platform behind 200+ public library systems. The built-in directory has 54 systems verified live (Toronto, Vancouver, Chicago, Seattle, San Francisco, Boston, Ottawa, Calgary, Edmonton, King County, Austin and more), and `find_library` discovers others on demand.
- **14 typed tools.** Every tool has a typed input schema, a typed output schema, and returns structured data. No page dumps.
- **Live, not indexed.** Copy-level availability, hold queues, today's hours and this week's events are read from the site when you ask.
- **Breaks loudly.** If a library changes its website, tools return a typed `SITE_CHANGED` error naming the exact field that broke. A health check and a daily CI canary catch it.

## Why not just let the agent search the web?

| | Web search in ChatGPT or Claude | Stacks |
|---|---|---|
| "Is it on the shelf at my branch?" | Cannot see it. Availability loads with JavaScript and is not in any search index. | Copy-level status per branch, with call numbers and due dates |
| Freshness | Days or weeks old | Read at call time |
| Filtering | Whatever the snippet shows | Typed filters: branch, date range, audience, format |
| Multi-step tasks | Guesses between steps | Chains real ids: search → availability → branch hours → events |
| When the site changes | Confidently stale | A typed error and a failing health check |

## Quick start

You need Node 20+ and a [TinyFish API key](https://agent.tinyfish.ai).

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude:

```json
{
  "mcpServers": {
    "stacks": {
      "command": "npx",
      "args": ["-y", "stacks-mcp"],
      "env": { "TINYFISH_API_KEY": "your-key" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add stacks -e TINYFISH_API_KEY=your-key -- npx -y stacks-mcp
```

### Cursor, Windsurf and other stdio clients

Use the same `command`, `args` and `env` as the Claude Desktop block above.

### ChatGPT and other remote clients

ChatGPT connects to MCP servers over HTTPS, so run Stacks in HTTP mode on a host:

```bash
TINYFISH_API_KEY=your-key STACKS_HTTP_TOKEN=choose-a-secret npx -y stacks-mcp --http
```

Your MCP URL is `https://<your-host>/mcp/<your-secret>`. In ChatGPT: Settings → Connectors → Advanced → Developer mode, then add a connector with that URL and no authentication. To deploy on Render's free tier, use the included [`render.yaml`](render.yaml) and [`Dockerfile`](Dockerfile).

### From source

```bash
git clone https://github.com/VivekSalwan2000/stacks-mcp.git
cd stacks-mcp
npm install
cp .env.example .env        # then put your TinyFish key in .env
npm run build
npm run e2e                 # calls every core tool against three live libraries
```

## Tools

| Tool | What it does | TinyFish endpoint |
|---|---|---|
| `find_library` | City or library name → `library_id` | Fetch (plus Search for libraries outside the directory) |
| `search_catalog` | Search books, eBooks, audiobooks, DVDs. Typed titles with availability and hold counts | Browser |
| `get_title` | Description, contributors, publisher, ISBNs, subjects, other formats | Browser |
| `check_availability` | Copy-level availability by branch: on shelf, checked out, due dates, call numbers | Browser |
| `estimate_wait` | Estimated wait if you place a hold today, and formats with a shorter queue | Browser |
| `list_branches` | Branches with address, today's hours, open-now, distance from a point | Browser |
| `get_branch` | Weekly hours, holiday closures, services, accessibility, parking | Browser |
| `list_events` | Programs filtered by branch, dates, audience and type | Browser |
| `ask_library` | Open questions about services and policies, answered from the library's own site | Search → Fetch → Agent |
| `get_job_result` | Result of a slow Agent run | Agent |
| `watch_title` | Standing watch that detects when a title's availability changes | Monitor |
| `list_watches` | Your watches, with live availability on request | Monitor |
| `cancel_watch` | Delete a watch | Monitor |
| `health_check` | Proves every tool still works, or reports exactly what broke | Fetch + Browser + Agent |

Full input and output schemas: [docs/TOOLS.md](docs/TOOLS.md) (generated from the code).

### Example: one question, five tool calls

*"I'm in Toronto. Is Project Hail Mary on the shelf anywhere, is that branch open now, and what's on there this week?"*

These are real calls and timings from `npm run e2e`:

```text
find_library({ query: "Toronto" })                                              2.4 s
  → tpl = Toronto Public Library
search_catalog({ library: "tpl", query: "Project Hail Mary", format: "book" })  5.3 s
  → "Project Hail Mary", Book, 2021: 178 holds on 216 copies
check_availability({ library: "tpl", title_id: "S234C3970025" })                3.1 s
  → on the shelf at 1 of 92 branches: North York Central Library
get_branch({ library: "tpl", branch: "North York Central Library" })            3.3 s
  → open now, 09:00 to 20:30, 18 services
list_events({ library: "tpl", branch: "North York Central Library",
              start_date: "2026-11-12", end_date: "2026-11-19" })               6.6 s
  → 39 events
```

A real `check_availability` result, trimmed to one branch and two copies:

```json
{
  "library": "tpl",
  "title_id": "S234C3970025",
  "title": "Project Hail Mary",
  "format": { "code": "BK", "label": "Book" },
  "summary": { "status": "available", "total_copies": 216, "available_copies": 2, "holds": 178, "on_order_copies": 0 },
  "branches_holding": 92,
  "branches_on_shelf": 1,
  "branches": [
    {
      "branch_code": "CL",
      "branch_name": "North York Central Library",
      "copies_total": 8,
      "copies_on_shelf": 1,
      "next_due_date": "2026-11-19",
      "copies": [
        { "status": "on_shelf", "status_label": "Available Not Holdable", "collection": "Browsery 1st Fl Fiction", "call_number": "SCIENCE FICTION WEI", "due_date": null },
        { "status": "checked_out", "status_label": "On Loan", "collection": "Lang & Lit 3rd Fl Fiction", "call_number": "SCIENCE FICTION WEI", "due_date": "2026-11-28" }
      ]
    }
  ],
  "truncated": true,
  "source": { "engines": ["browser"], "url": "https://tpl.bibliocommons.com/v2/record/S234C3970025", "cached": false, "retrieved_at": "2026-11-12T01:07:45.256Z" }
}
```

## How TinyFish is used

Every network call Stacks makes is a TinyFish call. There is no canned data and no other scraping stack. All five endpoints do real work:

**Fetch** reads pages as clean text. It is the fastest and cheapest endpoint, so Stacks uses it wherever plain text is enough:
- `find_library` confirms a catalogue is live and reads the library's name.
- `ask_library` reads the candidate pages found by Search and picks the best one as the Agent's starting point, which keeps Agent runs short.
- `health_check` fetches each page and checks that its landmark sections are still there. This is the first, cheapest layer of change detection.
- The directory of 54 libraries is built and re-verified with Fetch (`npm run refresh-registry`).

**Agent** navigates and reasons. It is much slower (1 to 3 minutes for a full answer), so Stacks gives it the jobs that need judgment:
- `ask_library` answers open questions ("How do I get a card as a non-resident?") by browsing the library's own website and returning an answer with its source URLs.
- **Fallback.** If a fast tool hits `SITE_CHANGED`, Stacks starts an Agent run to read the page anyway and returns its `fallback_job_id` inside the error. The break is still reported either way. The fallback is best-effort: in testing the Agent sometimes read no rows from a page, and Stacks reports such a run as a failed job, never as an empty result.
- **Diagnosis.** `health_check --deep` sends an Agent to a failing page to describe what changed, so the maintainer starts with an explanation.

Agent runs can outlast a client's tool timeout, so Agent tools wait up to 40 seconds and then return a `job_id` for `get_job_result`.

**Browser** runs a remote Chromium that Stacks drives over CDP. BiblioCommons renders its data with JavaScript, so Fetch alone sees an empty shell. Stacks loads the page and reads the JSON the page itself renders from, plus, on title pages, the page's own background request for per-branch availability. That is how the core tools return complete, structured data in 2 to 5 seconds. One warm browser session is reused across calls.

**Search** finds library catalogues that are not in the built-in directory, and finds the right page on a library's website for `ask_library`.

**Monitor** powers `watch_title`: TinyFish re-reads a title's page on a schedule, detects changes, and notifies a webhook or the TinyFish dashboard.

| Measured latency (live, Toronto Public Library) | |
|---|---|
| `search_catalog`, `check_availability`, `get_branch` | 2 to 5 s |
| `list_events` with filters | 5 to 7 s |
| Any repeat call within the cache window | under 20 ms |
| `ask_library` | 1 to 3 minutes (returns a `job_id` after about 50 s) |

## Breaks loudly, not silently

Websites change. A scraper that quietly returns an empty list is worse than one that crashes, because the agent will tell the user "there are no copies" when the truth is "I can't tell". Stacks is built so that cannot happen.

**1. A contract for every page.** [`contracts.ts`](src/adapters/bibliocommons/contracts.ts) declares exactly which fields Stacks depends on. Every page read is validated against it. If a field is renamed or removed, the tool fails. This is the actual error from a test that removes `title` from a recorded search page:

```json
{
  "error": {
    "code": "SITE_CHANGED",
    "message": "The site's search page data no longer matches what Stacks expects (12 field problems).",
    "hint": "The website changed. Run the health_check tool for a full report and open an issue at https://github.com/VivekSalwan2000/stacks-mcp/issues.",
    "retryable": false,
    "details": {
      "tool": "search_catalog",
      "contract": "search page",
      "url": "https://tpl.bibliocommons.com/v2/search?query=dune&searchType=smart",
      "broken_fields": [
        "entities.bibs.S234C2504662.briefInfo.title: Invalid input: expected string, received undefined",
        "entities.bibs.S234C3943037.briefInfo.title: Invalid input: expected string, received undefined"
      ],
      "fallback_job_id": "search.00000000-0000-4000-8000-000000000001",
      "fallback": "A slower TinyFish Agent run was started to read the page instead. Poll get_job_result with fallback_job_id. Its result is best-effort and not schema-validated."
    }
  }
}
```

**2. "No results" and "broken" are different answers.** A search for nonsense returns `total: 0`. A page that lost its data returns `SITE_CHANGED`. A results list that points at records missing from the page is an error, never a shorter list.

**3. A health check you can run anywhere.**

```bash
npx stacks-mcp health --library tpl
```

```text
Stacks health check: tpl
Healthy: 9 passed, 0 warning(s), 0 skipped.

  [PASS] locations page is reachable and intact  (fetch)
  [PASS] events page is reachable and intact  (fetch)
  [PASS] search page is reachable and intact  (fetch)
  [PASS] search_catalog returns typed results  (browser)
         367 results; first: "Harry Potter and the Philosopher's Stone" (Book)
  [PASS] search_catalog tells 'no results' apart from 'broken'  (browser)
  [PASS] check_availability returns copy-level data  (browser)
  [PASS] list_branches returns branches with hours  (browser)
         101 branches; 64 open now
  [PASS] list_events returns typed events  (browser)
         5980 upcoming events; 6 audiences, 27 event types
  [PASS] platform version  (browser)
         BiblioCommons 9.38.3 (the verified version)
```

It exits non-zero when anything fails. The same check is the `health_check` tool, so an agent can run it mid-conversation. It also reports the platform's version number: a version bump with passing contracts is a warning that a change is coming.

**4. A daily canary in CI.** [`canary.yml`](.github/workflows/canary.yml) runs the health check against three libraries every day. When it fails, it opens an issue containing the report and an Agent diagnosis job.

**5. Tests that simulate site changes.** [`test/breaks-loudly.test.ts`](test/breaks-loudly.test.ts) mutates recorded pages (renames a field, drops the data, removes the availability request) and asserts that each tool fails with the right error. These run offline in CI on every push.

All error codes: `INVALID_INPUT`, `UNKNOWN_LIBRARY`, `NOT_FOUND`, `NOT_SUPPORTED`, `SITE_CHANGED`, `SITE_BLOCKED`, `SITE_UNAVAILABLE`, `UPSTREAM_TIMEOUT`, `RATE_LIMITED`, `TINYFISH_ERROR`, `CONFIG_ERROR`, `JOB_FAILED`. Each comes with a `hint` that says what to do next.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TINYFISH_API_KEY` | required | Your TinyFish key |
| `STACKS_DEFAULT_LIBRARY` | none | Library id used when a call omits `library` |
| `STACKS_PROXY` | `auto` | `off`, `auto` (retry through a TinyFish proxy if blocked), `tinyfish`, or a country code |
| `STACKS_AGENT_WAIT_MS` | `40000` | How long Agent tools wait before returning a `job_id` |
| `STACKS_HTTP_TOKEN` | none | Secret required by `--http` mode when it uses the server's own key |
| `PORT` | `3000` | Port for `--http` mode |
| `HOST` | see below | Address `--http` mode listens on |

In `--http` mode a caller can send their own key in an `x-tinyfish-api-key` header. Without that header the server uses its own key, and only for requests that present `STACKS_HTTP_TOKEN`. If no token is set, the server listens on `127.0.0.1` only and refuses requests that carry another website's `Origin`, so it is safe for local use but not reachable remotely.

Arguments that do not match a tool's input schema are rejected by the MCP layer before the tool runs, with a plain message naming the field (for example `Too big: expected number to be <=50 at page`). Every other failure uses the structured `{ error: { code, message, hint } }` format.

## Responsible use

Stacks is a guest on library websites, and it behaves like one:

- **Read-only.** It never logs in, places holds, registers for events or submits forms. It needs no library card and handles no personal data.
- **On demand.** It loads a page when a person asks a question. It does not crawl.
- **Light.** Results are cached (availability 5 minutes, search 10, events 30, branches 60), requests to one host are spaced out, and images, fonts and stylesheets are never downloaded.
- **Only public pages.** It loads the same pages a visitor would, and stays off paths that `robots.txt` disallows.
- **Staff-only fields stay private.** Page data sometimes includes internal notes. Stacks reads only the fields in its contract, and a test asserts the rest never appears in output.

## Limits

- **BiblioCommons libraries only**, for now. Libraries on other platforms return an empty `find_library` result. New platforms are added as adapters: see [Contributing](#contributing).
- **No account actions.** Placing holds and renewing need a login, which Stacks does not do.
- **Some libraries block automated browsers.** New York Public Library currently does. Stacks reports `SITE_BLOCKED` rather than guessing.
- **Not every library uses every module.** Seattle, for example, runs its events and branch pages elsewhere. Those tools return `NOT_SUPPORTED` there, and `ask_library` still works.
- **`estimate_wait` is an estimate** computed from queue length and due dates. It says so in its output.

## How it is built

```
src/
  core/        Site-agnostic: TinyFish client, cache, typed errors, jobs, tool registration
  adapters/
    types.ts   The LibraryAdapter interface every platform implements
    bibliocommons/
      contracts.ts   The fields Stacks depends on (the "breaks loudly" contract)
      parse.ts       Pure functions: page data → public data model
      adapter.ts     Which pages to load and how
      registry.json  Verified libraries
  schemas.ts   The public, platform-independent data model
  tools/       The 14 MCP tools
  health/      Canaries and the health report
```

More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

Contributions are welcome, and the project is laid out to make them small:

- **Add a library** to the directory: one line in [`scripts/registry-candidates.json`](scripts/registry-candidates.json), then `npm run refresh-registry`.
- **Fix a break**: when the canary opens an issue, the fix is usually a few lines in `contracts.ts` and `parse.ts`, plus a new fixture.
- **Add a platform** (Aspen Discovery, Koha, Polaris, Evergreen): implement `LibraryAdapter`. The tools, schemas, health check and tests are reused. See [docs/ADDING_AN_ADAPTER.md](docs/ADDING_AN_ADAPTER.md).

- **Report how a library behaves**: tried Stacks on your own library? File a [library compatibility report](https://github.com/VivekSalwan2000/stacks-mcp/issues/new?template=library-report.yml), whether it worked or not.

Start with [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, see [SECURITY.md](SECURITY.md).

## Roadmap

- Adapters for Aspen Discovery and Koha
- Opt-in account actions (holds, renewals) using TinyFish Vault, with the user's explicit consent
- A `nearest_copy` tool that combines availability, distance and opening hours
- Branch-level watches

## License

MIT. Stacks is an independent open-source project. It is not affiliated with or endorsed by BiblioCommons or any library.

Built for the [TinyFish](https://tinyfish.ai) Student Bounty, Drop 002: Site to MCP.
