# Tool reference

Generated from the tool definitions by `npm run docs`. Do not edit by hand.

Every tool returns `structuredContent` matching its output schema, and a `source` object saying which TinyFish endpoints produced the data, from which URL, and when.

## `find_library`

Find the public library system for a city or library name and get its library_id. Call this first: every other tool needs the library_id. Covers library systems whose catalogue runs on BiblioCommons (e.g. Toronto, Vancouver, Chicago, Seattle, San Francisco, Boston, Ottawa, Calgary).

**Input**

| Field | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | A city, region or library name, e.g. "Toronto", "Seattle Public Library", "King County". |

**Output**

| Field | Type | Description |
|---|---|---|
| `matches` | object[] | Best match first. Empty if no supported library was found. |
| `note` | string,null |  |
| `source` | object | Provenance of the data. |

## `search_catalog`

Search a library's catalogue for books, eBooks, audiobooks, DVDs and more. Returns typed titles with live availability counts and hold queues. Use the title_id of a result with check_availability to see which branches have a copy on the shelf.

**Input**

| Field | Type | Required | Description |
|---|---|---|---|
| `library` | string | no | Library system id such as "tpl" (Toronto), "vpl" (Vancouver), "chipublib" (Chicago). Get it from find_library. A city or library name also works. |
| `query` | string | yes | What to search for: a title, author, subject or keywords. At most 200 characters. |
| `search_type` | "keyword" \| "title" \| "author" \| "subject" \| "series" | default `"keyword"` |  |
| `format` | string | no | Only this format: book, ebook, audiobook, eaudiobook, large_print, graphic_novel, picture_book, dvd, bluray, music_cd, magazine (or a platform format code such as BK). |
| `available_at_branch` | string | no | Only titles with a copy available right now at this branch (name or code from list_branches). |
| `page` | integer | default `1` | Results page. A page holds 20 titles at most libraries and 10 at some; `pages` gives the count. |

**Output**

| Field | Type | Description |
|---|---|---|
| `library` | string |  |
| `query` | string |  |
| `total` | integer | Total matching titles across all pages. |
| `page` | integer |  |
| `pages` | integer |  |
| `did_you_mean` | string,null | The site's spelling suggestion, if it had one. |
| `results` | object[] |  |
| `source` | object | Provenance of the data. |

## `get_title`

Full details for one title: description, contributors, publisher, ISBNs, subjects, series, and every other format the library holds it in.

**Input**

| Field | Type | Required | Description |
|---|---|---|---|
| `library` | string | no | Library system id such as "tpl" (Toronto), "vpl" (Vancouver), "chipublib" (Chicago). Get it from find_library. A city or library name also works. |
| `title_id` | string | yes | A title_id from search_catalog, e.g. "S234C3970025". |

**Output**

| Field | Type | Description |
|---|---|---|
| `library` | string |  |
| `title` | object |  |
| `source` | object | Provenance of the data. |

## `check_availability`

Live, copy-level availability for one title: which branches have it on the shelf right now, call numbers, and due dates for checked-out copies. Branches with a copy on the shelf are listed first.

**Input**

| Field | Type | Required | Description |
|---|---|---|---|
| `library` | string | no | Library system id such as "tpl" (Toronto), "vpl" (Vancouver), "chipublib" (Chicago). Get it from find_library. A city or library name also works. |
| `title_id` | string | yes | A title_id from search_catalog, e.g. "S234C3970025". |
| `branch` | string | no | Only this branch (name or code). |
| `on_shelf_only` | boolean | default `false` | Only branches where a copy is on the shelf right now. |
| `limit` | integer | default `15` | Maximum number of branches to return. |

**Output**

| Field | Type | Description |
|---|---|---|
| `library` | string |  |
| `title_id` | string |  |
| `title` | string |  |
| `format` | object |  |
| `summary` | object |  |
| `branches_holding` | integer | Branches that own at least one copy. |
| `branches_on_shelf` | integer | Branches with a copy on the shelf right now. |
| `branches` | object[] |  |
| `truncated` | boolean | True if more branches matched than `limit`. |
| `source` | object | Provenance of the data. |

## `estimate_wait`

Estimate how long you would wait if you placed a hold today, from the live hold queue, copy count and due dates. Also lists other formats of the same work with a shorter queue. This is an estimate computed by Stacks, not a figure published by the library.

**Input**

| Field | Type | Required | Description |
|---|---|---|---|
| `library` | string | no | Library system id such as "tpl" (Toronto), "vpl" (Vancouver), "chipublib" (Chicago). Get it from find_library. A city or library name also works. |
| `title_id` | string | yes | A title_id from search_catalog, e.g. "S234C3970025". |
| `loan_days` | integer | default `21` | The library's loan period in days. 21 is typical for books. |

**Output**

