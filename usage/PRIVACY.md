# Privacy policy: Usage Tracker for Gemini

Usage Tracker for Gemini is an unofficial browser extension made by SmartWorksLabs. It is not made by Google and is not affiliated with Google.

This policy describes how the extension handles information. It does not send that information to SmartWorksLabs or to anyone else.

## What the extension handles

**Settings, stored in Chrome sync.** The extension saves two choices with `chrome.storage.sync`: whether the usage limits are shown, and whether the context window is shown. Chrome Sync may copy these settings to your Google account. That sync is done by Chrome, not by this extension.

**Usage limits, stored only on your device.** When usage limits are shown, the extension asks Gemini for the same Current and Weekly percentages shown under Settings → Usage limits, using your existing Gemini session in the browser. To find your plan (which sets the context window size), it may also load Gemini's own Usage limits page. Both requests go only to gemini.google.com. The latest percentages, reset times, and plan name are cached in `chrome.storage.local` so they can appear quickly on the next visit.

**Context window counts, stored only on your device.** When the context window is shown, the extension reads the token counts Gemini already returns in its own responses (`usageMetadata`), and estimates from the visible chat text until the first exact count arrives. It reads those responses without changing them. The latest count for each chat, keyed by Gemini's chat id, is saved in `chrome.storage.local` so it is still there when you come back to that chat. Only the 40 most recently used chats are kept. The chat text itself is not saved.

## What the extension does not do

It does not collect browsing history, account details, location, health information, or payment information. It does not save or send your messages. It does not include ads. It does not sell or share information.

## How long information stays

Settings stay in Chrome until you change them, clear the extension's data, or uninstall it. The usage cache is overwritten on each refresh. Context counts stay until they are pushed out by newer chats, you clear the extension's data, or you uninstall it.

## Limited use

The use of information received from Google APIs will adhere to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use), including the Limited Use requirements.

## Changes

If the way this extension handles information changes, this policy will be updated, and the change will be explained in the extension before it takes effect.

## Contact

Questions about this policy can be sent by opening an issue on the project page: [https://github.com/SmartWorksLabs/Better-Gemini/issues](https://github.com/SmartWorksLabs/Better-Gemini/issues).
