# Hide Chat Bar for Gemini

Hides the Gemini chat input bar until you hover, click, or type. A **Chat Bar** button on the page is where you change how that works. This extension is not made by Google and is not affiliated with Google.

Clicking the toolbar icon explains this and offers a link to Gemini. It does not change settings. Settings are on the Gemini page.

## Features

- **Hidden until you need it**: The chat bar fades and gives its space back to the conversation, which runs down to just above the "Gemini is AI and can make mistakes" line. It is fully invisible by default
- **Adjustable visibility**: A slider sets how visible the hidden bar is, from 0% to 100%. At 100% the bar stays visible, but it still sits over the conversation. That slider does not restore Gemini's original layout
- **Smart reveal**: The bar appears when you hover over it or focus it, and hides when you move away
- **Hover or click**: Choose whether hovering shows the bar (the default) or only a click or tap does. In click mode, the bar stays open until you click somewhere else, so passing the pointer over it does nothing
- **Optional hide delay**: Keep the bar visible for a while after the pointer leaves. Set it with a slider or a custom amount in ms, seconds, or minutes. Off by default, so the bar hides immediately
- **Type anywhere to chat**: On by default. A letter, number, or symbol typed outside a text box is placed in the chat box. Shortcuts that use Ctrl, Cmd, or Alt, and the space bar, are left alone. Turn this off from the Chat Bar button
- **Drafts stay open**: The bar stays visible while the chat box has text
- **Matches Gemini**: The button uses Gemini's light or dark colors
- **Stays out of the way**: The button sits 12px from the chosen corner of the conversation, stays out of open sidebars, and moves beneath (or above, in the bottom corners) Gemini's buttons, text, and other extensions' widgets. That behavior can be turned off
- **Button styles**: Icon with text (the default) or a round icon button
- **Changes apply immediately**: Settings update without reloading the page

## Installation

### From source