| Field | Type | Description |
|---|---|---|
| `library` | string |  |
| `title_id` | string |  |
| `title` | string |  |
| `format` | object |  |
| `available_now` | boolean | True if a copy is on a shelf somewhere right now. |
| `on_shelf_at` | string[] | Up to 8 branches with a copy on the shelf. |
| `holds` | integer \| null |  |
| `circulating_copies` | integer |  |
| `estimated_wait_days` | object \| null | Null when no estimate is possible (e.g. no circulating copies). |
| `basis` | string | How the estimate was computed. |
| `faster_alternatives` | object[] |  |
| `source` | object | Provenance of the data. |

## `list_branches`

List a library system's branches with address, phone, today's hours and whether each is open right now. Pass coordinates to sort by distance. Use get_branch for a branch's full weekly hours and services.

**Input**

| Field | Type | Required | Description |
|---|---|---|---|
| `library` | string | no | Library system id such as "tpl" (Toronto), "vpl" (Vancouver), "chipublib" (Chicago). Get it from find_library. A city or library name also works. |
| `near_latitude` | number | no | Sort by distance from this point (requires near_longitude). |
| `near_longitude` | number | no |  |
| `open_now` | boolean | no | Only branches that are open right now. |
| `name_contains` | string | no | Only branches whose name contains this text. |
| `limit` | integer | default `20` |  |

**Output**

| Field | Type | Description |
|---|---|---|
| `library` | string |  |
| `total` | integer | Branches in the system matching the filters. |
| `branches` | object[] |  |
| `source` | object | Provenance of the data. |

## `get_branch`

Everything about one branch: weekly hours, whether it is open now, upcoming holiday closures, services and facilities (meeting rooms, printing, makerspaces), accessibility, parking and directions.

**Input**

| Field | Type | Required | Description |
|---|---|---|---|
| `library` | string | no | Library system id such as "tpl" (Toronto), "vpl" (Vancouver), "chipublib" (Chicago). Get it from find_library. A city or library name also works. |
| `branch` | string | yes | Branch name or code, e.g. "Yorkville" or "YO". |

**Output**

| Field | Type | Description |
|---|---|---|
| `library` | string |  |
| `branch` | object |  |
| `source` | object | Provenance of the data. |

## `list_events`

Find events and programs at a library: storytimes, book clubs, classes, author talks. Filter by branch, date range, audience (e.g. kids, teens, adults) and type. Returns typed events with local start and end times and whether registration is required.

**Input**

| Field | Type | Required | Description |
|---|---|---|---|
| `library` | string | no | Library system id such as "tpl" (Toronto), "vpl" (Vancouver), "chipublib" (Chicago). Get it from find_library. A city or library name also works. |
| `branch` | string | no | Only events at this branch (name or code). |
| `start_date` | string | no | First day to include (YYYY-MM-DD). |
| `end_date` | string | no | Last day to include (YYYY-MM-DD). |
| `audience` | string | no | Audience name, matched loosely, e.g. "school age", "teens", "adults". Valid values are returned in available_filters. |
| `event_type` | string | no | Event type, matched loosely, e.g. "book club", "crafts". Valid values are returned in available_filters. |
| `query` | string | no | Keywords to search event titles and descriptions. |
| `page` | integer | default `1` | Results page, up to 20 events per page. |
| `limit` | integer | default `20` | Return at most this many events from the page. Use a small number when you only need the next few. |

**Output**

| Field | Type | Description |
|---|---|---|
| `library` | string |  |
| `total` | integer |  |
| `page` | integer |  |
| `pages` | integer |  |
| `events` | object[] |  |
| `available_filters` | object | Valid values for the audience and event_type inputs at this library. |
| `source` | object | Provenance of the data. |

## `ask_library`

Answer an open-ended question about a library's services, policies or facilities by having a TinyFish Agent browse the library's own website. Use it for things the other tools do not cover, e.g. 'How do I get a card as a non-resident?', 'Can I book a study room at North York Central?', 'What are the overdue fines?'. Much slower than the other tools: a full answer usually takes 1 to 3 minutes. This call waits about 50 seconds; if the Agent is still working it returns status 'running' with a job_id, and you call get_job_result with that id until it is done.

**Input**

| Field | Type | Required | Description |
|---|---|---|---|
| `library` | string | no | Library system id such as "tpl" (Toronto), "vpl" (Vancouver), "chipublib" (Chicago). Get it from find_library. A city or library name also works. |
| `question` | string | yes | The question, in plain language. Name the branch if it is about one branch. |

**Output**

| Field | Type | Description |
|---|---|---|
| `library` | string |  |
| `status` | "completed" \| "running" \| "failed" |  |
| `job_id` | string,null | Set while status is 'running'. Pass it to get_job_result. |
| `answer` | string,null |  |
| `found` | boolean,null | False if the website does not state the answer. |
| `source_urls` | string[] |  |
| `pages_consulted` | object[] | Pages found by search and read before the Agent started. |
| `source` | object | Provenance of the data. |

