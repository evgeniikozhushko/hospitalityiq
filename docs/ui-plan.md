# Plan (revision 5): Chat UI with shadcn/ui over /api/ask

## Context
The answer pipeline (`lib/answer.ts`) and eval harness are done. `POST /api/ask` streams NDJSON, but `app/page.tsx` is still create-next-app boilerplate, so nobody except the CLI can use the product. The docs' "Next" list is data-layer work, so this stays a small single-turn UI over the existing pipeline. It adds nothing the backend lacks (no history, no upload, no auth).

Hard rules:
- Off limits: anything under `scripts/` or `evals/`, and `lib/answer.ts`, `app/api/ask/route.ts`, `lib/plan.ts`, `lib/filters.ts`, `lib/retrieve.ts`, `lib/schema.ts` (read and import only, never edit).
- Allowed hand-written files: new files in `lib/` (new names, with their `*.test.ts`), `components/`, `hooks/`, and edits to `app/page.tsx` and `app/layout.tsx`.
- Allowed generated changes, made only by the shadcn CLI and only after the second approval gate in section 1: `components.json`, `lib/utils.ts`, `hooks/use-mobile.ts`, `components/ui/**`, the block's component files in `components/`, a temporary `app/dashboard/page.tsx` (deleted afterwards), `app/globals.css`, `package.json`, `package-lock.json`, and `node_modules/`. If the CLI changes or creates any file outside this list (for example `tsconfig.json`), I stop and report it before continuing.
- Two separate approval gates before anything is downloaded or installed (section 1). Approval of one is never approval of the other.
- Generated UI files may be edited by hand after installation (for example the minimal `components/ui/alert.tsx` change in section 7, and rewriting the block's `app-sidebar.tsx` and `site-header.tsx`). The "made only by the CLI" limit applies to creating them; after that they are ordinary project files, and every manual edit to one is listed in the final report.

## Revision 5 amendments (after review)
- Removed the stale "overwrite docs/ui-plan.md" instruction; this document is the plan of record.
- Generated UI files may be hand-edited after installation (hard rules).
- File inventory handles directories that do not exist yet and uses expanded `git status` and `git diff --stat` for root-level files and modifications (section 1).
- Parser cleanup never masks the original error when `reader.cancel()` rejects, with a focused test (sections 3 and 4).
- Announcement checks are made per transition on roles and status text, including an error after an informational note, and do not claim to prove what a screen reader announced (sections 7 and 9).
- Missing browser capability is reported as a verification limitation (section 9).

## What changed from revision 4
- File restrictions now explicitly allow the generated files, the temporary `app/dashboard/page.tsx`, and the package and lockfile changes (above).
- Two explicit approval gates: gate A downloads the CLI and runs read-only inspection; gate B, after you review that output, runs init, add and the dependency install (section 1).
- Source validation is concrete: `lib/schema.ts` has no Zod schema for `Source`, so the client defines one, with a two-way equality check and a coverage test (section 2). `QueryPlanSchema` is reused.
- Transport: a missing response body is an error, malformed JSON is distinguished from a reader failure, and the abort test asserts nothing is yielded after the abort (sections 3 and 4).
- Browser verification fails closed: the override is installed before submitting, unmatched `/api/ask` requests are rejected, and a counter is checked. It is required only after the browser tool is confirmed able to do this (section 9).
- Alert semantics are checked in the generated component and verified in the rendered DOM (section 7).
- Cleanup uses an expanded file inventory before and after the CLI runs, not a bare `git status --porcelain` (section 1).

## 1. shadcn setup (two approval gates)
Current state: no `components.json`, `components/`, `hooks/`, `lib/utils.ts` or `postcss.config`. Tailwind v4 runs through `@tailwindcss/turbopack`. The `@/*` alias maps to the repo root. The working tree was clean at session start.

Approval gates, in order:
- **Gate A, inspect:** you approve downloading and running the shadcn CLI for read-only inspection only. That means `npx shadcn@latest` fetches the package (into the npm cache) and I run `view` and `--dry-run` / `--diff` commands. No `init`, no `add`, no `npm install`, and no project files written. If a read-only command turns out to need a `components.json` first, I stop and tell you instead of creating one; the registry JSON already read stands in.
- **Gate B, install:** after you have read the Gate A output (file list, dependency list, differences from the registry read), you separately approve `shadcn init` and `shadcn add`, which write files and install dependencies. Approval of Gate A does not cover this.
- Any extra install or download needed to work around a failure (for example adding `postcss.config` and `@tailwindcss/postcss`) is a new approval, not covered by A or B.

Registry inspection already done (public registry JSON, read without downloading anything, so nothing is generated locally):
- `sidebar-16` registry dependencies: `sidebar`, `breadcrumb`, `separator`, `collapsible`, `dropdown-menu`, `avatar`, `button`, `label`. Its files: a demo `app/dashboard/page.tsx`, `app-sidebar`, `nav-main`, `nav-projects`, `nav-secondary`, `nav-user`, `search-form`, `site-header`.
- `sidebar` primitive: a client component. It writes a `sidebar_state` cookie via `document.cookie` only inside `setOpen` (a toggle, or the Ctrl/Cmd+B shortcut). It never reads the cookie, does not import `next/headers`, and `defaultOpen` defaults to `true`. Its dependencies are `radix-ui`, `class-variance-authority`, `lucide-react` and `cn`; its registry dependencies are `button`, `separator`, `sheet`, `tooltip`, `input`, `use-mobile` and `skeleton`. `SidebarMenuButton` styles `aria-disabled` with `pointer-events-none`.
- Caveat: this is the registry's copy. The installed copy is generated by the CLI (import paths are rewritten) and could differ by CLI version, so I verify it after install (below). I won't treat the registry read as proof about the installed code.

Steps:
1. (Gate A) `shadcn view sidebar-16` and `view sidebar`, plus `add ... --dry-run` / `--diff` if this CLI version has them, compared against the registry read above. I report every difference and stop for Gate B.
2. (Gate B) Capture the file inventory (below), then `shadcn init` (style new-york-v4, neutral, CSS variables), then `shadcn add sidebar-16 textarea button card badge alert skeleton`.
3. If init or add fails on Tailwind detection, I do not guess a fix. I capture the exact error, identify which check failed (CSS file detection, package detection, config shape), and report it with the options (for example a manual `components.json` per the shadcn manual-install docs, or adding `postcss.config` and `@tailwindcss/postcss`). Any option that installs or downloads more waits for a new approval.

Expanded file inventory, because `git status --porcelain` can collapse a new directory into one entry:
- Immediately before Gate B commands and again after them, record, saved in the scratchpad directory (not the repo): `git status --porcelain --untracked-files=all`, `git diff --stat`, and a sorted file listing of the directories that exist at that moment. `components/` and `hooks/` do not exist before the CLI runs, so the listing is built per directory (`for d in app components hooks lib; do [ -d "$d" ] && find "$d" -type f; done | sort`) and a missing directory is recorded as absent, not as an error.
- The `find` listing covers only those four directories. Root-level files (`components.json`, `package.json`, `package-lock.json`, `tsconfig.json`, config files) and modifications to existing files are checked through the expanded `git status` and `git diff --stat` output, which cover the whole repo.
- The generated set is the difference between the two inventories. It must match the allowed list in the hard rules. Anything else is reported before I continue.

After install, verify the installed source before relying on it: grep the installed `components/ui/sidebar.tsx` for `document.cookie`, `next/headers` and `cookies(`; confirm `defaultOpen` handling; confirm `aria-disabled` styling; read the actual dependency changes with `git diff package.json`.

Expected changes (replaced by the real list after install):
- New: `components.json`, `lib/utils.ts` (`cn()`), `hooks/use-mobile.ts`, and `components/ui/` files for textarea, button, card, badge, alert, skeleton, sidebar, separator, breadcrumb, sheet, tooltip, input, collapsible, dropdown-menu, avatar, label, plus the block's component files and `app/dashboard/page.tsx`.
- Changed: `app/globals.css` (shadcn tokens, `tw-animate-css` import replacing the current `--background`/`--foreground` block and the OS dark-mode media query; light theme only, no toggle; the Arial `body` override goes), `package.json` and `package-lock.json` (new dependencies).

Cleanup, limited to generated files so existing work is protected:
- The "generated set" is the file-by-file difference between the before and after inventories above. I delete only demo files from that set: `app/dashboard/`, `nav-main`, `nav-projects`, `nav-secondary`, `nav-user`, `search-form`, and any `components/ui/*` or `hooks/*` file that nothing imports afterwards (checked by grep for imports).
- Pre-existing files the CLI modified (`app/globals.css`, `package.json`, `package-lock.json`) are reviewed with `git diff` and kept, never deleted or reverted wholesale.
- Sample-content grep covers only generated or rewritten UI files (`components/`, `hooks/`, `app/page.tsx`, `app/layout.tsx`), for: "Acme", "Playground", "Enterprise", "m@example.com", "/avatars", "Build Your Application", "Design Engineering". The word "shadcn" legitimately appears in config and dependencies and is not searched for.

## 2. Wire protocol and validation
- `AnswerEvent` in `lib/answer.ts` covers plan, declined, no_data, sources, delta and done. The route also emits `{ type: "error", message }` from its `catch`, with no `done` after it. Non-200 responses are JSON, not NDJSON (`{ error }`, status 400).
- New `lib/askWire.ts`: `AskEvent = AnswerEvent | { type: "error"; message: string }` (types only imported from the pipeline) and `parseWireEvent(raw: unknown)`, returning one of: a valid known event; `unknown` (a well-formed object with an unrecognised `type`, ignored for forward compatibility); or `invalid` (not an object, no string `type`, or a known `type` whose payload fails its schema).
- Known events are validated structurally with zod, which is already a dependency: `plan` (intent, mode, filter fields, `droppedPropertyNames: string[]`), `sources` (array of source objects with numeric `n`, string `propertyName`, numeric `rating`, string `createdAt`, string `text`, and so on, plus boolean `relaxed`), `delta` (string `text`), `declined` (intent, string `message`), `no_data` (string `message`), `done`, `error` (string `message`).
- What `lib/schema.ts` actually offers (checked): it imports only `zod`, so it is safe to bundle for the client. It exports Zod schemas `QueryPlanSchema`, `QueryFiltersSchema`, `QueryIntent` and `PropertyType`, but `Source` is a plain TypeScript type with no schema. So:
  - `plan` events reuse `QueryPlanSchema` and `QueryIntent` directly, and `sources` reuse `PropertyType`.
  - `lib/askWire.ts` defines a new `SourceWireSchema` with exactly the fields of `Source`: `n` (positive integer), `reviewId`, `propertyName`, `propertyType` (`PropertyType`), `rating` (number), `createdAt`, `text`, `score` (number).
  - Drift check in both directions: a type-level strict-equality assertion that `z.infer<typeof SourceWireSchema>` and `Source` are mutually identical (it fails `tsc` on a missing field, an extra field or a changed type, which a one-way assignability check can miss). Because `PropertyType` is reused, the enum is identical too.
  - Runtime coverage test: a fixture typed as `Source` parses successfully; each required field removed in turn fails; and the schema's key set equals the expected key list, so a field added to the wire shape without updating the schema is caught by the test as well as by `tsc`.
  - `AskEvent` gets the same treatment: the inferred type of the full wire union is asserted equal to `AskEvent`.
- An `invalid` known event is a protocol error: terminal, "unexpected response from the server", partial answer and sources preserved, and the malformed payload is never passed to the reducer or merged into state.

## 3. Modules and state machine
All pure or injectable, so everything is testable in Vitest's node environment with no DOM and no new dependencies.

- `lib/ndjson.ts`: `parseNdjson(body: ReadableStream<Uint8Array>)` async generator. One `TextDecoder` with `{ stream: true }`, flushed at the end. It buffers partial lines, skips blank lines, tolerates `\r\n`, and parses a final line with no newline. In `finally`: if the consumer stopped early or an error occurred, cancel the reader; always release the lock. A stream that reached normal EOF is already closed and is not cancelled. Cleanup never masks the original error: `reader.cancel()` is awaited inside its own try/catch and its rejection is swallowed, and `releaseLock()` runs afterwards regardless (also in its own guard), so an `NdjsonSyntaxError` or a reader failure is what the caller sees, even when `cancel()` itself rejects. It distinguishes two failure kinds with typed errors: `NdjsonSyntaxError` (a complete line that is not valid JSON) and whatever the reader itself throws (passed through untouched, as a reader failure). Callers never have to guess from the message.
- `lib/askClient.ts`: `askStream(question, { signal, fetchImpl })` async generator that yields transport signals without request ids:
  - `event` (a validated `AskEvent`), `http_error`, `network_error`, `protocol_error` (malformed JSON line or invalid known event), and `stream_end`.
  - Unknown wire events are skipped. After a terminal event (`done` or `error`) it stops reading, and the parser's `finally` cancels the reader.
  - Intentional abort versus incomplete: if `signal.aborted` is true when the fetch rejects, the reader throws, or the stream ends, the generator returns silently and yields nothing. `stream_end` is yielded only when the body reaches EOF with no terminal event and no abort. A read failure while not aborted is `network_error`.
  - Non-200: parse `{ error }` from a JSON body, else a generic message that includes the status.
  - A 200 response with `body === null` is an error, not an empty stream: yield `protocol_error` ("response had no body"), never `stream_end`.
  - Error mapping is by kind, not by message: `NdjsonSyntaxError` and invalid known events give `protocol_error`; a reader or fetch failure while not aborted gives `network_error`; a failure while aborted gives nothing.
  - After `signal.aborted` becomes true, nothing further is yielded, even if chunks were already buffered or the reader resolves late. Signals yielded before the abort may already have been dispatched, and that is fine.
- `lib/askState.ts`: `askReducer(state, action)`.
  - Rule order: `submit` is handled first, unconditionally, before the id and terminal guards. It sets `activeId` to the new id and `lastQuestion`, and resets plan, dropped names, sources, relaxed, answer, message, error and flags in one step. It works after complete, error, incomplete, declined, no_data, and mid-stream.
  - Every other action (`event`, `http_error`, `network_error`, `protocol_error`, `stream_end`) carries a request id and is ignored unless `id === activeId` and the status is not terminal.
  - Terminal statuses: complete, declined, no_data, error, incomplete. `declined` and `no_data` are terminal on arrival, so the `done` or `stream_end` that follows is ignored and never flips them to incomplete.
  - `stream_end` on a non-terminal status gives incomplete, keeping the partial answer. `error`, `http_error`, `network_error` and `protocol_error` give error and keep any partial answer and sources.
- `lib/askController.ts`: `createAskController({ dispatch, fetchImpl })` with `submit(question)`, `retry()` and `dispose()`.
  - `fetchImpl` defaults to `(input, init) => globalThis.fetch(input, init)`, resolved at call time. That keeps the controller testable with a mock and lets a page-level fetch override work.
  - `submit` takes the next monotonic id, aborts the previous request's `AbortController`, creates a new one, stores `lastQuestion`, dispatches `submit(id, question)`, and consumes `askStream`. It dispatches each signal tagged with its id only if `id` is still current and the signal is not aborted. Its `finally` acts only if the id is still current.
  - `retry()` resubmits the last submitted question, never the current textarea text. Editing the box does not change what Retry does, and the edited text stays in the textarea. With no last question it does nothing.
  - `dispose()` aborts the active request, invalidates the current id, and is idempotent.
- `components/chat.tsx` (`"use client"`) stays thin. It creates the controller in an effect and disposes it in that effect's cleanup, so unmount aborts the request and Strict Mode's mount, unmount, mount does not leave a live request or update state after unmount. It holds `useReducer(askReducer)`, the textarea text, and nothing else.

Honest limit on upstream work: aborting the fetch makes the route's `cancel()` call `events.return()`. `answerQuestion` takes no `AbortSignal`, and `return()` on an async generator cannot interrupt an `await` already in flight, so the planner call, Qdrant search or OpenAI stream can continue until its current step settles. The plan promises only that the client stops reading at once and never shows superseded output. Threading `request.signal` through `answerQuestion` touches the route and pipeline, so it is out of scope and noted as a follow-up.

## 4. Tests (Vitest, node environment, no new dependencies)
Parser (`lib/ndjson.test.ts`), with mocked `ReadableStream`s:
- Chunk boundary mid-line, several events in one chunk, final line with no newline, blank lines, `\r\n`.
- Multi-byte UTF-8 (accented letters, emoji) split at every byte boundary decodes identically.
- Decoder flush at end of stream.
- A malformed JSON line throws `NdjsonSyntaxError`; a reader that rejects mid-stream throws its own error, which is not an `NdjsonSyntaxError`.
- Cleanup: early exit by the consumer, a thrown error, and an abort mid-stream each cancel the source (spy on `cancel`) and release the lock. Normal EOF does not call `cancel`.
- Cleanup does not mask errors: with a source whose `cancel()` rejects, (a) a malformed line still surfaces as `NdjsonSyntaxError`, (b) a reader failure still surfaces as that original error, (c) an early consumer exit completes without throwing, and in all three the lock is released. Through `askClient`, (a) and (b) still classify as `protocol_error` and `network_error` respectively.

Wire validation (`lib/askWire.test.ts`):
- Each known event type valid; unknown `type` returns unknown; non-object, missing `type`, and each known type with a bad payload (for example `delta` with numeric `text`, `sources` not an array, `plan` missing intent) return invalid.

Transport (`lib/askClient.test.ts`), with mocked `fetch` and streams:
- Normal 200 stream through to `done`; `error` event ends the stream; events after a terminal one are not yielded and the reader is cancelled.
- HTTP 400 with `{ error }`; 500 with an HTML or empty body; fetch rejecting; 200 with a null body (`protocol_error`, not `stream_end`); reader rejecting mid-stream while not aborted (`network_error`); malformed JSON line (`protocol_error`, distinct from the reader failure case).
- Abort before the response: nothing is yielded. Abort mid-stream: events yielded before the abort are recorded, then the test aborts, feeds more chunks and an EOF, and asserts the collected signals are exactly the pre-abort ones, with no error, no incomplete and no `stream_end` afterwards.
- EOF with no terminal event yields `stream_end`.
- Malformed JSON line and invalid known event yield `protocol_error` and no `event`; an unknown event is skipped and later events still arrive.

Reducer (`lib/askState.test.ts`):
- Full paths for answer, declined, no_data, relaxed.
- Second `submit` after complete, after error, after incomplete, after declined, after no_data, and during streaming, each resetting plan, sources, answer, error and flags and setting the new `activeId`.
- Stale id ignored; actions after a terminal status ignored; `done` or `stream_end` after declined or no_data leaves the status unchanged.
- `stream_end` gives incomplete and keeps the partial answer; `error`, `http_error`, `network_error` and `protocol_error` keep partial answer and sources.

Controller (`lib/askController.test.ts`), wired to the real reducer with mocked fetch:
- Submit while a slow stream is running: the first request's signal is aborted and its late chunks and `stream_end` change nothing.
- Submit after completion and after error works. `retry()` resubmits the last submitted question; after `submit("B")`, `retry()` sends "B".
- `dispose()` aborts, is idempotent, and afterwards no dispatch occurs. An abort never produces an error or incomplete state.

## 5. Answer rendering and citations
- No `dangerouslySetInnerHTML` anywhere and no markdown library. Model output and review text are only ever React text nodes, so `<script>` or `<img onerror=...>` appears as literal text.
- `lib/answerText.ts`: `tokenizeAnswer(text, validNumbers, { streaming })` returns plain data, and `components/answer.tsx` maps it to elements. Supported syntax: paragraphs split on blank lines, bullets (`-`, `*`, `•`), numbered lists, `**bold**`, and citations. Anything else renders literally.
- Parsing always runs over the whole accumulated answer, never per chunk, so citations split across `delta` events resolve correctly.
- `[n]` becomes a link only if `n` is in the `sources` of the current submission. Adjacent `[1][4]` works. `[9]`, `[0]`, `[1, 2]` stay plain text.
- While streaming, a trailing partial citation (`[`, `[1`) is held back instead of flashing as text. It renders literally once the stream has ended.
- Tests (`lib/answerText.test.ts`): split citation across chunks, adjacent, unknown numbers, `[1, 2]`, held-back trailing `[` while streaming versus literal after, bullets, numbered lists, bold, HTML-looking text staying literal.

## 6. UX states and shell
Loading, by path, decided from the `plan` event's `intent`:
- Submit to first event: skeleton for chips and results.
- `review_insight` plan: chips, then a skeleton for sources and answer.
- Non-answerable plan (campaign, financial, off_topic): no chips and no sources skeleton, only a skeleton that the `declined` alert replaces.
- `no_data`: skeleton removed, alert, no sources region.
- `sources`: cards replace the skeleton; an answer skeleton shows until the first `delta`.

Other UX rules: validation matches the server (trimmed, 3 to 500 characters, counter, submit disabled outside the range). Submit stays enabled while streaming, and a new question supersedes the old one. Helper text says each question is answered on its own, since the backend keeps no history. Chips use `Badge`; `Alert` covers the relaxed-filter banner, dropped property names, declined and no_data messages, errors and the incomplete warning; `Card` is the source card; `Skeleton` is loading.

Shell, sidebar-16 as app shell only:
- `components/app-sidebar.tsx` (rewritten): header "HospitalityIQ"; one group with "Ask" (active, links to `/`) and "Trends", "Campaigns", "Admin upload" as disabled items (section 7). No user menu, projects, secondary links, footer sample content or search form.
- `components/site-header.tsx` (rewritten): sticky header with the sidebar toggle, a separator and a breadcrumb "Ask".
- `app/page.tsx` (changed): a server component composing `SidebarProvider`, `AppSidebar`, `SidebarInset`, `SiteHeader` and `<Chat />`. It makes no request-time reads and passes no cookie-derived `defaultOpen`.
- `Chat` is not the only client state: the sidebar primitive is a client component with its own state. Whether it makes the page non-static is decided by the build output (section 9), not assumed.
- `app/layout.tsx` (changed): real title and description.
- Before writing client components, read `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`, `02-guides/keeping-pages-static.md` and `02-guides/optimizing-the-static-shell.md`.

## 7. Focus and accessibility
- Citation links: `<a href="#source-n">` with a click handler that calls `preventDefault` and then `activateCitation(n)`. Source cards are programmatically focusable targets: `id="source-n"`, `tabIndex={-1}` (focusable but not in the tab order), with an accessible name (`role="article"` labelled by the property and date) and a focus style on `:focus`, not only `:focus-visible`, so the target is visibly marked after a mouse click.
- `lib/focusSource.ts`: `activateCitation(n, { getElementById, prefersReducedMotion })` calls `scrollIntoView` (smooth, or instant under reduced motion, `block: "nearest"`) and then `focus({ preventScroll: true })`, returning false without throwing if the card is missing. Tested with fake elements and spies: both are called, in that order, with the right arguments; reduced motion switches the behaviour; a missing card is safe. There is no jsdom or testing-library, and adding one needs a new dependency, so I won't. The real DOM focus and scroll are checked in the browser (section 9).
- Disabled sidebar items ("Trends", "Campaigns", "Admin upload"): focusable buttons with `aria-disabled="true"`, no navigation, `preventDefault` on click, visually hidden text so the accessible name reads "Trends, coming soon", and a visible "Soon" `SidebarMenuBadge`. The explanation is not hover-only. No tooltip is relied on, because the primitive's `aria-disabled:pointer-events-none` would stop hover tooltips on these items anyway.
- Live regions: one visually hidden `role="status"` region (polite, atomic) whose text comes from `statusMessage(state)` in `lib/askStatus.ts`. It is derived from phase only (searching, writing the answer, complete, no matching reviews, can't answer that), never from the answer text, so deltas do not change it and the answer is never re-announced. It returns an empty string for error and incomplete.
- Error and incomplete alerts use `role="alert"` and are announced once when they appear. Informational alerts (relaxed banner, dropped names, declined, no_data) use `role="note"`, a non-live role, because the status region announces their phase. The answer container is not a live region; it gets `aria-busy` while streaming. Skeletons are `aria-hidden`.
- The generated shadcn `Alert` probably sets `role="alert"` by default, so I do not assume an override works. After install I read the generated `components/ui/alert.tsx` to see whether a `role` prop passed by the caller wins or is overwritten. If the caller's prop is overwritten, I make the smallest edit to that generated file so the caller's `role` takes precedence (this is a generated file I own, allowed by the hard rules).
- `lib/alertRole.ts`: `alertRole(kind)` maps `error` and `incomplete` to `"alert"` and every informational kind to `"note"`, unit-tested for every kind, and used by every alert in the UI so no call site chooses a role by hand.
- Rendered DOM check (section 9): at each state transition in a scenario I record every `[data-slot="alert"]` with its `role` and text, plus the status region's text. The assertions are on what is newly added or changed at that transition, not on a count for the whole page: a `role="note"` banner (relaxed, dropped property) may stay visible when a later error appears, and that is fine because notes are not live. The checks are: an informational alert always has `role="note"`; the only `role="alert"` nodes that appear are error and incomplete; the status text changes only at phase boundaries and is empty when an error or incomplete alert appears; and in the error-after-note case, the transition adds exactly one `role="alert"` node, leaves the status text empty, and leaves the existing note unchanged (not re-added). This establishes the roles and text a screen reader would be given at each step. It does not prove what a specific screen reader announced, and the report says so.
- Form: a real `<label>` on the textarea, the counter tied by `aria-describedby`, Enter submits and Shift+Enter inserts a newline, and no submit while an IME composition is in progress. Focus is not moved automatically when an answer arrives.
- Tests: `statusMessage` returns the identical string for states that differ only in answer text, and an empty string for error and incomplete.

## 8. Out of scope
Conversation history, CSV upload, auth, themes and charts, the dashboard block, tables and sample data, theme toggle and dark mode, a Stop button, jsdom or testing-library, and threading an abort signal through the pipeline (follow-up).

## 9. Verification (mock-first, deterministic, nothing added to the repo for testing)
1. `npm test`, `npx tsc --noEmit` and `npm run lint` are clean.
2. `npm run build` passes, and I quote the route table lines for `/` and `/api/ask` and say whether `/` is prerendered or dynamic. I claim it is static only if the output shows it.
3. UI scenarios use in-browser fetch interception, with no mock server, no env switch in `chat.tsx` and no CORS setup. It must fail closed:
   - Capability check first: I read the matching browser skill (built-in browser or Chrome) and confirm the tool can (a) run a script in the page, (b) do so before I submit anything, and (c) read values back from the page. Only then is this step required. If the tool cannot, I stop and ask you instead of adding files to the repo, and I report the browser scenarios as not verified; the Vitest suite still covers the logic.
   - After `npm run dev` loads the page and before any question is submitted, I inject a `window.fetch` override that records every call. A request to `/api/ask` is answered from the scripted scenario if one is armed, and otherwise rejected with a `TypeError`, never passed through. Requests to anything else pass through unchanged. The override keeps counters: `served`, `rejected` and `passedThrough` (the last only for non-`/api/ask` URLs). Before each scenario I assert the override is still installed (a marker on `window.fetch`) and the counters are zero; after it I assert `served` equals the expected number, `rejected` is 0 unless the scenario expects a rejection, and no `/api/ask` URL ever appears under `passedThrough`.
   - The page makes no `/api/ask` request on load, because `Chat` does nothing on mount. A reload drops the override, so I re-inject it after each load and do not submit until the marker check passes.
   - The dev server log (no `POST /api/ask` lines) is a secondary cross-check only, not the proof.
   - Scenarios: normal answer with citations, relaxed, declined, no_data, mid-stream `error`, relaxed followed by a mid-stream `error` (error after an informational note), stream cut with no terminal event, HTTP 400, slow chunks superseded by a second question, and a cancellation mid-stream.
   - If the browser tool cannot do this, the final report lists the browser scenarios, accessibility checks and responsive checks as a verification limitation (not run), rather than treating the Vitest suite as a substitute for them.
4. In the browser, using the scenarios above:
   - Clicking a citation scrolls to the card and `document.activeElement.id` becomes `source-n`.
   - A MutationObserver on the status region shows it changes only at phase boundaries while the answer streams.
   - Keyboard-only: Tab reaches the disabled items and their accessible names include "coming soon".
   - Narrow viewport: the sidebar becomes a sheet. I also look for a first-paint flash, since the primitive's mobile detection starts as `false`.
5. Live Qdrant and OpenAI checks are not part of the default run. A real end-to-end question costs money and needs the shared services, so I ask first. I never stop or alter Qdrant to simulate failure.
6. Eval results: I do not re-run `npm run eval` (paid calls). The claim is limited to what is checkable: `git status` shows nothing modified or regenerated under `evals/` and `scripts/`, none of the pipeline files above changed, and a grep shows nothing in `lib/`, `scripts/` or `evals/` imports from `components/` or `app/`. I will say plainly that the eval was not re-run, so "unaffected" means "untouched", not "re-measured".
7. Sample-content greps from section 1 pass on generated files, and `/dashboard` does not exist.

## Gate A findings (shadcn CLI 4.23.0, read-only)
Status: Gate A done. Only the CLI package was downloaded (npm cache via `npx`). No `init`, no `add`, no `npm install`, no project files written. `git status --porcelain --untracked-files=all` was identical before and after (baseline saved in the session scratchpad).

What matched the earlier registry read:
- `view sidebar-16` returned the same eight registry dependencies and the same files: demo `app/dashboard/page.tsx`, `app-sidebar`, `nav-main`, `nav-projects`, `nav-secondary`, `nav-user`, `search-form`, `site-header`. No cookie, `defaultOpen` or `aria-disabled` code in the block's own files.
- `view sidebar` returned the same dependencies (`cn`, `radix-ui`, `class-variance-authority`, `lucide-react`) and registry dependencies (`button`, `separator`, `sheet`, `tooltip`, `input`, `use-mobile`, `skeleton`). The primitive contains `document.cookie`, `defaultOpen`, `aria-disabled` and `"use client"`, and does not contain `next/headers` or `cookies(`.
- `shadcn info` detects Next.js 16.4.3, App Router, Tailwind v4 and `app/globals.css`, with no components.json. Tailwind detection works without a `postcss.config`, so that earlier risk did not appear.

What differs from the plan, and needs a decision before Gate B:
1. **No `new-york-v4` style option.** In CLI 4.23.0, `init` chooses a component base (`--base base|radix|aria`) and a preset (`--preset`; `--defaults` means `--template=next --preset=base-nova`). The plan's "style new-york-v4, neutral" no longer maps to a flag. The `view` results above came from the legacy registry and use `radix-ui`. Initialising with the default preset would use the `base` (Base UI) library, whose components can differ from what I inspected (for example `asChild` versus `render` props), so I should not assume the inspected sidebar source is what gets installed.
   - Proposed Gate B command: `npx shadcn@latest init --base radix --css-variables` (interactive for anything it still asks, such as the preset), so the installed components match the Radix-based source reviewed here.
2. **Dry-run is not possible before init.** `add --dry-run` stops at "You need to create a components.json file" and I did not create one. So the exact generated file list cannot be previewed beforehand. Proposed change to Gate B: run `init` first, then `add sidebar-16 textarea button card badge alert skeleton --dry-run` (read-only once `components.json` exists) and list the files it would write, then run the real `add` only if that list matches the allowed list in the hard rules.
3. **`globals.css` and dependencies may differ from the expected list.** The CLI's `eject` command ("inline shadcn/tailwind.css and remove the shadcn dependency") indicates that `init` can add a `shadcn` package dependency and an `@import "shadcn/tailwind.css"` line. Expected dependency changes are therefore: `shadcn`, `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, and possibly `tw-animate-css`. The real list is read from `git diff package.json` after init and reported before `add`.
4. **Components to be added are unchanged:** `sidebar-16 textarea button card badge alert skeleton`.

Gate B (not yet approved) would cover: `init --base radix --css-variables`, the read-only `add --dry-run` check, then the real `add`, with the file inventory before and after as described in section 1.

## Implementation status
Gate B was approved with the Radix base. Installed: `init --base radix --preset nova --css-variables` (the CLI asks for a preset when none is given; Nova uses Lucide icons and Geist, which the app already uses), then `add sidebar-16 textarea button card badge alert skeleton`. The `add --dry-run` run before the real add listed 25 files, all inside the allowed list; nothing outside it was created or changed (`app/layout.tsx` was not touched by the CLI).

Built:
- `lib/`: `ndjson`, `askWire`, `askClient`, `askState`, `askController`, `answerText`, `askStatus`, `alertRole`, `focusSource`, `planChips`, with tests, plus test-only helpers `testStreams.ts` and `testFixtures.ts`.
- `components/`: `chat`, `answer`, `source-card`, `app-sidebar` (rewritten), `site-header` (rewritten). `app/page.tsx` and `app/layout.tsx` (title and description) changed.
- Deleted generated demo files: `app/dashboard/`, `nav-main`, `nav-projects`, `nav-secondary`, `nav-user`, `search-form`, and the unused `ui/` files `collapsible`, `dropdown-menu`, `avatar`, `label`.

Differences from the plan, and hand edits to generated files:
- `cn` is an npm package here, not a local helper. The registry lists `cn` as a dependency, so `init` created `lib/utils.ts` as `export { cn } from "cn"` and added `cn` to `package.json`. It is published from `github.com/shadcn-ui/cn`, maintained by `shadcn`, and has no install scripts. Standard shadcn used `clsx` plus `tailwind-merge`; this is a different implementation of the same helper.
- `init` also added dependencies `shadcn`, `radix-ui`, `class-variance-authority`, `lucide-react`, `tw-animate-css`, and `app/globals.css` now imports `shadcn/tailwind.css`. The lockfile grew by about 4,300 lines, mostly from the `shadcn` package.
- `app/globals.css` (generated, hand-fixed): `--font-sans: var(--font-sans)` referred to itself, so it is now `var(--font-geist-sans)`. Light theme only; the old OS dark-mode block is gone and nothing sets `.dark`.
- `hooks/use-mobile.ts` (generated, hand-rewritten): the generated version failed this repo's `react-hooks/set-state-in-effect` lint rule, so it now uses `useSyncExternalStore` with the same breakpoint and a `false` server snapshot.
- `components/ui/alert.tsx` needed no edit: `role="alert"` is placed before `{...props}`, so a caller's `role="note"` wins.
- The installed `sidebar.tsx` writes a `sidebar_state` cookie in `setOpen` (client-side only), has no `next/headers` or `cookies(`, and no longer wraps itself in `TooltipProvider`. The CLI suggests adding `TooltipProvider` to the layout; it is not needed because nothing here passes a `tooltip` to `SidebarMenuButton`.

Verified (all run after the last code change):
- `npx tsc --noEmit` clean, `npx eslint .` clean, `npx vitest run` 159 tests passing across 12 files.
- `npm run build` passes. Route table: `/` is `○ (Static)`, `/api/ask` is `ƒ (Dynamic)`.
- No sample content in generated or rewritten UI files, `/dashboard` does not exist, no `dangerouslySetInnerHTML` anywhere.
- No changes under `scripts/`, `evals/`, `app/api/`, or `lib/answer.ts`, `plan.ts`, `filters.ts`, `retrieve.ts`, `schema.ts`; nothing in `lib/`, `scripts/` or `evals/` imports from `components/` or `app/`.
- The eval was not re-run (paid calls), so "unaffected" means "untouched", not "re-measured".

Verification limitation (not run):
- The in-browser scenarios in section 9 were not run. The only browser tool in this session is a remote hosted browser that cannot reach `localhost`, and neither the built-in browser nor Chrome tools are available, so the fetch-interception check could not be made fail-closed. Not verified in a real browser: streaming rendering, citation click scroll and focus, the status region and alert roles per transition, keyboard access to the disabled sidebar items, the narrow-viewport sheet and any first-paint flash, and the dev-server behaviour with the `radix-nova` preset. The logic behind these is covered by the Vitest suite (state machine, transport, abort, parser, citations, focus helper, status text, alert roles), but the rendered DOM is untested.
- Live Qdrant and OpenAI checks were not run.

To finish verification, run `npm run dev` and open `http://localhost:3000`, or give this session a local browser tool.
