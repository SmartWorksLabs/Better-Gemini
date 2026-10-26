# Privacy policy: Message Versions for Gemini

Message Versions for Gemini is an unofficial browser extension made by SmartWorksLabs. It is not made by Google and is not affiliated with Google.

This policy describes how the extension handles information. It does not send that information to SmartWorksLabs or to anyone else.

## What the extension handles

**One setting, stored in Chrome sync.** Whether message versions are on is saved with `chrome.storage.sync`. Chrome Sync may copy it to your Google account. That sync is done by Chrome, not by this extension.

**Message versions, stored only on your device.** The extension keeps alternate conversation paths in `chrome.storage.local` so you can switch between them after editing an earlier prompt. That includes saved copies of the messages and replies in those chats (with their formatting), and Gemini's ids for each reply, keyed to the Gemini chat id. A chat is only saved once it has more than one version of a message, and only the 40 most recently used chats are kept. Versions are only captured for edits that happen while the extension is on; older edits cannot be recovered.

**Gemini's responses and your next message, on the page only.** To know which reply each saved turn belongs to, the extension reads the reply ids in Gemini's own responses. When a saved version is on screen and you send a message, the extension changes which earlier reply that message continues from, so Gemini answers from the version you are looking at. Nothing else in the message is changed, and it is sent only to Gemini as usual. If a saved version is missing those ids, the extension may ask Gemini for the list of turns in the current chat, using your existing session; that request also goes only to gemini.google.com.

## What the extension does not do

It does not collect browsing history, account details, location, health information, or payment information. It does not send your chats anywhere except to Gemini, as Gemini itself would. It does not include ads. It does not sell or share information.

## How long information stays

Saved versions stay on the device until they are pushed out by newer chats, you clear the extension's data, or you uninstall it. Uninstalling removes them from that browser.

## Limited use

The use of information received from Google APIs will adhere to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use), including the Limited Use requirements.

## Changes

If the way this extension handles information changes, this policy will be updated, and the change will be explained in the extension before it takes effect.

## Contact

Questions about this policy can be sent by opening an issue on the project page: [https://github.com/SmartWorksLabs/Better-Gemini/issues](https://github.com/SmartWorksLabs/Better-Gemini/issues).
