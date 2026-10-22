# Better Gemini

Customize [gemini.google.com](https://gemini.google.com): hide the chat input bar until you need it, see your Current and Weekly usage limits up front, track how full this chat’s context window is, and keep **parallel message versions** when you edit an earlier prompt (Claude-style `< n / m >` in the same chat). A **Better Gemini** button on the page is where you change how that works. This extension is not made by Google and is not affiliated with Google.

Clicking the toolbar icon explains this and offers a link to Gemini. It does not change settings. Settings are on the Gemini page.

## Features

- **Hidden until you need it**: The chat bar fades and gives its space back to the conversation. It is fully invisible by default
- **Adjustable visibility**: A slider sets how visible the hidden bar is, from 0% to 100%
- **Smart reveal**: Hover or click modes, optional hide delay, drafts stay open, type-anywhere to chat
- **Usage tracker**: Two small pills show **Current** and **Weekly** usage from the same numbers as Gemini → Settings → Usage limits. Color shifts toward warning/danger as you near the limit. Click a pill to open Gemini’s usage page
- **Context window**: A quiet line under the chat bar (disclaimer-sized type) shows tokens used vs the plan limit, marked **Better Gemini** so it is clear it is not a native Gemini label. Color shifts as the window fills
- **Message versions**: When you edit an earlier prompt, keep the old path and switch with `< n / m >` in the same chat. Gemini’s own messages are never modified: each finished turn is saved as it appeared (tables, code and all), and another version is shown as a read-only copy beside the live one. Continuing from an older version rewrites the next send so Gemini parents off that tip (going forward only; stored locally on your device). Canvas content is not available in saved versions
- **Configurable**: Turn usage, context, and message versions on or off from the on-page menu
- **Stays out of the way**: Floating controls prefer sitting **beside** other chrome when there is room; if that would sit on scrolling chat text, they stack under instead

## Installation

### From source

1. Clone or download this repository
2. Open `chrome://extensions/`
3. Turn on **Developer mode**
4. Click **Load unpacked**
5. Select this folder
6. Open [gemini.google.com](https://gemini.google.com)

### Icons

There is one logo, `icons/better-gemini-logo.png`, with a transparent background. `scripts/generate_icons.py` trims its transparent border and resizes it into `icon16.png`, `icon32.png`, `icon48.png`, and `icon128.png`.

```bash
pip install Pillow
python3 scripts/generate_icons.py
```

## File structure

```
├── manifest.json      # Name, description, and permissions
├── background.js      # Saves default settings on install
├── bridge.js          # Page-world helper: usage RPC, token metadata, tip rewrite
├── popup.html         # Toolbar icon explanation
├── popup.css
├── content.js         # Chat bar, settings, usage pills, context line
├── timelines.js       # Parallel message versions (turn tree, saved copies, UI)
├── content.css        # Chat bar, context line, version controls
├── icons/
│   ├── better-gemini-logo.png
│   └── icon{16,32,48,128}.png
├── store/             # Listing images (not packaged)
│   ├── better-gemini-store-icon.png
│   └── better-gemini-screenshot-{1,2}.png
├── scripts/
│   └── generate_icons.py
├── test/
│   └── versions.test.js   # Message versions against a mock of Gemini's chat markup
├── PRIVACY.md
├── LICENSE
└── README.md
```

## How it works

### Chat bar

`content.js` finds Gemini's chat bar (`.input-area-container`), tags it with `.better-gemini-bar`, and keeps its height in `--better-gemini-bar-height`. The pull-up layout applies only when the bar is docked at the bottom of an open chat. On the new-chat screen the composer stays in Gemini's own layout.

### Usage

`bridge.js` runs in the page and calls the same Gemini usage RPC the `/usage` page uses (`jSf9Qc`), with your session. Current (period 1) and Weekly (period 2) percentages are shown as pills. Nothing is sent off your machine except that request to Google.

### Context

`bridge.js` watches Gemini’s own responses for `usageMetadata` (exact token counts). Until the first response, a light on-page estimate is shown. Limits follow Gemini Apps plan sizes (32k / 128k / 1M) and step up if counts already exceed the detected tier.

### Settings storage

Preferences are stored in `chrome.storage.sync`:

- `corner`, `hiddenOpacity`, `revealMode`, `typeToChat`, `avoidOverlap`
- `hideDelayEnabled`, `hideDelayMs`, `hideDelayUnit`, `pillStyle`
- `showUsage`, `showContext`, `showTimelines`, `firstInstalledDate`

Message-version trees are stored in `chrome.storage.local` (`betterGeminiTimelines`), keyed by Gemini chat id, and never sent to SmartWorksLabs. A chat is only saved once it has more than one version of a message.

A short usage snapshot may be cached in `chrome.storage.local` for faster display. See [PRIVACY.md](PRIVACY.md).

## Permissions

- **storage**: Save settings (and a local usage cache)
- **unlimitedStorage**: Message versions keep full copies of the replies for edited chats, which can exceed Chrome’s default 10 MB for extension storage
- **Site access**: Only `gemini.google.com`

## Development

`test/versions.test.js` runs the message-version code against a mock of Gemini’s chat markup in Chromium (Playwright):

```
NODE_PATH="$(npm root -g)" node test/versions.test.js
```

To see what the version code is doing on the real site, run `localStorage.bgDebug = '1'` in the page console and reload; it logs each saved turn and each switch.

## Browser support

- Chrome 105 and newer
- Edge 105 and newer
- Other Chromium browsers with the same extension support

## Chrome Web Store listing

**Short description** (`manifest.json`):

> Customize Gemini: hide the chat bar, track usage limits, and see context window use. Not affiliated with Google.

**Single purpose**

Customizes the Gemini web app by hiding the chat input until needed and showing the user’s usage limits and context window use on the page.

**Permission justification (`storage`)**

Saves the user’s settings with chrome.storage.sync, may cache usage percentages locally so the usage pills can appear quickly, and keeps message versions in chrome.storage.local. Nothing is sent to the developer.

**Permission justification (`unlimitedStorage`)**

Message versions store a local copy of each reply (including tables and code) for chats where the user edited a prompt. Long chats can exceed the default extension storage quota. The data stays on the device.

**Site access (`gemini.google.com`)**

The extension only runs on gemini.google.com, where it customizes the chat UI and reads Gemini’s own usage and token metadata in the page session.

**Privacy tab**

- Privacy policy: `https://github.com/SmartWorksLabs/Better-Gemini/blob/main/PRIVACY.md`
- Check **Website content** (draft detection; token metadata already in Gemini responses)
- Check **User activity** (type anywhere; usage RPC using the user’s session)
- Leave personal communications, web history, location, and PII unchecked

**Store assets**

- Store icon: `store/better-gemini-store-icon.png`
- Screenshots: `store/better-gemini-screenshot-1.png` and `-2.png`

## License

[MIT](LICENSE)
