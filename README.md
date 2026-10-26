# Gemini extensions by SmartWorksLabs

Three separate Chrome extensions for [gemini.google.com](https://gemini.google.com). Each folder is a complete extension with its own manifest, store listing, and privacy policy. They work on their own or together. None of them is made by Google or affiliated with Google.

| Folder | Extension | What it does |
|---|---|---|
| [hide-chat-bar/](hide-chat-bar/) | **Hide Chat Bar for Gemini** | Hides the chat bar until you hover, click, or start typing. This is the original listing (it was called Better Gemini in 1.1–1.3). |
| [usage/](usage/) | **Usage Tracker for Gemini** | Current and Weekly usage limits, and how full this chat's context window is, under the chat bar. |
| [versions/](versions/) | **Message Versions for Gemini** | Keeps every version when you edit a prompt, with Claude-style `‹ 1 / 2 ›` switching in the same chat. |

## Working on them

Load a folder in Chrome with `chrome://extensions` → **Developer mode** → **Load unpacked**. You can load all three at once.

Chrome only packages files inside an extension's own folder, so nothing is shared between folders at runtime. A few small pieces exist in more than one place on purpose. When Gemini changes, check each copy:

| Code | Where |
|---|---|
| Finding Gemini's chat box and chat bar (`findChatEditor`, `findBar`) | `hide-chat-bar/content.js`, `usage/usage.js` |
| Gemini's light/dark theme (`isGeminiDark`) | `hide-chat-bar/content.js`, `usage/usage.js` |
| Session token, `batchexecute` decoding, chat id from the address | `usage/bridge.js`, `versions/bridge.js` |
| Base popup styles | `*/popup.css` |

Each extension uses its own names on the page so they never clash: `hcb-` for Hide Chat Bar, `gemini-usage-` / `gu-` for Usage Tracker, and `mv-` / `data-mv-` for Message Versions. The two page-world bridges talk on separate channels (`gemini-usage-bridge`, `message-versions-bridge`).

## Tests

The tests drive each extension in Chromium against a mock of Gemini's page, using [Playwright](https://playwright.dev):

```bash
npm install -g playwright && npx playwright install chromium
NODE_PATH="$(npm root -g)" node hide-chat-bar/test/bar.test.js
NODE_PATH="$(npm root -g)" node usage/test/usage.test.js
NODE_PATH="$(npm root -g)" node versions/test/versions.test.js
```

## Icons

Each extension has one logo, `<folder>/icons/logo.png`, with a transparent background. This makes the toolbar icons and the store icon from it:

```bash
pip install Pillow
python3 scripts/generate_icons.py hide-chat-bar   # or usage, versions
```

The Usage Tracker and Message Versions logos are simple placeholders.

## Packaging for the Chrome Web Store

```bash
scripts/package.sh            # all three
scripts/package.sh usage      # just one
```

This writes `dist/<folder>-<version>.zip` with only the files the extension needs (no tests, store images, or docs).

## License

[MIT](LICENSE)
