# Usage Tracker for Gemini

Shows your [Gemini](https://gemini.google.com) **Current** and **Weekly** usage limits, and how full this chat's **context window** is, in a quiet line under the chat bar. This extension is not made by Google and is not affiliated with Google.

## Features

- **Usage limits**: Current and Weekly usage, from the same numbers as Gemini → Settings → Usage limits, with reset times. The colour shifts toward warning and danger as you near a limit. Click to open Gemini's usage page
- **Context window**: Tokens used in this chat against your plan's limit (32k / 128k / 1M). The colour shifts as the window fills
- **Settings**: Turn each part on or off from the toolbar icon

## Installation from source

1. Open `chrome://extensions/`
2. Turn on **Developer mode**
3. Click **Load unpacked** and select this folder
4. Open [gemini.google.com](https://gemini.google.com)

## How it works

### Usage

`bridge.js` runs in the page and calls the same Gemini usage RPC the `/usage` page uses (`jSf9Qc`), with your session. Current (period 1) and Weekly (period 2) percentages are shown under the right edge of the chat bar. Nothing is sent anywhere except that request to Google.

### Context

`bridge.js` reads Gemini's own responses for `usageMetadata` (exact token counts) without changing any request. Until the first response, `usage.js` shows an estimate from the visible chat text. Limits follow Gemini Apps plan sizes and step up if counts already exceed the detected tier. The plan comes from the usage RPC or Gemini's Usage limits page.

### Placement

`usage.js` finds Gemini's chat bar on its own and places `#gemini-usage-footer` to match the bar's width, centred on Gemini's "can make mistakes" line when it is there. It follows the bar for a moment after clicks, key presses, and transitions, so it stays in place when [Hide Chat Bar for Gemini](../hide-chat-bar/) slides the bar.

### Storage

- `chrome.storage.sync`: `showUsage`, `showContext`
- `chrome.storage.local`: `usageSnapshot` (latest percentages), `planTier`, `contextByChat` (latest count per chat, 40 most recent)

## Files

```
├── manifest.json
├── bridge.js          # Page world: usage RPC, plan, token counts from Gemini's responses
├── usage.js           # Usage pills and context line under the chat bar
├── content.css
├── popup.html/.css/.js  # On/off switches
├── icons/             # logo.png (placeholder) and the generated icons
├── store/store-icon.png
├── test/usage.test.js
└── PRIVACY.md
```

## Permissions

- **storage**: Settings and the local usage, plan, and context cache
- **Site access**: Only `gemini.google.com`

## Chrome Web Store listing

**Short description** (`manifest.json`):

> See your Gemini Current and Weekly usage limits and how full this chat's context window is, right under the chat bar. Not affiliated with Google.

**Single purpose**

Shows the user's Gemini usage limits and context window use on the Gemini page.

**Permission justification (`storage`)**

Saves two on/off settings with chrome.storage.sync, and caches the latest usage percentages, plan, and per-chat token counts in chrome.storage.local so they appear quickly. Nothing is sent to the developer.

**Site access (`gemini.google.com`)**

The extension only runs on gemini.google.com, where it reads Gemini's own usage limits and token counts in the user's session.

**Privacy tab**

- Privacy policy: `https://github.com/SmartWorksLabs/Better-Gemini/blob/main/usage/PRIVACY.md`
- Check **Website content** (token counts in Gemini's responses; visible chat text for the estimate)
- Leave personal communications, web history, user activity, location, and PII unchecked

**Store assets**

- Store icon: `store/store-icon.png`
- Screenshots: not made yet
