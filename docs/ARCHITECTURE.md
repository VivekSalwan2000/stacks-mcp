# Architecture

## The path of one tool call

```
MCP client (Claude, ChatGPT, Cursor)
   │  tools/call check_availability { library: "tpl", title_id: "S234C3970025" }
   ▼
src/core/tool.ts          validates input against the tool's Zod schema, catches every error
   ▼
src/tools/catalog.ts      resolves the library, applies filters and limits
   ▼
src/adapters/bibliocommons/adapter.ts
   │  1. cache hit? return it (availability is cached for 5 minutes)
   │  2. web.readPage(url)  →  TinyFish Browser loads the page
   │  3. contract(RawRecordState, state)  →  SITE_CHANGED if the page data changed shape
   │  4. parse.ts  →  the public data model
   ▼
structuredContent  +  source { engines, url, cached, retrieved_at }
```

## Layers

**`src/core/`** knows nothing about libraries.

- `web.ts` is the only file that talks to the network. It wraps the five TinyFish endpoints behind a `Web` interface, keeps one warm remote browser, retries through a proxy when a site blocks the direct route, and counts calls per endpoint.
- `errors.ts` defines `StacksError`, the error codes, and `contract()`, which validates scraped data and names the broken fields.
- `cache.ts` is a TTL cache with in-flight de-duplication, plus a per-host rate limiter.
- `jobs.ts` turns slow Agent runs into job ids. A job id is `<kind>.<tinyfish run id>`, so there is no job store: jobs survive restarts and work across instances.
- `tool.ts` registers tools with the MCP SDK and converts thrown errors into structured error results.

**`src/adapters/`** knows one library platform each. An adapter implements `LibraryAdapter` (`types.ts`). The BiblioCommons adapter has three parts, split so that the fragile part is small and testable:

- `contracts.ts`: Zod schemas for the fields Stacks reads from the site. This is the contract with the website.
- `parse.ts`: pure functions from validated page data to the public model. No network, so they are tested against fixtures.
- `adapter.ts`: which URL to load for each operation, what to cache, and how to tell "not found", "not supported", "blocked" and "changed" apart.

**`src/schemas.ts`** is the public data model (`Title`, `BranchAvailability`, `Branch`, `LibraryEvent`). It is platform-independent on purpose: a Koha adapter returns the same shapes.

**`src/tools/`** holds the MCP tools. They contain no scraping logic; they call the adapter and shape the result.

**`src/health/`** holds the canaries.

## How BiblioCommons pages are read

A BiblioCommons page server-renders its data into `<script type="application/json" data-iso-key="_0">`. That JSON holds the search results, the event list or the branch list, already structured. TinyFish Fetch returns cleaned page text, which drops script tags, so Stacks uses TinyFish Browser: it loads the page in a remote Chromium and reads that element.

Per-branch availability is not in the page. The title page requests it in the background after loading. Stacks listens for that response while the page loads and reads its JSON. It never requests that URL itself.

Images, fonts, stylesheets and media are blocked in the browser session, and the read stops at `DOMContentLoaded`.

## Distinguishing failure modes

| What happened | How it is detected | Error |
|---|---|---|
| No such library | 404, or a redirect off the library's host | `UNKNOWN_LIBRARY` |
| Bot protection | 403 or 429 with no page data, after a proxy retry | `SITE_BLOCKED` |
| Site outage | 5xx on a core page | `SITE_UNAVAILABLE` |
| Library does not run that module | 5xx on the locations page, or an events page with an untouched initial state | `NOT_SUPPORTED` |
| Title does not exist | The title page loads with no record | `NOT_FOUND` |
| Site changed shape | Page loads but the data element is gone, the contract fails, results reference missing records, or the availability request never fires | `SITE_CHANGED` |
| Genuinely nothing found | The site reports zero results | A normal, empty result |

## Testing strategy

- **Unit tests** (`npm test`) run offline. `FakeWeb` serves recorded pages from `test/fixtures/`. `breaks-loudly.test.ts` mutates those pages to simulate site changes.
- **End-to-end** (`npm run e2e`) drives the real MCP protocol with an in-memory client against live sites.
- **Canary** (`.github/workflows/canary.yml`) runs the health check daily and opens an issue on failure.