## `get_job_result`

Fetch the result of a slow TinyFish Agent run that another Stacks tool started (a job_id from ask_library, a fallback_job_id from an error, or a diagnosis_job_id from health_check). If status is still 'running', wait about 15 seconds and call again.

**Input**

| Field | Type | Required | Description |
|---|---|---|---|
| `job_id` | string | yes | The job id exactly as returned by another tool. |

**Output**

| Field | Type | Description |
|---|---|---|
| `job_id` | string |  |
| `kind` | "ask" \| "search" \| "availability" \| "diagnosis" |  |
| `status` | "completed" \| "running" \| "failed" |  |
| `result` | object \| null | The Agent's structured result once completed. For kind 'ask': { answer, found, source_urls }. |
| `error` | string,null |  |
| `agent_steps` | integer \| null |  |
| `source` | object | Provenance of the data. |

## `watch_title`

Create a standing watch on a title using TinyFish Monitor. TinyFish re-reads the title's page on a schedule and detects when its availability changes (for example a copy comes back on the shelf). Notifications go to the webhook you pass, or to the alerts set up in the TinyFish dashboard. Use list_watches to see watches and their current availability.

**Input**

| Field | Type | Required | Description |
|---|---|---|---|
| `library` | string | no | Library system id such as "tpl" (Toronto), "vpl" (Vancouver), "chipublib" (Chicago). Get it from find_library. A city or library name also works. |
| `title_id` | string | yes | A title_id from search_catalog. |
| `check_every` | "hour" \| "6_hours" \| "day" | default `"6_hours"` | How often TinyFish re-checks the page. |
| `webhook_url` | string | no | Optional public HTTPS endpoint TinyFish calls when the page changes. |

**Output**

| Field | Type | Description |
|---|---|---|
| `watch` | object |  |
| `availability_at_creation` | object |  |
| `already_existed` | boolean | True if this title was already being watched; the existing watch is returned and nothing new is created. |
| `source` | object | Provenance of the data. |

## `list_watches`

List the title watches created with watch_title. Set check_now to also read each title's live availability, so you can tell the user whether a copy is available yet.

**Input**

| Field | Type | Required | Description |
|---|---|---|---|
| `check_now` | boolean | default `false` | Also fetch live availability for each watched title (up to 5). |

**Output**

| Field | Type | Description |
|---|---|---|
| `watches` | object[] |  |
| `source` | object | Provenance of the data. |

## `cancel_watch`

Stop and permanently delete a watch created with watch_title. TinyFish stops re-checking the title and sends no more notifications. Only watches made by Stacks can be cancelled; get the watch_id from list_watches. Set dry_run to see which watch would be cancelled without cancelling it, for example to confirm with the user first.

**Input**

| Field | Type | Required | Description |
|---|---|---|---|
| `watch_id` | string | yes | The watch_id from watch_title or list_watches. |
| `dry_run` | boolean | default `false` | If true, only report which watch would be cancelled. Nothing is deleted. |

**Output**

| Field | Type | Description |
|---|---|---|
| `cancelled` | boolean | True if the watch was deleted. Always false on a dry run. |
| `dry_run` | boolean |  |
| `watch_id` | string |  |
| `library` | string |  |
| `title_id` | string |  |
| `title` | string,null |  |
| `source` | object | Provenance of the data. |

## `health_check`

Run live checks against a library's website to confirm every Stacks tool still works, and report exactly what broke if the site changed. Checks page landmarks (TinyFish Fetch) and the data contract of each tool using known-good queries (TinyFish Browser). Set deep to also start a TinyFish Agent that inspects a failing page and explains what changed. Takes about 20 to 40 seconds. Run this when a tool returns SITE_CHANGED.

**Input**

| Field | Type | Required | Description |
|---|---|---|---|
| `library` | string | no | Library system id such as "tpl" (Toronto), "vpl" (Vancouver), "chipublib" (Chicago). Get it from find_library. A city or library name also works. |
| `deep` | boolean | default `false` | If a check fails, start an Agent run to diagnose the failing page (result via get_job_result). |

**Output**

| Field | Type | Description |
|---|---|---|
| `healthy` | boolean | False if any check failed. |
| `library` | string |  |
| `summary` | string |  |
| `platform_version` | string,null | Version of the library platform seen on the site now. |
| `verified_platform_version` | string | Platform version these tools were last verified against. |
| `checks` | object[] |  |
| `diagnosis_job_id` | string,null | Pass to get_job_result for the Agent's diagnosis of the failing page. |
| `diagnosis_error` | string,null | Why the Agent diagnosis could not be started, if it could not. |
| `tinyfish_calls` | object | TinyFish calls this check made, by endpoint. |
| `checked_at` | string |  |
