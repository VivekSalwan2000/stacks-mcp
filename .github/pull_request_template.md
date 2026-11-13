## What this changes

## How I tested it

- [ ] `npm run lint` and `npm test` pass (offline, uses recorded fixtures)
- [ ] `npm run e2e` passes against live sites (needs `TINYFISH_API_KEY`)
- [ ] If I changed a contract or parser, I added or updated a fixture and a test in `test/breaks-loudly.test.ts`
- [ ] If I added a tool, it has typed input and output schemas and a row in the README
- [ ] If a tool's inputs or outputs changed, I ran `npm run test:update` and `npm run docs` and committed the results
