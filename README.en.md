# stream-announce-bot

**English** · [Русский](README.md)

The bot watches the channels you configure on Twitch, YouTube and VK Live. It sends one announcement per stream to your Telegram group, Discord channel, or both, depending on your settings. If you stream to several platforms, for example with OBS, the links can go in a single announcement. When the stream ends, the bot can send a separate message with the duration and links to the channels where viewers can find recordings.

You can manage the bot from the app window or with commands in a private chat on Telegram. Discord has no commands: it only receives messages. Telegram is optional if a Discord webhook is set: then the bot announces only to Discord and is managed through the panel.

## Download and install

Download an installer from the [Releases](https://github.com/ToyTox/stream-announce-bot/releases) page — there is nothing to build.

**Mac**

1. Download `stream-announce-<version>-arm64.dmg` for a Mac with Apple silicon (M1 and later) or `stream-announce-<version>-x64.dmg` for Intel. To identify your processor, choose "About This Mac" from the Apple menu ().
2. Open the `.dmg` and drag the app to "Applications".
3. The app uses an ad hoc signature, so macOS may block it on first launch. After trying to open the app, go to "System Settings → Privacy & Security", scroll down to the message about the app, click "Open Anyway" and confirm. [Apple Support](https://support.apple.com/en-us/102445)

**Windows**

1. Download `stream-announce-<version>-x64.exe` and run it. The installer asks for administrator rights and installs the app into `Program Files`; the folder can be changed. Shortcuts appear on the desktop and in the Start menu.
2. SmartScreen may show "Windows protected your PC": click "More info → Run anyway".

On the first launch the window opens on the "Settings" tab. After that the app lives in the background: an icon in the menu bar (on Windows, the tray) shows the status, and the window opens with the "Open panel" item. Closing the window with the cross does not stop the bot; to quit, choose "Quit" in the icon menu.

## Bot setup

On the "Settings" tab, configure at least one delivery destination (Telegram or Discord) and at least one streaming platform to monitor (Twitch, YouTube, or VK Live). The Telegram, Discord, Twitch, YouTube, and VK Live groups each have a "How to get it" guide.

### Delivery destinations

- **Telegram.** Send `/newbot` to `@BotFather` and enter the resulting token in `TELEGRAM_BOT_TOKEN`. Add the bot to the group and give it permission to post. Delivery requires the token and `TELEGRAM_CHAT_ID`. Leave both fields empty if you only use Discord.
- **Discord.** Open "Server Settings → Integrations → Webhooks → New Webhook", choose the channel and click "Copy Webhook URL". Set `DISCORD_WEBHOOK_URL` to the resulting address, which looks like `https://discord.com/api/webhooks/<id>/<token>`. Keep it secret.

**Find `TELEGRAM_CHAT_ID`.** If the supergroup has a message link like `t.me/c/2241331974/…`, add `1000000000000` to the first number after `t.me/c/` and put a minus sign in front. The result in this example is `-1002241331974`. [Message links](https://core.telegram.org/api/links#message-links) · [ID format](https://core.telegram.org/api/bots/ids)

For a basic group or a group without a `t.me/c/…` link, get the ID through the Telegram Bot API. Fully exit the app using "Quit" in the icon menu. This method requires a bot with no active webhook and no other running client receiving updates with the same token. Send `/start@<bot_username>` in the target group, using the bot's username without angle brackets. Telegram delivers this addressed command even in privacy mode. [How bots receive messages](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get)

Run the block for your system and enter the token when prompted. The prompt hides your input. The token stays out of command history, and the `getUpdates` request goes directly to Telegram over HTTPS.

**macOS — Terminal**

```sh
(
  printf 'Bot token: '
  IFS= read -r -s telegram_bot_token || exit 1
  printf '\n'
  printf 'url = "https://api.telegram.org/bot%s/getUpdates"\n' "$telegram_bot_token" |
    curl --disable --silent --show-error --config -
)
```

**Windows — PowerShell**

```powershell
& {
  $telegramBotToken = [pscredential]::new('bot', (Read-Host 'Bot token' -AsSecureString)).GetNetworkCredential().Password
  ('url = "https://api.telegram.org/bot{0}/getUpdates"' -f $telegramBotToken) |
    curl.exe --disable --silent --show-error --config -
}
```

In the `result` array, match the command you just sent by its `message.text`, send time `message.date` (Unix time in seconds), and group name `message.chat.title`. Reopen the app and copy the full `message.chat.id`, including the minus sign and every digit, into `TELEGRAM_CHAT_ID`. The request reads unconfirmed updates using Telegram's current filter. The app's filter includes `message`. If the response contains 100 older updates, wait for them to expire and send the command again. [getUpdates method](https://core.telegram.org/bots/api#getupdates)

### Streaming platforms

- **Twitch.** Fill in all three fields (`TWITCH_LOGIN`, `TWITCH_CLIENT_ID`, and `TWITCH_CLIENT_SECRET`) or leave the whole block empty. Take the login from `twitch.tv/<login>`. To get the Client ID and Client Secret, create an app with `https://localhost` as the redirect URL and "Confidential" as the client type. [Twitch Developer Console](https://dev.twitch.tv/console/apps)
- **YouTube.** Enter the channel ID beginning with `UC` in `YOUTUBE_CHANNEL_ID`. [Find your channel ID](https://support.google.com/youtube/answer/3250431)
- **VK Live.** Enter the channel name from `live.vkvideo.ru/<name>` in `VKVIDEO_CHANNEL`.

### Optional fields

- `TELEGRAM_TOPIC_ID` sends messages to a specific topic. Copy a link to a message in that topic. If the link has a `thread` parameter, use its value (`42` in `t.me/c/2241331974/357?thread=42`). If the topic has its own path segment, use the number before the message ID (`42` in `t.me/c/2241331974/42/357`). In both examples, `357` is the message ID. Leave the field empty for the main topic (General). [Telegram message link formats](https://core.telegram.org/api/links#message-links)
- `TELEGRAM_ADMIN_ID` enables bot commands and private chat features, including uploading a preview. The bot token and group ID are enough for group delivery. To enable private chat, get your user ID from `@userinfobot`, enter it in the settings, and send `/start` to your bot.
- With `YOUTUBE_API_KEY` set, the bot makes one `search.list` call per check. At the default one-minute interval, the standard quota of 100 calls per day lasts about 100 minutes. When the quota runs out, the panel shows YouTube check errors and the bot keeps using the API. For continuous polling at the default interval, leave the key empty unless you have a higher quota. With an empty key, the bot reads the channel's `/live` page. [YouTube Data API quotas](https://developers.google.com/youtube/data/determine_quota_cost)
- `VKVIDEO_REPLAY_URL` adds a link to the channel with recordings on `vkvideo.ru`. See [What the messages look like](#what-the-messages-look-like) for when it appears.

After saving your settings, open "Status" and click "Connection check". The panel sends a test message to each configured destination and shows the results separately.

## Control panel

| Tab | What is there |
|-----|---------------|
| Status | Current stream, announcement delivery, platform status and check errors. The "open in Telegram" link appears for the current stream once its announcement has been sent to a Telegram supergroup. Buttons include "Check now", "Connection check", "Test announcement to Telegram" and "Test announcement to Discord". Each configured destination has a test announcement button |
| Message | Announcement text (like `/text`), a list of links with an "Always in announcement" option, a custom image upload, and previews of the announcement and stream summary |
| Settings | Bot settings. Secrets are masked, and leaving a secret field empty keeps its current value. Saving validates the settings and restarts the bot without repeating the announcement. "Import .env…" validates the selected file and, if it passes, replaces the entire current `.env` file |
| Log | The last 300 lines of what the bot writes |

- The panel is available only on the computer running the bot and requires no password.
- "Connection check" and both test announcement buttons send real messages even with `DRY_RUN` enabled. A test announcement goes only to the selected destination, is marked "🧪 Test", and is silent in Telegram.
- The panel stores your uploaded image in the data folder next to the database. With Telegram and `TELEGRAM_ADMIN_ID` configured, the bot also sends the image to your private chat on upload to get a `file_id`. If Telegram is configured without an admin ID, it sends the image to the group as a file. You can set the announcement text and image in the panel with any delivery destination.
- If a settings error prevents the bot from starting, the panel shows the reason. Fix it on the "Settings" tab.

### Devices and remote API

The `v0.4.0` tag includes local `/api/v1` access. The "Devices" tab, QR pairing, and remote access over Tailscale were added on the branch after that tag. A phone can connect to the API with an HTTP client. The native app is still in the planning stage. [Mobile app plan](docs/mobile-app-plan.md)

Remote API access is off by default. Connect the computer and phone to the same Tailscale network, set `REMOTE_ENABLED=true` in `.env`, and fully restart the app (choose "Quit" in the icon menu, then open it again). The desktop app reads `.env` from its data folder, and the CLI reads it from the working directory. Tailscale encrypts HTTP traffic between devices. [Tailscale encryption](https://tailscale.com/docs/concepts/tailscale-encryption)

On the "Devices" tab, click "Connect phone". The panel shows a QR code with a one-time code when the remote API is running on a verified Tailscale address. The tab also shows device names, connection dates, last use, and status. "Disconnect" revokes the device token. You can list devices and revoke access even when the bot is stopped.

[Troubleshooting and phone test](docs/development.en.md#remote-access-over-tailscale) · [API v1 specification](docs/api-v1.yaml)

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

**Announcement** in Telegram. If the announcement includes an image, the text appears as its caption.

```
Hello everyone

🔴 <stream title on the primary platform>
🎮 <game or category>

<text from /text or the panel>

▶️ Twitch
▶️ YouTube
▶️ VK Video
▶️ VK Live
```

**Stream ended** appears as a separate text message.

```
⚫️ <stream title on the primary platform>
🎮 <game or category>

Stream ended, it lasted 2 h 47 min

Thanks to everyone who dropped by the stream, you can watch the replay here:

▶️ Twitch
▶️ YouTube
▶️ VK Video
▶️ VK Live
```

- **Title and game.** Use the "Title, game and preview are taken from" field (`PRIMARY_PLATFORM`) to choose the primary platform. The default is Twitch. If the bot hasn't detected the current stream on that platform, it uses "Live stream" as the title. The game and your custom text appear when provided.
- **Image.** Both destinations use your uploaded preview when available. Otherwise Telegram uses an available preview from the primary platform, while Discord uses a platform preview only when Twitch is primary. If no suitable image is available, Telegram sends text and Discord sends a card without an image.
- **Announcement links.** The bot normally includes clickable links to the platforms that are live when it sends the announcement. If any links on the "Message" tab are marked "Always in announcement", it includes only those links, in list order. You can add platforms the bot doesn't monitor. To save the list, the marked links must fit in the space reserved in the Telegram caption (about 700 characters including markup).
- **Announcement delay.** The bot normally waits `ANNOUNCE_GRACE_MS` after detecting the first live platform (90 seconds by default). With marked links, it can send the announcement sooner, as soon as it detects the primary platform live. If that platform hasn't appeared, the usual delay applies.
- **Stream summary.** With `ANNOUNCE_END` enabled (the default), the bot sends the summary only to destinations that received the announcement. All monitored platforms must report that the stream is offline, and `OFFLINE_GRACE_MS` must have elapsed since the stream was last seen live (3 minutes by default). The summary links to the configured channels regardless of the "Always in announcement" settings.
- **VK Video.** If `VKVIDEO_REPLAY_URL` is set, the standard announcement includes that link alongside VK Live when VK Live is streaming. The summary includes the link when a VK Live channel is configured.

See the [developer guide](docs/development.en.md) for the full rules.

## Updates and data

The app checks for updates on GitHub at startup and once a day after that. If a newer version is available, the icon menu shows "Version X is available — download". Install the new version over the previous one to keep your settings and database. The icon menu and panel header show the current version.

The data lives in `~/Library/Application Support/Анонсы стримов/` on Mac and `%APPDATA%\Анонсы стримов\` on Windows: the `.env` and `bot.db` files. On Windows the data is stored separately for each user, so run the bot under a single account.

**Run the bot in only one place — on Mac or on Windows.** Two copies will send the announcement twice (to Telegram with the same token and to Discord with the same webhook), and with Telegram they will also steal each other's commands.

## For developers

Running from source, releasing a version, `.env` variables, scripts and the project structure are in [docs/development.en.md](docs/development.en.md).
