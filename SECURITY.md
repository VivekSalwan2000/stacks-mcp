# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/VivekSalwan2000/stacks-mcp/security/advisories/new)). You will get a reply within 7 days. If the report is confirmed, a fix is released as a new npm version and you are credited in the changelog unless you ask not to be.

Never include a real API key, token or anyone's personal data in a report.

## Supported versions

Only the latest version published on npm receives fixes.

## What counts

Stacks is read-only towards library websites: it does not log in, and it handles no library cards, passwords or personal data. The things worth reporting are:

- **The TinyFish API key leaking**, through tool output, error messages, logs or the HTTP server.
- **Getting past the HTTP server's access checks**: using the server's key without `STACKS_HTTP_TOKEN`, or driving a local server from another website.
- **Making Stacks load pages it should not**, such as addresses that are not a library catalogue, or internal network addresses through `webhook_url`.
- **Staff-only data from a library page appearing in tool output** (internal notes, staff contact details).
- **Text from a library page changing what a tool does**, beyond being returned as data.
- **Touching TinyFish resources Stacks did not create**, such as cancelling a monitor that is not a Stacks watch.

## What does not

- A library website changing and a tool reporting `SITE_CHANGED`. That is the tool working as intended: use the "A tool broke" issue form.
- A library blocking automated access (`SITE_BLOCKED`).
- Problems in a library's own website or in TinyFish. Report those to their owners.

## How the key is handled

- The key is read from the `TINYFISH_API_KEY` environment variable, or per request from the `x-tinyfish-api-key` header in HTTP mode. It is never written to disk, logged or returned by a tool.
- `.env` is git-ignored and `.env.example` is kept blank.
- In HTTP mode without `STACKS_HTTP_TOKEN`, the server listens on `127.0.0.1` only and refuses requests from other websites. Tokens are compared in constant time.
