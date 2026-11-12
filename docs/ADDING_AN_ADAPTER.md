# Adding a platform adapter

Stacks supports BiblioCommons today. Other library platforms (Aspen Discovery, Koha, Polaris, Evergreen, SirsiDynix Enterprise) can be added without touching the tools, the public schemas or the health framework.

## What you implement

`LibraryAdapter` in [`src/adapters/types.ts`](../src/adapters/types.ts):

| Method | Returns |
|---|---|
| `validId`, `catalogUrl`, `recordUrl` | URL helpers for the platform |
| `getLibrary(id)` | Name, home URL, time zone, platform version |
| `search(id, params)` | `Title[]` with availability summaries and pagination |
| `getTitle(id, titleId)` | `TitleDetails` plus per-branch `BranchAvailability[]` |
| `listBranches(id)` | `Branch[]` |
| `listEvents(id, params)` | `LibraryEvent[]` with pagination and filter vocabulary |
| `landmarks(id)` | Pages and the text they must contain (for the Fetch layer of the health check) |
| `agentFallback(kind, id, arg)` | A goal and output schema for an Agent run that reads the same data the slow way |

Everything returns the shared models from [`src/schemas.ts`](../src/schemas.ts). If a platform has no events or branch pages, throw `StacksError("NOT_SUPPORTED", ...)`.

## Steps

1. **Look at the site first.** Find out where the data lives. Try TinyFish Fetch: if the page text has what you need, use `web.fetch`. If the data is rendered by JavaScript, use `web.readPage` and look for embedded JSON or background requests before falling back to reading the DOM.
2. **Create `src/adapters/<platform>/`** with the same three files as BiblioCommons:
   - `contracts.ts`: Zod schemas for only the fields you read.
   - `parse.ts`: pure functions from validated data to the public model.
   - `adapter.ts`: the class implementing `LibraryAdapter`.
3. **Validate everything** with `contract(schema, data, { contract: "search page", url })`. Do not read a field that is not in a contract.
4. **Record fixtures** in `test/fixtures/<platform>/`. Strip them to the contract fields. No personal data.
5. **Write tests**: parsing tests, and break tests that mutate the fixtures and assert `SITE_CHANGED`.
6. **Register the adapter** so `createContext` can pick it by library. Today `src/core/context.ts` constructs the BiblioCommons adapter directly; the first second adapter should introduce a small registry keyed by platform there.
7. **Add a directory** of that platform's libraries, built by a script that verifies each one live.
8. **Run** `npm run e2e` and `npm run health` against at least two libraries on the platform.

## Rules

- All network access goes through the `Web` interface (`src/core/web.ts`), which is TinyFish.
- Prefer the lightest endpoint that works: Fetch, then Browser, then Agent.
- Read-only. No logins or form submissions.
- Cache with the TTLs in `src/core/cache.ts`.
