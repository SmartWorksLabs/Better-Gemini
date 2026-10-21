# Better Gemini

Customize [gemini.google.com](https://gemini.google.com): hide the chat input bar until you need it, see your Current and Weekly usage limits up front, and track how full this chat’s context window is. A **Better Gemini** button on the page is where you change how that works. This extension is not made by Google and is not affiliated with Google.

Clicking the toolbar icon explains this and offers a link to Gemini. It does not change settings. Settings are on the Gemini page.

## Features

- **Hidden until you need it**: The chat bar fades and gives its space back to the conversation. It is fully invisible by default
- **Adjustable visibility**: A slider sets how visible the hidden bar is, from 0% to 100%
- **Smart reveal**: Hover or click modes, optional hide delay, drafts stay open, type-anywhere to chat
- **Usage tracker**: Two small pills show **Current** and **Weekly** usage from the same numbers as Gemini → Settings → Usage limits. Color shifts toward warning/danger as you near the limit. Click a pill to open Gemini’s usage page
- **Context window**: A quiet line under the chat bar (disclaimer-sized type) shows tokens used vs the plan limit, marked **Better Gemini** so it is clear it is not a native Gemini label. Color shifts as the window fills
- **Configurable**: Turn usage and/or context on or off from the on-page menu
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

There is one logo, `icons/hide-chat-bar-for-gemini-logo.png`, with a transparent background. `scripts/generate_icons.py` trims its transparent border and resizes it into `icon16.png`, `icon32.png`, `icon48.png`, and `icon128.png`.

```bash
pip install Pillow
python3 scripts/generate_icons.py
```

## File structure

```
├── manifest.json      # Name, description, and permissions
├── background.js      # Saves default settings on install
├── bridge.js          # Page-world helper: usage RPC + token metadata
├── popup.html         # Toolbar icon explanation
├── popup.css
├── content.js         # Chat bar, settings, usage pills, context line
├── content.css        # Hide/reveal styles and context line
├── icons/
├── store/             # Listing images (not packaged)
├── scripts/
├── PRIVACY.md
├── LICENSE
└── README.md
```

## How it works

### Chat bar

`content.js` finds Gemini's chat bar (`.input-area-container`), tags it with `.hide-chatbar-bar`, and keeps its height in `--hide-chatbar-bar-height`. The pull-up layout applies only when the bar is docked at the bottom of an open chat. On the new-chat screen the composer stays in Gemini's own layout.

### Usage

`bridge.js` runs in the page and calls the same Gemini usage RPC the `/usage` page uses (`jSf9Qc`), with your session. Current (period 1) and Weekly (period 2) percentages are shown as pills. Nothing is sent off your machine except that request to Google.

### Context

`bridge.js` watches Gemini’s own responses for `usageMetadata` (exact token counts). Until the first response, a light on-page estimate is shown. Limits follow Gemini Apps plan sizes (32k / 128k / 1M) and step up if counts already exceed the detected tier.

### Settings storage

Preferences are stored in `chrome.storage.sync`:

- `corner`, `usageCorner`, `hiddenOpacity`, `revealMode`, `typeToChat`, `avoidOverlap`
- `hideDelayEnabled`, `hideDelayMs`, `hideDelayUnit`, `pillStyle`
- `showUsage`, `showContext`, `firstInstalledDate`

A short usage snapshot may be cached in `chrome.storage.local` for faster display. See [PRIVACY.md](PRIVACY.md).

## Permissions

- **storage**: Save settings (and a local usage cache)
- **Site access**: Only `gemini.google.com`

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

Saves the user’s settings with chrome.storage.sync, and may cache usage percentages locally so the usage pills can appear quickly. Nothing is sent to the developer.

**Site access (`gemini.google.com`)**

The extension only runs on gemini.google.com, where it customizes the chat UI and reads Gemini’s own usage and token metadata in the page session.

**Privacy tab**

- Privacy policy: `https://github.com/SmartWorksLabs/Hide-Chat-Bar-for-Gemini/blob/main/PRIVACY.md`
- Check **Website content** (draft detection; token metadata already in Gemini responses)
- Check **User activity** (type anywhere; usage RPC using the user’s session)
- Leave personal communications, web history, location, and PII unchecked

## License

[MIT](LICENSE)
