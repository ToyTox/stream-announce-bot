# stream-announce-bot

**English** · [Русский](README.md)

The bot watches Twitch, YouTube and VK Live and, when you start a stream, posts a single announcement with links to every platform you are live on to a Telegram group (and, if a webhook is configured, to a Discord channel). OBS starts the stream everywhere at once, so instead of several notifications you get one message. When the stream ends, the bot sends a separate message with the duration and links to the recordings.

You can manage the bot from the app window or with commands in a private chat on Telegram. Discord has no commands: it only receives messages.

## Download and install

Download an installer from the [Releases](https://github.com/ToyTox/stream-announce-bot/releases) page — there is nothing to build.

**Mac**

1. Download `stream-announce-<version>-arm64.dmg` for a Mac on Apple Silicon (M1 and newer) or `stream-announce-<version>-x64.dmg` for Intel. To find out your processor: the  menu → "About This Mac".
2. Open the `.dmg` and drag the app to "Applications".
3. The app is signed with a free signature without a developer certificate, so on the first launch macOS will say it cannot verify the app. Close the window, open "System Settings → Privacy & Security", scroll down to the message about the app and click "Open Anyway". You only need to do this once.

**Windows**

1. Download `stream-announce-<version>-x64.exe` and run it. The installer asks for administrator rights and installs the app into `Program Files`; the folder can be changed. Shortcuts appear on the desktop and in the Start menu.
2. SmartScreen may show "Windows protected your PC": click "More info → Run anyway".

On the first launch the window opens on the "Settings" tab. After that the app lives in the background: an icon in the menu bar (on Windows, the tray) shows the status, and the window opens with the "Open panel" item. Closing the window with the cross does not stop the bot; to quit, choose "Quit" in the icon menu.

## Bot setup

1. **Telegram bot**: send `@BotFather` the `/newbot` command and get a token — this is `TELEGRAM_BOT_TOKEN`.
2. **Group**: add the bot to the group. Admin rights are not required unless members are not allowed to write in the group.
3. **Group ID** (`TELEGRAM_CHAT_ID`): copy a link to any message in the group — `t.me/c/2241331974/…` — and put `-100` before the number: `-1002241331974`.
4. **Topic** (`TELEGRAM_TOPIC_ID`): if topics are enabled in the group, the topic ID is the first number after the group ID in a link to a message from that topic. For the main topic (General, even renamed) leave the field empty.
5. **Your user ID** (`TELEGRAM_ADMIN_ID`): message `@userinfobot`, and it will reply with your ID. Then send `/start` to your bot — otherwise it cannot write to you privately.
6. **Twitch**: create an app at [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) (Redirect URL — `https://localhost`, client type — "Confidential") and take the Client ID and Client Secret. The login is as in the address `twitch.tv/<login>`.
7. **YouTube**: the channel ID like `UC…` is at [youtube.com/account_advanced](https://www.youtube.com/account_advanced). The `@…` handle will not work.
8. **VK Live**: the channel name from the address `live.vkvideo.ru/<name>`. For the recordings link, put the channel on vkvideo.ru into `VKVIDEO_REPLAY_URL`.
9. **Discord** (optional): Server Settings → Integrations → Webhooks → New Webhook → choose the channel → "Copy Webhook URL". An address like `https://discord.com/api/webhooks/<id>/<token>` is `DISCORD_WEBHOOK_URL`. The address contains a token: do not show it to anyone.
10. **Check**: on the "Status" tab click "Test message to the group".

Enter the values on the "Settings" tab of the panel; at least one platform is required. Each group there also has a collapsed "How to get it" guide.

## Control panel

| Tab | What is there |
|-----|---------------|
| Status | Whether you are live, whether the announcement was sent (with a link to the message), the state of each platform and check errors. The "Check now" and "Test message to the group" buttons |
| Message | The text for the announcement (like `/text`), your own preview — uploading an image from the computer, a preview of the announcement and of the stream-ended message |
| Settings | All parameters as a form. Secrets are shown masked, an empty field means "do not change". Saving validates the values and restarts the bot without a repeated announcement. The "Import .env…" button replaces the settings with a whole file |
| Log | The last 300 lines of what the bot writes |

- The panel is available only on this computer, there is no password.
- Uploading an image requires `TELEGRAM_ADMIN_ID`: the bot sends it to you in a private chat so that Telegram stores the file.
- If the settings are filled in with an error, the bot will not start, but the panel will show the error — it can be fixed on the "Settings" tab.

## Bot commands

Write to the bot in a private chat. It answers only messages from `TELEGRAM_ADMIN_ID`; without this setting the commands are off.

| Command | Description |
|---------|-------------|
| `/text <text>` | Text for the next announcement; cleared after sending |
| `/text` | Show the current text |
| `/text -` | Clear the text |
| *photo* | Your own preview for all announcements — until replaced by another photo or cleared. Send it as a photo, with compression |
| `/image` | Whether a custom preview is set |
| `/image -` or `/image_clear` | Clear the custom preview |
| `/status` | Whether you are live, on which platforms and since when |
| `/help` | Command help |

## Language

The interface and the announcement texts come in Russian and English and are configured separately. The interface language is changed with the switch in the panel header or with the "Interface language" field on the "Settings" tab; the announcement language is the "Announcement language" field there. If left empty, the interface follows the system language and the announcement uses the interface language. The bot commands are the same in every language.

## What the messages look like

**Announcement** — a photo with a caption:

```
Hello everyone

🔴 <stream title on Twitch>
🎮 <game on Twitch>

<text from /text or the panel>

▶️ Twitch
▶️ YouTube
▶️ VK Video
▶️ VK Live
```

**Stream ended** — a separate text message:

```
⚫️ <stream title on Twitch>
🎮 <game on Twitch>

Stream ended, it lasted 2 h 47 min

Thanks to everyone who dropped by the stream, you can watch the replay here:

▶️ Twitch
▶️ YouTube
▶️ VK Video
▶️ VK Live
```

The platform name is a clickable link. In Discord the content is the same, but it is a card. The announcement contains the platforms that were live at the moment of sending, the summary — all configured channels. The 🎮 line is absent if no category is chosen on Twitch; the line with the text is absent if it is not set. The announcement does not go out immediately but 90 seconds after the first platform, to wait for the others. The title and game are taken from Twitch, the preview is your own (if set) or the Twitch one. The detailed rules are in the [developer document](docs/development.en.md).

## Updates and data

Once a day the app checks the latest release on GitHub; if there is a newer one, the icon menu shows "Version X is available — download". Download the new installer and install it over the old one: settings and the database are kept. The current version is shown in the icon menu and in the panel header.

The data lives in `~/Library/Application Support/Анонсы стримов/` on Mac and `%APPDATA%\Анонсы стримов\` on Windows: the `.env` and `bot.db` files. On Windows the data is stored separately for each user, so run the bot under a single account.

**Run the bot in only one place — on Mac or on Windows.** Two copies with the same Telegram token will send the announcement twice and steal each other's commands.

## For developers

Running from source, releasing a version, `.env` variables, scripts and the project structure are in [docs/development.en.md](docs/development.en.md).
