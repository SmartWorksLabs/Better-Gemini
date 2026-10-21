# Privacy policy

Better Gemini is an unofficial browser extension made by SmartWorksLabs. It is not made by Google and is not affiliated with Google.

This policy describes how the extension handles information. It does not send that information to SmartWorksLabs or to anyone else.

## What the extension handles

**Settings, stored in Chrome sync.** The extension saves your choices with `chrome.storage.sync`: where the settings and usage buttons sit, how visible the hidden chat bar is, whether the bar appears on hover or on click, whether typing anywhere opens the chat box, whether buttons move aside for other items, the hide delay, the button style, whether the usage tracker and context window are shown, and the date you installed it. The install date is only used to show an optional review link after 7 days. Chrome Sync may copy these settings to your Google account so they follow you to your other browsers. That sync is done by Chrome, not by this extension. SmartWorksLabs never receives these settings.

**Usage limits, stored only on your device.** When the usage tracker is on, the extension asks Gemini for the same Current and Weekly percentages shown under Settings → Usage limits, using your existing Gemini session in the browser. Those percentages (and reset times) may be cached briefly in `chrome.storage.local` so the pills can appear quickly on the next visit. They are not sent to SmartWorksLabs.

**Context window counts, used only on the page.** When the context window display is on, the extension reads token counts that Gemini already returns in its own responses (`usageMetadata`), and may estimate from visible text until the first exact count arrives. Counts are kept in memory for the current chat only. They are not saved to sync storage and are not sent to SmartWorksLabs.

**Text in the Gemini chat box, used only on the page.** On gemini.google.com, the extension checks whether the chat box has any text, so the bar can stay open while you are writing. It does not read your existing conversation for any other purpose, it does not save the draft, and it does not send the draft anywhere.

**Keys you type and text you paste, used only on the page.** Type anywhere to chat is on by default. When it is on, a letter, number, or symbol you type outside a text box is placed into the Gemini chat box. Pasting outside a text box does the same with the pasted text. Shortcuts that use Ctrl, Cmd, or Alt, and the space bar, are left alone. The key or pasted text is not saved and is not sent anywhere. You can turn this off from the Better Gemini button on the page.

## What the extension does not do

It does not collect browsing history, account details, location, health information, or payment information. It does not include ads. It does not sell or share information. It does not keep a count of how you use it beyond the local usage cache described above.

The review link opens this extension's page on the Chrome Web Store. Leaving a review is optional, and the extension does not know whether you do.

## How long information stays

Settings stay in Chrome until you change them, clear the extension's data, or uninstall it. The local usage cache is overwritten on each refresh and is removed when you clear the extension's data or uninstall. Uninstalling removes the extension's stored settings from that browser.

## Limited use

The use of information received from Google APIs will adhere to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use), including the Limited Use requirements.

## Changes

If the way this extension handles information changes, this policy will be updated, and the change will be explained in the extension before it takes effect.

## Contact

Questions about this policy can be sent by opening an issue on the project page: [https://github.com/SmartWorksLabs/Better-Gemini/issues](https://github.com/SmartWorksLabs/Better-Gemini/issues).
