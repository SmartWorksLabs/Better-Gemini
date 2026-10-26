# Hide Chat Bar for Gemini

Hides [Gemini](https://gemini.google.com)'s chat input bar until you need it, and gives its space back to the conversation. A **Hide Chat Bar** button on the page is where you change how that works. This extension is not made by Google and is not affiliated with Google.

For usage limits and message versions, see the companion extensions [Usage Tracker for Gemini](../usage/) and [Message Versions for Gemini](../versions/).

## Features

- **Hidden until you need it**: The chat bar fades and gives its space back to the conversation. It is fully invisible by default. The new-chat screen is left as is
- **Adjustable visibility**: A slider sets how visible the hidden bar is, from 0% to 100%
- **Smart reveal**: Hover or click modes, an optional hide delay, drafts keep the bar open, and type-anywhere to chat
- **Stays out of the way**: The settings button prefers sitting beside other buttons when there is room; if that would cover chat text, it stacks under them instead

## Installation from source

1. Open `chrome://extensions/`
2. Turn on **Developer mode**
3. Click **Load unpacked** and select this folder
4. Open [gemini.google.com](https://gemini.google.com)

## How it works

`content.js` finds Gemini's chat bar (`.input-area-container`), tags it with `.hcb-bar`, and keeps its height in `--hcb-bar-height`. The pull-up layout (`hcb-docked` on `<body>`) applies only when the bar is docked at the bottom of an open chat. Everything (hiding, the settings button, type anywhere) is on only inside a chat, an address with a chat id. The new-chat screen and other pages are left exactly as Gemini shows them.

Settings are stored in `chrome.storage.sync`: `corner`, `hiddenOpacity`, `revealMode`, `typeToChat`, `avoidOverlap`, `hideDelayEnabled`, `hideDelayMs`, `hideDelayUnit`, `pillStyle`, `firstInstalledDate`.

## Files

```
├── manifest.json
├── background.js      # Default settings on install
├── content.js         # Chat bar, settings button and menu, type anywhere
├── content.css        # Hidden and revealed bar
├── popup.html/.css    # Toolbar icon explanation
├── icons/             # logo.png and the generated icon{16,32,48,128}.png
├── store/             # Listing images (not packaged)
├── test/bar.test.js
└── PRIVACY.md
```

## Permissions

- **storage**: Save settings
- **Site access**: Only `gemini.google.com`

## Chrome Web Store listing

**Short description** (`manifest.json`):

> Hide Gemini's chat bar until you need it. Hover or click to reveal, or just start typing. Not affiliated with Google.

**Single purpose**

Hides the Gemini chat input bar until the user needs it, so more of the conversation is visible.

**Permission justification (`storage`)**

Saves the user's settings (button position, reveal mode, hidden-bar visibility, hide delay) with chrome.storage.sync. Nothing is sent to the developer.

**Site access (`gemini.google.com`)**

The extension only runs on gemini.google.com, where it hides and reveals the chat bar.

**Privacy tab**

- Privacy policy: `https://github.com/SmartWorksLabs/Better-Gemini/blob/main/hide-chat-bar/PRIVACY.md`
- Check **Website content** (draft detection, so the bar stays open while you write)
- Check **User activity** (type anywhere: keys typed outside a text box go into the chat box)
- Leave personal communications, web history, location, and PII unchecked

**Store assets**

- Store icon: `store/store-icon.png`
- Screenshots: `store/screenshot-1.png` and `store/screenshot-2.png` (screenshot 2 shows an older settings menu)
