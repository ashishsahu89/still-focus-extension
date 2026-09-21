# Still

Still is a private, local-first Chrome extension for interrupting autopilot browsing and protecting focused work.
Get it on Chrome Webstore: https://chromewebstore.google.com/detail/eiijncfohledpijjmjkbblopbinbgikm?authuser=0&hl=en-GB

## What it has

- A deliberate pause before distraction and intention-setting
- Reliable site protection and timed focus blocks
- Low-friction screen-time awareness
- Calm growing visual, without coins, streak anxiety, or punishment

## Install locally

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `still-focus-extension` folder.
5. Pin **Still** from Chrome’s extensions menu.

No build step, account, server, or Chrome Web Store upload is required.

## Chrome Web Store release prep

The release materials live in [`CHROME_WEB_STORE_LISTING.md`](CHROME_WEB_STORE_LISTING.md), and the public policy is [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md). Create a clean upload ZIP with:

```bash
npm run package:extension
```

The ZIP is written to `dist/` (which is intentionally ignored by Git). It contains only the Manifest V3 runtime files and icons—no tests, source notes, secrets, or development dependencies.

## Development checks

Install the development dependency once, then run the full regression suite after meaningful changes:

```bash
npm install
npx playwright install chromium
npm run test:all
```

`test:all` runs the local Node tests and a Playwright smoke test in a temporary Chrome profile. The browser test exercises the popup and native tab groups without touching the user's real tabs.

## Core flow

1. Choose a focus duration and optionally name what matters.
2. Still protects enabled sites during the session.
3. Outside sessions, Mindful Pauses can continue interrupting habitual visits.
4. After one breath, return to focus or intentionally continue for five minutes.
5. During intentional access, a compact on-page timer shows the remaining time and offers **End now**.
6. Outside focus, the five minutes become a per-site 30-minute allowance. When they end, Still returns every open tab for that protected site to a dedicated expiry screen—even if the page timer was throttled in a background tab. A single declared 15-, 30-, or 60-minute task exception is available from that screen; it cannot be extended or repeated.
7. Strict focus snapshots the protected-site list for the session. Ending early requires a reason and a 20-second cooldown, while an explicit emergency exit always remains available.

In regular (non-strict) focus, Still allows one shared five-minute break across all protected sites. When that break ends, the rest of the session remains protected. Strict focus allows no temporary access.

When focus begins, Still also redirects protected sites that were already open and watches single-page-app history changes such as YouTube navigation.

## Tab organization

The popup includes a one-click **Organise tabs** action. Still groups repeated websites and distinct cross-site categories as `💬 Social`, `🛍️ Shopping`, `🎬 Video`, and `📰 News`; an otherwise unclassified tab with a standalone `news` word in its title also qualifies for News. It avoids collapsing broad Work, Research, or Learning sets into one generic group. Matching ungrouped tabs join an existing automatically named group, including a linked-tab group when every added tab matches that group's source domain; groups that have been renamed are left alone. Local website names use the registrable domain plus a meaningful subdomain when one exists (`Salesforce · Planview`, `LeanKit · Planview`, or `Glean` for `app.glean.com`); infrastructure prefixes such as `app`, `login`, and `dashboard` are omitted. New bulk groups are appended after existing groups, start collapsed except for the group containing the active tab, and offer an undo action. Still combines these conservative local rules with the active external model or Chrome's on-device model, which must provide a specific workstream rather than a generic title such as Work.

Still can also keep linked tabs together while you browse. When a link opens in a new tab, Still creates an open group beside its source tab so the browsing flow remains visible. These groups:

- dissolve when only one tab remains
- use `🔗 <source website>` for locally named linked-tab groups, including when every tab is from the same site
- can be renamed by an active connected model as their shared topic changes

Keeping linked tabs together is enabled by default and can be turned off under **AI → Tab organization** when the browser already provides a similar feature. This setting does not disable the one-click **Organise tabs** action.

## Settings and insights

Settings now open into a small navigation system:

- **Insights:** Day, week, and month views for focused time, sessions, impulses, active-tab categories, the ten most-used websites, distraction timing, and protected-site activity
- **Protection:** Focus behavior, strictness, pause length, and the protected-site list
- **Routines:** Recurring protection windows with chosen days, times, sites, mode, topic, and ask-first or automatic start
- **AI:** Browser-provided intelligence plus direct connections to OpenAI, Ollama, LM Studio, or another OpenAI-compatible endpoint
- **Data & privacy:** Active-tab measurement controls, focus-session history, recent intentions, and a clear explanation of local storage and connected-model requests

Routines notify you five minutes before they begin with **Start now** and **Skip today**. They never replace an active focus session, and opening the browser partway through an automatic routine starts only the remaining scheduled time. Protected-site usage reflects intentional-access time granted through Still’s five-minute passes.

Still’s category insights measure only the domain in the active tab of the browser’s focused window. Measurement pauses when the browser loses focus, the user is idle, or the setting is turned off. The category/website switch changes between category totals and the ten websites with the most active usage. Still never records page paths, page titles, or page content as browsing history. Daily domain totals are retained for up to 550 days; bounded domain-only occurrences are retained for up to 90 days so time-of-day patterns can be calculated.

Categories work without AI through a bundled taxonomy and conservative hostname rules. When Insights needs unfamiliar sites categorized, Still tries the active external model first, Chrome's on-device model second, and its bundled defaults last. Learned categories are remembered locally. The reset control clears them and requests fresh categories for websites visited during the previous seven days. Category requests are batched, and only confident, valid suggestions from Still's fixed taxonomy are saved.

The AI page checks for a compatible browser-provided Prompt API and also lets users connect OpenAI, Ollama, LM Studio, or another OpenAI-compatible Chat Completions endpoint. A saved external connection can be disabled and enabled again without removing its settings or key. Connection metadata and API keys are stored only in Still’s local extension storage on that device, restricted to trusted Still contexts. Chrome extension storage is not encrypted by Still; users who need a key to disappear on browser restart can remove the model connection.

Local endpoints and Chrome's built-in model stay on the device. When a remote model is enabled, tab organization may send tab titles and domains, while category Insights may send aggregated domains, active time, visit counts, and time-of-day totals. Full page addresses and page contents are never included. Requests go directly from the extension to the selected provider and follow that provider's privacy and billing terms. Still has no relay server and never receives the key or request.

After enough local activity, Still can suggest a routine for a repeated distraction window. Suggestions use a transparent 28-day calculation based on impulse frequency, consistency across active days, recency, existing routines, and successful focus sessions in the same window. The suggestion appears in Routines and alongside **When distraction shows up** in Insights. Still never creates the routine automatically: **Review routine** opens a pre-filled form, while **Not now** pauses suggestions for two weeks.

## Permissions

- `storage`: stores your settings and private local history
- `tabs` and `webNavigation`: notices visits to sites you chose and replaces them with the pause page
- `idle`: pauses active-tab measurement when the computer is not in use
- `alarms`: completes focus timers reliably while the popup is closed
- `notifications`: gives routine reminders and the Start now / Skip today actions
- `<all_urls>`: supports any protected domain and lets Still organize ordinary web tabs; Still has no server, and remote-model requests are sent only to a provider the user explicitly connects and enables
