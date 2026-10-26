# Message Versions for Gemini

When you edit an earlier prompt in [Gemini](https://gemini.google.com), Gemini throws away the old path. This extension keeps it, and lets you switch between versions with Claude-style `‹ 1 / 2 ›` controls in the same chat. This extension is not made by Google and is not affiliated with Google.

## Features

- **Every version kept**: Each finished turn is saved as it appeared (tables, code and all), so an edit becomes a sibling version instead of a replacement
- **Switch in place**: `‹ n / m ›` under each edited message. Another version is shown as a read-only copy beside the live one; Gemini's own messages are never modified
- **Continue from any version**: Send a message while an older version is on screen and Gemini answers from that version, in the same chat (going forward only)
- **Nested edits**: Each version remembers its own later edits
- **Local only**: Stored on your device. Canvas content is not available in saved versions

## Installation from source

1. Open `chrome://extensions/`
2. Turn on **Developer mode**
3. Click **Load unpacked** and select this folder
4. Open [gemini.google.com](https://gemini.google.com)

## How it works

`timelines.js` saves every finished turn (Gemini's `.conversation-container`, keyed by its own id) as a node whose parent is the turn before it. An edited prompt becomes a sibling node. Showing another version hides the live turns (`data-mv-hidden`) and inserts sanitized copies in `[data-mv-run]` wrappers; showing the live version removes them again.

`bridge.js` runs in the page. It reads the reply ids (`r_…`, `rc_…`) from Gemini's responses so each saved turn knows its place in Gemini's chat. While an older version is on screen, it rewrites the next plain send so Gemini continues from that version's reply. Edits and regenerates are never rewritten.

Trees are stored in `chrome.storage.local` (`messageVersions`), keyed by Gemini chat id, 40 chats at most. A chat is only saved once it has more than one version of a message. The on/off setting is `showTimelines` in `chrome.storage.sync`.

To see what it is doing on the real site, run `localStorage.mvDebug = '1'` in the page console and reload; it logs each saved turn and each switch.

## Files

```
├── manifest.json
├── bridge.js          # Page world: reply ids, send rewrite, chat read
├── timelines.js       # Turn tree, saved copies, version controls
├── content.css
├── popup.html/.css/.js  # On/off switch
├── icons/             # logo.png and the generated icons
├── store/store-icon.png
├── test/
│   ├── mock-page.js       # Mock of Gemini's chat markup
│   └── versions.test.js
└── PRIVACY.md
```

## Permissions

- **storage**: The on/off setting and the saved versions
- **unlimitedStorage**: Saved versions keep full copies of the replies for edited chats, which can exceed Chrome's default 10 MB for extension storage
- **Site access**: Only `gemini.google.com`

## Chrome Web Store listing

**Short description** (`manifest.json`):

> Keep every version when you edit a Gemini prompt, and switch between them with < 1 / 2 > in the same chat. Not affiliated with Google.

**Single purpose**

Keeps earlier versions of a Gemini conversation when the user edits a prompt, and lets them switch between versions in the same chat.

**Permission justification (`storage`)**

Saves the on/off setting with chrome.storage.sync and keeps saved message versions in chrome.storage.local. Nothing is sent to the developer.

**Permission justification (`unlimitedStorage`)**

Saved versions include a local copy of each reply (including tables and code) for chats where the user edited a prompt. Long chats can exceed the default extension storage quota. The data stays on the device.

**Site access (`gemini.google.com`)**

The extension only runs on gemini.google.com, where it saves and shows earlier versions of the user's chats and tells Gemini which version to continue from.

**Privacy tab**

- Privacy policy: `https://github.com/SmartWorksLabs/Better-Gemini/blob/main/versions/PRIVACY.md`
- Check **Personal communications** (saved copies of the user's chats)
- Check **Website content** (reply ids in Gemini's responses)
- Leave web history, user activity, location, and PII unchecked

**Store assets**

- Store icon: `store/store-icon.png`
- Screenshots: not made yet
