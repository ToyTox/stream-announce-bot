# For developers

**English** · [Русский](development.md)

The instructions for the app user are in the [README](../README.en.md).

## Stack

- **Node.js 22** with TypeScript (ESM)
- **axios** — HTTP requests to the platforms and Telegram
- **better-sqlite3** — local state database
- **Electron** + **electron-builder** — the desktop app and its installers
- **node:http** — the web panel, no frameworks and no frontend build
- **vitest** — tests

## Installing from source

```bash
npm install
cp .env.example .env
```

Fill in `.env` (see "Bot setup" in the [README](../README.en.md#bot-setup) and the variables table below) or start the bot and fill in the settings in the web panel.

## Running

### Production mode — the bot announces streams

```bash
npm run build
npm start
```

Runs the compiled JavaScript from `dist/` together with the web panel. The bot works while the terminal is open and does not restart when files change.

After changing the code (including after `git pull`) stop the bot (Ctrl+C) and repeat `npm run build` and `npm start`. The stream state is kept in the database, so restarting in the middle of a stream does not cause a repeated announcement.

### Development mode — editing code

```bash
npm run dev
```

Runs TypeScript directly and restarts the bot on every file save in `src/`. No build is needed.

To avoid sending messages to the group during development, set `DRY_RUN=true` — announcements will only be printed to the terminal — or put your own user ID into `TELEGRAM_CHAT_ID` so that they arrive in your private chat.

### What to choose

| Task | Command |
|------|---------|
| The bot runs and announces your streams | `npm run build` + `npm start` |
| You change the code or the message template | `npm run dev` |
| The bot in the background with a menu bar icon | the ready-made app from Releases or `npm run desktop` |

Do not run two instances at the same time: they share one database and one token, so they may send the announcement twice and steal each other's commands.

### Running on a Mac without sleep

If the bot runs on a MacBook that works with the lid closed, disable sleep:

```bash
sudo pmset -a disablesleep 1   # to undo: sudo pmset -a disablesleep 0
```

Screen lock and a turned-off display do not bother the bot — only system sleep stops it. With this setting do not put the MacBook in a bag: it will not sleep and will drain the battery.

## Desktop app

"Stream Announcements" ("Анонсы стримов" in Russian) is an Electron shell: the bot runs in the background, a status icon sits in the menu bar (tray), and the window shows the same web panel.

```bash
npm install
npm run desktop
```

The command builds the app into `dist-desktop/` and launches it. On the first launch (or if the settings contain an error) the window opens on the "Settings" tab; after that the app lives in the tray, and the window opens with the "Open panel" item.

**Tray menu**

| Item | What it does |
|------|--------------|
| Status (inactive line) | "Not live", "● Live since 18:00 · Twitch, YouTube", "Test mode" or "The bot is not running: <error>" |
| Open panel | Shows the window |
| Check now | An out-of-turn check of the platforms |
| Launch at login | Autostart of the app (starts hidden, in the tray) |
| Prevent the system from sleeping | While on, the system does not go to sleep from inactivity; it does not affect the closed lid |
| Quit | Stops the bot and closes the app |

The icon changes: a ring — not live, a filled circle — live, with "!" — test mode or a platform check error, crossed out — the bot is not running. Closing the window with the cross only hides it (on macOS the Dock icon disappears too): the bot keeps working. Notifications arrive when the announcement is sent, the stream has ended, or the announcement could not be sent.

**Updates.** Once a day the app checks the latest release on GitHub; if there is a newer one, the tray menu shows "Version X is available — download" and one notification arrives. Download the new installer and install it over the old one: settings and the database are kept. The current version is shown in the tray menu and in the panel header.

**Moving from version 0.1.0.** It was installed into the user folder without administrator rights: the new installer removes the old copy by itself and installs the new one into `Program Files`; settings and the database are kept, and launch at login starts pointing to the new copy on the first launch. If after the installation "Apps & features" still shows two entries or the desktop has two shortcuts, delete the old copy (the one in the user folder) manually: the settings and the database will stay. This happens when the administrator rights in the UAC window were granted by a different account.

**Where the data lives.** `.env` and the `bot.db` database are in the app folder: `~/Library/Application Support/Анонсы стримов/` (on Windows `%APPDATA%`, on Linux `~/.config`). On Windows the data is stored separately for each user (in the current user's `%APPDATA%`) even if the app is installed for everyone, so run the bot under a single account. If the administrator rights during the installation were granted by a different account, the desktop shortcut may appear for that account; the data is still stored for whoever runs the app. The app does not read the `.env` in the project root. If `DATABASE_PATH` is not set, the database is created next to `.env`.

**Moving settings.** On the "Settings" tab the "Import .env…" button replaces the app settings with the chosen file: it is validated, and if there is an error in it, nothing changes. This is how you can move settings over from the terminal mode.

**One copy.** A second launch does not create a second bot but shows the window of the one already running.

**Do not run together with `npm start`.** The app has its own database: two bots with one token do not know about each other and will send the announcement twice. Choose one way to run.

**MacBook with a closed lid.** The "Prevent the system from sleeping" item does not stop sleep with a closed lid — that still needs `sudo pmset -a disablesleep 1` (see "Running on a Mac without sleep").

**Native module.** Since version 13, better-sqlite3 is built on Node-API, so the same binary works in both Node (`npm test`, `npm start`) and Electron — no rebuild for Electron is needed. If an unsuitable binary was loaded on your platform, rebuild the module: `npx electron-rebuild -f -w better-sqlite3` (for Electron) or `npm rebuild better-sqlite3` (for Node). The `scripts/desktop.mjs` script launches Electron without the `ELECTRON_RUN_AS_NODE` variable that the VS Code terminal sets.

For checks you can set a separate data folder: `STREAM_BOT_USER_DATA=/tmp/bot-test npm run desktop`.

## Releasing a version

The installers are built by GitHub Actions, nothing needs to be uploaded by hand:

```bash
npm version patch        # 0.1.0 → 0.1.1 — fixes
npm version minor        # 0.1.0 → 0.2.0 — new features
git push --follow-tags   # pushes the commit and the tag — starts the build
```

Each `npm version` command changes `package.json` and creates the tag `vX.Y.Z`. While the version starts with `0.`, the product is considered not ready; `1.0.0` is the first stable version (`npm version major`).

The very first release is the already set version `0.1.0`, the tag is created manually:

```bash
git tag v0.1.0
git push origin v0.1.0
```

In 10–15 minutes a release with three files (`arm64.dmg`, `x64.dmg`, `x64.exe`) and a changelog from the commits appears in [Releases](https://github.com/ToyTox/stream-announce-bot/releases). The build will not start if the version in the tag does not match `package.json`. Actions → Release → "Run workflow" makes a trial build without a release: the files stay in the run artifacts.

Local trial build: `npm run dist:mac` or `npm run dist:win` (the result is in `release/`). If the terminal sets `ELECTRON_RUN_AS_NODE` (VS Code), run with `env -u ELECTRON_RUN_AS_NODE`.

## Chapter audit

When the last task of chapter A, B or C from `docs/mobile-app-plan.md` is closed on `main`, an audit starts shortly before the weekly Claude Code subscription limit resets: the `chapter-auditor` agent (model `fable`) writes a report with a follow-up plan to `docs/audits/chapter-<chapter>.md`. Mac only, via a LaunchAgent.

### Launch security

- `claude -p` runs with `--permission-mode dontAsk`: anything not explicitly allowed is denied without a prompt. Permission bypass modes and disabled prompts are not used.
- Tools: only Read, Grep, Glob and Write (`--tools`). No Bash, network, subagents or MCP.
- Writing is allowed by an `Edit(...)` rule only for `docs/audits/` in a separate working copy of `main` (`Edit` rules also cover Write).
- The script runs git before the model starts: it reads the plan from `main`, checks for a report, creates a separate working copy of `main` (your working tree and branch are untouched) and puts the history in a file for the agent. The script copies the finished report to `docs/audits/` of the main repository; you commit it yourself.

### Install and manage

The limit reset time (see your subscription settings) is set manually, only at install:

```bash
node scripts/chapter-audit.mjs install --day Tue --time 18:30 --lead 120 --tz Europe/Moscow
```

- `--day` is the reset weekday, `--time` the reset time, `--lead` the lead in minutes before the reset (default 120), `--tz` the time zone of the reset time (the Mac's time zone if omitted). The LaunchAgent fires every 15 minutes inside the window. launchd reads the schedule only in the Mac's time zone, so when `--tz` differs from the Mac's, install converts the window to the Mac's zone by real time, taking the daylight saving dates of both zones into account for a year ahead. Reinstall (`install` or `settings`) within a year and after changing the Mac's time zone. The script still decides whether to run using the `--tz` zone.
- Change settings: `node scripts/chapter-audit.mjs settings --lead 180` (reinstalls the LaunchAgent).
- Remove: `node scripts/chapter-audit.mjs uninstall`.
- Run manually for a chapter without waiting for the window: `node scripts/chapter-audit.mjs run-now A`. Before calling the model it checks the chapter report (in the working directory and on `main`), whether the chapter is closed on `main`, the agent on `main`, and the time left until the limit reset. If a report already exists or the chapter is not closed, `run-now` refuses. The `--force-open` flag lifts only the "chapter is closed" check (`run-now A --force-open`); the report and the time until reset are always checked. The window before the reset is not checked. The `--dry-run` flag prints the decision for all checks and the `claude` command without running anything.
- Settings, state and log are in `~/.stream-announce-bot-audit/` (`config.json`, `state.json`, `audit.log`). Two simultaneous runs are blocked.

### Before the first run

The working copy is made from `main`, so the `.claude/agents/chapter-auditor.md` agent and the `scripts/chapter-audit*.mjs` scripts must be committed to `main`. Until they are there, the audit will not start: the script writes a warning to the log and console and does not call `claude`.

Manual checks on the Mac: `claude --help` (the flags from "Launch security" exist), `claude --model fable -p "ok"` (the `fable` model is accepted), and after install `launchctl print gui/$UID/com.stream-announce-bot.chapter-audit` (the schedule, especially with `--tz` different from the Mac's zone).

### Limits

Every `claude` run, scheduled or manual, is forcibly stopped 5 minutes before the nearest limit reset (and no later than 4 hours in); if less than 25 minutes remain before the reset, the model is not started and the reason is written to the log. The report lands in `docs/audits/` only after a successful run: `claude` exited with code 0, was not stopped by the timer, and the report is complete (its last line is the `<!-- chapter-audit: complete -->` marker). Otherwise (error, timeout, turns exhausted, incomplete report) the chapter stays unaudited and the next attempt is in the next window; a partial report is kept for diagnostics in `~/.stream-announce-bot-audit/partial-chapter-<chapter>.md`, and the reason goes to `audit.log`.

The audit spends what is left of the weekly limit before the reset and occupies the current 5-hour window. If the limit is exhausted or the run fails, the next attempt is in the window a week later. A missed window is also moved to the next week; the audit does not spend the new week's limit.

### Sleeping Mac

A sleeping Mac misses the window. You can wake it in advance with `pmset repeat wakeorpoweron` (see `man pmset`; needs `sudo`, the script does not run it). If the Mac runs with the lid closed, see "Running on a Mac without sleep".

## Web panel

The panel starts together with the bot — open **http://localhost:3210**. The link is also printed in the terminal at startup.

- The panel listens only on `127.0.0.1`: it is not reachable from the network or from a phone, and requests from other sites are rejected. There is no password — everything visible in the panel already lies in `.env` on this computer.
- Saving the settings writes `.env` (comments are kept). At the start of each settings group there is a collapsed "How to get it" guide (works without internet), and a link to the README at the top.
- The port is changed with `WEB_PORT`, the panel is turned off with `WEB_ENABLED=false`. In the desktop app the panel always works, and if the port is busy, a free one is taken.
- There is a versioned `/api/v1` for external clients: `GET /api/v1/info` (API and app versions), `GET /api/v1/status` (bot status), `GET /api/v1/logs` (log, `after` parameter). Write and related read routes: `POST /api/v1/probe` (check now), `POST /api/v1/test-message`, `POST /api/v1/test-announce/telegram` and `/discord`, `GET`/`PUT`/`DELETE /api/v1/text`, `GET`/`PUT /api/v1/links` (static announcement links; `PUT` replaces the whole list, an invalid list is rejected with 400), `PUT`/`DELETE /api/v1/image` and `GET /api/v1/image/file`, `GET /api/v1/preview`, `GET`/`PUT /api/v1/settings` (settings; secrets have no value in the response, only an "is set" flag, and a request with a secret key is rejected with 400); behavior and responses match the panel's `/api/*`, and `GET /api/v1/info` exists only in v1. The Host and Origin checks are the same as the panel's (a foreign one gets 403). For now it is reachable only from localhost, like the panel. The `Authorization: Bearer <token>` header is optional on localhost, but if sent, the token is checked against the device registry in the database: an invalid, revoked or malformed token gets 401. Device tokens are stored only as a hash. The panel's `/api/*` routes do not use Bearer; the full contract description will appear in `docs/api-v1.yaml`.

## `.env` variables

| Variable | Required | What it sets |
|----------|----------|--------------|
| `TELEGRAM_BOT_TOKEN` | yes, unless `DISCORD_WEBHOOK_URL` is set | Bot token; Telegram is enabled when both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set, only one of the two is an error |
| `TELEGRAM_CHAT_ID` | yes, unless `DISCORD_WEBHOOK_URL` is set | Group for announcements |
| `TELEGRAM_TOPIC_ID` | | Forum topic; empty — the main one. Ignored if Telegram is not enabled |
| `TELEGRAM_ADMIN_ID` | | Your user ID: commands in the private chat and preview upload from the panel. Ignored if Telegram is not enabled |
| `DISCORD_WEBHOOK_URL` | yes, unless Telegram is set | Discord channel webhook: the announcement and the stream summary are duplicated there (if Telegram is configured) or sent only there; empty — Discord is off |
| `TWITCH_LOGIN`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | | Twitch — all three together |
| `YOUTUBE_CHANNEL_ID` | | YouTube |
| `YOUTUBE_API_KEY` | | Check YouTube through the Data API instead of the `/live` page |
| `VKVIDEO_CHANNEL` | | VK Live |
| `VKVIDEO_REPLAY_URL` | | Link to the VK Video channel with recordings |
| `APP_LANGUAGE` | | Interface language: `ru`, `en`; empty — the system language |
| `ANNOUNCE_LANGUAGE` | | Announcement language: `ru`, `en`; empty — same as the interface |
| `PRIMARY_PLATFORM` | | Where to take the title, game and preview from (`twitch`) |
| `POLL_INTERVAL_MS` | | Platform polling interval (`60000`) |
| `ANNOUNCE_GRACE_MS` | | Pause before the announcement (`90000`) |
| `OFFLINE_GRACE_MS` | | How much silence counts as the end of the stream (`180000`) |
| `ANNOUNCE_END` | | Stream-ended message (`true`) |
| `DRY_RUN` | | Send nothing, only print (`false`) |
| `DATABASE_PATH` | | Database file (`./data/bot.db`) |
| `WEB_ENABLED`, `WEB_PORT` | | Control panel (`true`, `3210`) |

At least one delivery destination (Telegram or Discord) and at least one stream platform (Twitch, YouTube or VK Live) are required. Default values are in parentheses.

## Interface and announcement language

The interface (panel, tray menu, notifications, bot replies in the private chat) and the announcement texts come in Russian and English. The languages are configured separately:

- **`APP_LANGUAGE`** — the interface language: `ru`, `en` or empty. Empty means the system language (in the panel — the browser language): Russian for Russian locales, English for all others.
- **`ANNOUNCE_LANGUAGE`** — the language of the fixed phrases in the announcement and in the stream summary in Telegram and Discord (greeting, thanks, duration). Empty means the same as the interface. Your channel's viewers may speak a language other than yours, which is why the announcement language is set separately. The stream title and the text insert are not translated.

You can change the interface language with the switch in the panel header (the bot is not restarted) or with the "Interface language" field on the "Settings" tab; the announcement language is the "Announcement language" field there. The choice is saved in `.env`. The bot commands (`/text`, `/image`…) are the same in every language, only the replies change.

A new language is added by a dictionary file in `src/i18n/` (a copy of `en.ts` with translated texts) and one line in `DICTIONARIES` in `src/i18n/index.ts`; no markup changes are needed. A test checks that the new dictionary has all the keys.

## Behavior

- **The first platform noticed** opens the stream, but the announcement does not go out immediately: the bot waits 90 seconds (`ANNOUNCE_GRACE_MS`) for the other platforms to connect from OBS.
- **One message** with links to all platforms that are live at the moment of sending.
- **Static links**: in the panel ("Message" tab) the user keeps their own list of "name + URL" links, including platforms the bot does not track (Kick, Boosty), and marks which ones are "always in announcement". If at least one is marked, the announcement contains only the marked links in list order, and the set of running platforms is not used for links; with no marks everything works as described above. In this mode the announcement does not wait for `ANNOUNCE_GRACE_MS` when the primary platform is live (the title and game come from it); without it, it waits as usual. The links are fixed at the first delivery, like the text insert: editing the list during a stream does not change the retry for another channel. The list is stored in the `setting` table and managed through `GET`/`PUT /api/links` and `/api/v1/links`. The list holds up to 20 links, a name up to 64 characters, an address up to 512 characters, `http://` or `https://` only. The marked links together must fit in the Telegram caption with room left for the announcement header, otherwise `PUT` is rejected with 400; if an overlong block still gets into an announcement, `renderAnnounce` drops the extra links from the end. The stream summary and the `announced` event do not change.
- **Title and game** are taken only from Twitch (`PRIMARY_PLATFORM`): they may differ on other platforms. If Twitch is not live, the title will be "Live stream" (in a Russian announcement, "Трансляция").
- **Preview**: your own (from the private chat or the panel) if set, otherwise the Twitch preview. If there is neither, the announcement goes out as text.
- **Telegram and Discord are independent**: each delivery platform has its own state in the database. A failure of one does not block the other and does not repeat what has already been delivered; an undelivered one is retried in the following checks while the stream is on. A permanent Discord error (webhook deleted or wrong: 400, 401, 403, 404) causes no retries. The stream summary goes only where the announcement arrived. A platform connected in the middle of a stream does not get a catch-up announcement.
- **Discord**: messages arrive as a card (embed) with the same links; `@everyone` in the title pings nobody. The bot attaches the image as a file (`multipart`, `attachment://…` in the embed): your own from `/image` and the panel, otherwise the Twitch preview (only if the primary platform is Twitch), otherwise the message goes as text. YouTube and VK Video previews do not go to Discord. If your own image cannot be obtained or the Twitch preview fails to download (timeout, not an image, larger than 10 MiB), the announcement goes without an image with a warning in the log; the delivery still counts as done. Discord gets your own image from the local copy (see below), not from Telegram. The text from `/text` is shown as is, without formatting.
- **Local copy of your own image**: the files `announce-image.bin` (the bytes) and `announce-image.json` (the `file_id` and the type) live in the data folder, that is the directory of `DATABASE_PATH` (userData in the desktop app). The copy is valid while its `file_id` matches the one stored in the database. The panel and `/image` save it right away (the panel with the original png/jpeg/webp type, Telegram returns jpeg); if there is no copy (the image was set before the update or the download failed), it is downloaded from Telegram once on first use (an announcement or a preview). `/image -`, `/image_clear` and clearing in the panel delete the files. The read, write and re-download logic is in `src/announceImage.ts`.
- **The announcement is not edited**: if a platform goes down afterwards, its link stays; if it connects later, it does not get into the announcement.
- **Ending**: the stream is closed if all platforms are silent for more than 3 minutes (`OFFLINE_GRACE_MS`) — this protects against disconnects. After that a separate message with the duration and links to the channels with recordings goes out. Turned off with `ANNOUNCE_END=false`.
- **A platform check error** (network, API failure) does not close the stream — only an explicit "offline" answer does.
- **A restart** in the middle of a stream, including from the panel, does not cause a repeated announcement.
- **Language**: the fixed phrases of the announcement and the summary follow `ANNOUNCE_LANGUAGE`; see "Interface and announcement language". With `ANNOUNCE_LANGUAGE=ru` the fixed phrases are in Russian ("Всем привет", "Эфир завершён, длился …").

In Discord the content of the messages is the same, but it is a card with Markdown links. VK Video goes together with VK Live.

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run build` | Build TypeScript into `dist/` |
| `npm start` | Production run of the built project (run `npm run build` first) |
| `npm run dev` | Development run: restart on file save |
| `npm run desktop` | Build and run the desktop app (`dist-desktop/`) |
| `npm run build:desktop` | Only build the desktop app |
| `npm run icons` | Redraw the tray icons in `desktop/assets/` and the app icon `build/icon.png` |
| `npm run dist:mac` | Local `.dmg` build into `release/` (for the current processor; `-- --x64` — for Intel) |
| `npm run dist:win` | Build the Windows installer into `release/` (more reliable on Windows) |
| `npm test` | Tests |
| `npm run typecheck` | Type check without a build |

## Structure

| Path | What it does |
|------|--------------|
| `src/index.ts` | Entry point of the terminal mode |
| `src/app.ts` | Shared start of the bot and panel for terminal and desktop: reading `.env` by path, stopping |
| `desktop/main.ts` | Electron: tray, panel window, launch at login, notifications |
| `desktop/trayStatus.ts` | Status lines and icon for the tray (without Electron, so tests can check them) |
| `desktop/updates.ts` | Checking for a new version in GitHub Releases |
| `electron-builder.yml`, `build/icon.png` | Settings of the `.dmg` and `.exe` installers, the app icon |
| `.github/workflows/release.yml` | Building and publishing a release for a `v*` tag |
| `src/version.ts` | Version from `package.json` for the panel |
| `desktop/assets/`, `scripts/` | Tray icons and scripts (drawing icons, launching Electron) |
| `src/bot.ts` | Assembling the bot from the config, timer polling, restart with new settings |
| `src/announcer.ts` | Stream logic: opening, announcement, ending; delivery per platform (Telegram, Discord) |
| `src/announceTemplate.ts` | Message templates for Telegram and Discord |
| `src/announceImage.ts` | Your own announcement image: a local copy in the data folder and re-download from Telegram |
| `src/i18n/` | Dictionaries (`ru.ts`, `en.ts`), language selection and fallback to Russian |
| `src/discord/client.ts` | Discord webhook client |
| `src/watchers/` | Twitch, YouTube, VK Live checks |
| `src/telegram/` | Bot API client and commands in the private chat |
| `src/store.ts`, `src/db.ts` | SQLite: streams, platforms, text and preview, static announcement links (`setting` table), the `device` table |
| `src/devices.ts` | Mobile app device registry: token issuing, checking by SHA-256 hash, revoking |
| `src/web/` | Panel server and `/api/v1` (including the Bearer check), settings form, `.env` writing |
| `scripts/chapter-audit.mjs`, `scripts/chapter-audit-lib.mjs`, `.claude/agents/chapter-auditor.md` | Temporary development tool: audit of mobile app plan chapters (see "Chapter audit"), to be removed after the plan |
| `web/index.html` | The panel page |