1. Clone or download this repository
2. Open `chrome://extensions/`
3. Turn on **Developer mode**
4. Click **Load unpacked**
5. Select this folder
6. Open [gemini.google.com](https://gemini.google.com)

### Icons

There is one logo, `icons/hide-chat-bar-for-gemini-logo.png`, with a transparent background. `scripts/generate_icons.py` trims its transparent border and resizes it into `icon16.png`, `icon32.png`, `icon48.png`, and `icon128.png`. Those are the toolbar and extensions page icons, and they stay transparent.

The same script also makes `store/hide-chat-bar-for-gemini-store-icon.png`: the logo in white on a rounded blue tile, 96×96 inside a 128×128 canvas. Upload it as the **Store icon** in the developer dashboard, so the listing shows the tile while installed copies show the transparent icon. The `store/` folder is not part of the extension package.

To change the logo, replace that file with a square image and run this from the repo root. It needs [Pillow](https://pypi.org/project/Pillow/).

```bash
pip install Pillow
python3 scripts/generate_icons.py
```

## File structure

```
├── manifest.json      # Name, description, and permissions
├── background.js      # Saves default settings on install
├── popup.html         # Toolbar icon explanation
├── popup.css
├── content.js         # Chat bar behavior and the on-page button
├── content.css        # Hide and reveal styles
├── icons/
│   ├── hide-chat-bar-for-gemini-logo.png
│   └── icon{16,32,48,128}.png
├── store/
│   └── hide-chat-bar-for-gemini-store-icon.png  # Store listing icon (uploaded in the dashboard)
├── scripts/
│   └── generate_icons.py
├── PRIVACY.md
├── LICENSE
└── README.md
```

## How it works

`content.js` finds Gemini's chat bar (`.input-area-container`), tags it with `.hide-chatbar-bar`, and keeps its height in `--hide-chatbar-bar-height`. While the extension is active, the bar is pulled up by that height and faded:

```css
margin-top: calc(-1 * var(--hide-chatbar-bar-height, 0px));
opacity: var(--hide-chatbar-hidden-opacity, 0);
```

The negative margin gives the bar's space back to the conversation, so the bar floats over the bottom of the chat. Revealing it only changes the opacity. A backdrop in the page color covers the text behind it. Because the bar does not move again on hover, small pointer movements do not make it flicker.

It fades back in on:

- **Hover**: The pointer is over the bar (when **Show the chat bar on** is set to Hover)
- **Click**: The bar was clicked or tapped, until the next click outside it (when set to Click or tap). Clicks in Gemini's popups, like the upload menu, keep it open
- **Focus**: The chat box is focused
- **Draft**: The chat box has text
- **Typing**: With type anywhere on, a letter, number, or symbol typed while no text box is focused is moved into the chat box. This only targets Gemini's composer, not another text box on the page

The wait before fading out comes from **Delay before hiding**. That delay is stored in `--hide-chatbar-hide-delay`.

### The on-page button

The button is injected in a closed shadow tree so Gemini's styles do not restyle it. It:

- Uses colors that match Gemini's light and dark themes. It reads the `dark-theme` / `light-theme` class on `<body>`, and falls back to the browser color scheme
- Sits 12px from the chosen corner of the conversation. Open side panels, like the chat list or the icon rail, are tall boxes against the left or right edge, and the button stays between them
- Moves with a side panel while it slides, and also rechecks after clicks, key presses, page animations, window resizes, and every second
- With **Make room for other items** on (the default), moves straight down from a top corner, or up from a bottom corner, past anything in the way, keeping an 8px gap. Buttons, other extensions' widgets, the chat bar, and lines of text count. Large layout areas and scrolling chat content do not. If there is no free spot before the middle of the screen, it stays in the corner
- Opens a settings menu that stays inside the window
- Uses the Material Symbols [`zoom_out_map`](https://fonts.google.com/icons?selected=Material+Symbols+Outlined:zoom_out_map) icon (Outlined, weight 400; Apache License 2.0), built in as an SVG

### Settings storage

Preferences are stored in `chrome.storage.sync`, so Chrome can sync them across the user's own browsers:

- `corner`: `'top-left'`, `'top-right'`, `'bottom-left'`, or `'bottom-right'`
- `hiddenOpacity`: How visible the hidden bar is, from `0` to `100` (default `0`)
- `revealMode`: `'hover'` or `'click'`, what shows the hidden bar (default `'hover'`)
- `typeToChat`: Whether typing anywhere opens the chat box (default `true`)
- `avoidOverlap`: Whether the button moves aside for other items (default `true`)
- `hideDelayEnabled`: Whether the bar waits before hiding (default `false`)
- `hideDelayMs`: How long it waits, in milliseconds, up to one hour (default `500`)
- `hideDelayUnit`: The unit shown in the custom field: `'ms'`, `'s'`, or `'min'` (default `'ms'`)
- `pillStyle`: `'label'` (icon + text) or `'icon'` (default `'label'`)
- `firstInstalledDate`: When the extension was installed. Used only to decide when the optional review link appears

Nothing is sent to the developer. See [PRIVACY.md](PRIVACY.md).

### Review link

After 7 days, a "Leave a Review" link appears in the settings menu. It is calculated from `firstInstalledDate`. The link points at this extension's Chrome Web Store reviews page, so it only works after the extension is published. Leaving a review is optional, and the extension does not offer anything in return.

## Customization

### Fade timing

In `content.css`, the hidden state's `transition` sets how long the fade takes (`0.15s`). The wait before fading out comes from **Delay before hiding**:

```css
transition: opacity 0.15s ease var(--hide-chatbar-hide-delay, 0ms) !important;
```

### Button spacing

At the top of `content.js`:

```javascript
const EDGE_PADDING = 12; // Distance from the screen edge
const OBSTACLE_GAP = 8;  // Gap left beside other items
```

## Permissions

- **storage**: Save the user's settings in Chrome sync
- **Site access**: The extension only runs on `gemini.google.com`

## Browser support

- Chrome 105 and newer. Ignoring keys while a dialog is open uses `Element.checkVisibility()`, which Chrome added in version 105
- Edge 105 and newer
- Other Chromium browsers with the same extension support

## Chrome Web Store listing

The short description shown before someone opens the listing is the `description` field in `manifest.json`:

> Hides the Gemini chat bar until you hover, click, or type. Not affiliated with Google.

Paste the rest of this into the dashboard.

**Single purpose**

Hides the Gemini chat input bar until the user hovers, clicks, or types, and provides on-page controls for that behavior.

**Detailed description**

Hide Chat Bar for Gemini hides the chat input bar on gemini.google.com until you need it. The bar fades and gives its space to the conversation. It comes back when you hover or click it, while a draft is in the box, or when you type a letter anywhere on the page.

Type anywhere to chat is on by default. Turn it off from the Chat Bar button on the page. That menu also sets whether hovering or clicking shows the bar, how visible the hidden bar is, how long the bar waits before hiding, where the button sits, and whether the button moves aside for other items.

This extension is not made by Google and is not affiliated with Google. Settings stay in your browser. The privacy policy describes what is stored and what is only used on the page.

**Permission justification (`storage`)**

Saves the user's settings (button position, hidden-bar visibility, hover or click to show, type anywhere to chat, hide delay, and button style) with chrome.storage.sync so they follow the user across their own Chrome browsers. Also stores the install date so an optional review link can appear after 7 days. Nothing is sent to the developer.

**Site access (`gemini.google.com`)**

The extension only runs on gemini.google.com, where it hides the chat bar and shows the settings button.

**Privacy tab**

- Privacy policy: `https://github.com/SmartWorksLabs/Hide-Chat-Bar-for-Gemini/blob/main/PRIVACY.md` once this file is on the main branch
- Check **Website content**. On Gemini, the extension checks whether the chat box has text so the bar can stay open during a draft. The text is not stored or sent to the developer
- Check **User activity**. When type anywhere is on, a typed character is placed into the chat box. It is not stored or sent to the developer
- Leave personal communications, web history, location, and personally identifiable information unchecked
- Certify the limited-use statements. The required sentence is in [PRIVACY.md](PRIVACY.md)

**Still required in the dashboard, outside this repo**

- The store icon: upload `store/hide-chat-bar-for-gemini-store-icon.png`
- At least one screenshot at 1280×800 or 640×400, with no transparency, taken on Gemini
- The developer account registration, 2-Step Verification, and a contact email that can receive store mail

## License

[MIT](LICENSE)
