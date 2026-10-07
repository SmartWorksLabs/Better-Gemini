# Hide Chat Bar for Gemini

A Manifest V3 Chrome Extension that natively hides and reveals the Gemini chat input bar with a smooth Material 3 experience.

## Features

- **Always Hidden**: The chat input bar fades out in place, and the conversation uses its space, running down to just above the "Gemini is AI and can make mistakes" line. It is fully invisible by default
- **Adjustable Visibility**: A slider sets how visible the hidden bar is, from 0% to 100%
- **Smart Reveal**: Bar appears the moment you hover or focus it, and hides as soon as you move away
- **Optional Hide Delay**: Keep the bar visible for a while after the mouse leaves, set with a slider or a custom amount in ms, seconds or minutes (off by default)
- **Type Anywhere to Chat**: Start typing anywhere on the page and the bar opens with your text already in it
- **Content Protection**: Bar stays visible when you're typing
- **Material 3 Design**: Matches Gemini's native styling using its CSS variables
- **Corner Pill That Makes Room**: The settings pill sits 12px from the chosen corner of the conversation area, stays out of open sidebars, and moves beneath (or above, in the bottom corners) Gemini's buttons, text and other extensions' widgets (can be turned off)
- **Pill Styles and Themes**: Choose icon with text (default) or a round icon button. It follows Gemini's light or dark theme
- **Shadow DOM Isolation**: UI won't break from Gemini's CSS updates
- **Instant Reactivity**: Settings changes apply immediately without page reload
- **Light and Dark Toolbar Icons**: The toolbar icon switches to match Chrome's light or dark mode

## Installation

### From Source (Developer Mode)

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the extension folder
6. Navigate to [gemini.google.com](https://gemini.google.com) to see it in action

### Icons

The icons in `/icons` are resized from two full-size logos by `scripts/generate_icons.py`:
- `icons/logo-source.png` (light mode) becomes `icon16.png`, `icon32.png`, `icon48.png` and `icon128.png`. These are the default icons, used on the extensions page and in the Chrome Web Store.
- `icons/logo-source-dark.png` (dark mode) becomes `icon16-dark.png`, `icon32-dark.png`, `icon48-dark.png` and `icon128-dark.png`.

To change a logo, replace its source file with a square image and regenerate the icons (requires [Pillow](https://pypi.org/project/Pillow/)) from the repo root:

```bash
pip install Pillow
python3 scripts/generate_icons.py
```

## File Structure

```
├── manifest.json      # Extension manifest (Manifest V3)
├── background.js      # Service worker for lifecycle events
├── content.js         # Main logic, pill UI, state management
├── content.css        # Hide/reveal animations and states
├── icons/             # Extension icons
│   ├── logo-source.png       # Full-size light mode logo
│   ├── logo-source-dark.png  # Full-size dark mode logo
│   ├── icon{16,32,48,128}.png       # Light mode icons (the default)
│   └── icon{16,32,48,128}-dark.png  # Dark mode toolbar icons
├── scripts/
│   └── generate_icons.py  # Resizes the logo into the icons
└── README.md
```

## How It Works

### Hide/Reveal Mechanism

`content.js` finds Gemini's chat bar (`.input-area-container`), tags it with `.hide-chatbar-bar`, and keeps its height in the `--hide-chatbar-bar-height` CSS variable. While hidden, the bar fades out without moving:

```css
margin-top: calc(-1 * var(--hide-chatbar-bar-height, 0px));
opacity: var(--hide-chatbar-hidden-opacity, 0); /* set by the visibility slider */
```

The negative margin gives the bar's space back to the conversation, so the bar floats over the bottom of the chat instead of reserving a blank area. When it's revealed, a backdrop in the page colour covers the text behind it.

Because the bar never moves, it reacts to the mouse over its whole normal area, and small mouse movements can't make it flicker. It hides as soon as the mouse leaves, unless **Delay before hiding** is turned on. That delay is stored in the `--hide-chatbar-hide-delay` CSS variable. The bar quickly fades in on:
- **Hover**: Moving your mouse over where the bar normally sits
- **Focus**: Clicking into the input area
- **Content**: When there's text in the draft (prevents hiding mid-message)
- **Typing**: Pressing a letter, number or symbol key while no text box is focused moves the key into the chat box. Shortcuts that use Ctrl, Cmd or Alt, the space bar, and keys pressed while a dialog or menu is open are left alone

### The Pill UI

A floating pill widget is injected using a **closed Shadow DOM** for style isolation. It:
- Uses Gemini's native CSS variables for colors
- Sits 12px from the chosen corner of the conversation area. Open side panels, like Gemini's chat list or its icon rail, are tall boxes against the left or right edge of the window, and the pill stays between them
- Moves in step with a side panel while it slides open or shut, because it re-checks its spot whenever a panel changes size. It also re-checks after clicks, key presses, page animations, window resizes and every second
- With **Make room for other items** on (the default), it moves straight down from a top corner (or up from a bottom corner) past anything in the way, keeping an 8px gap, so it never spreads sideways into the conversation. Buttons, other extensions' widgets, the chat bar (even while hidden) and lines of text all count. Big layout areas such as side rails and top bars don't, and neither does scrolling chat content. If there's no free spot before the middle of the screen, it falls back to the corner
- Opens a settings menu on click, sized to fit the window and kept inside the conversation area
- Shows the Material Symbols [`zoom_out_map`](https://fonts.google.com/icons?selected=Material+Symbols+Outlined:zoom_out_map) icon (Outlined, weight 400; Apache License 2.0). It is built in as an SVG instead of loaded from Google Fonts, because web fonts don't load inside a shadow root and this avoids a network request
- Uses Material 3 light or dark colours to match Gemini. It reads Gemini's own theme from the `dark-theme` / `light-theme` class on `<body>`, and falls back to `prefers-color-scheme`

### Settings Storage

User preferences are stored in `chrome.storage.sync` (synced across the user's browsers):
- `corner`: Pill position (`'top-left'`, `'top-right'`, `'bottom-left'`, `'bottom-right'`)
- `hiddenOpacity`: How visible the hidden bar is, from `0` to `100` (default `0`)
- `typeToChat`: Whether typing anywhere opens the chat bar (default `true`)
- `avoidOverlap`: Whether the pill moves aside for other items (default `true`)
- `hideDelayEnabled`: Whether the bar waits before hiding (default `false`)
- `hideDelayMs`: How long it waits, in milliseconds, up to one hour (default `500`)
- `hideDelayUnit`: The unit shown in the custom field: `'ms'`, `'s'` or `'min'` (default `'ms'`)
- `pillStyle`: `'label'` (icon + text) or `'icon'` (default `'label'`)
- `firstInstalledDate`: Timestamp of first install

The reveal counter is stored in `chrome.storage.local`, because it changes often and `sync` storage has strict write limits:
- `interactionsCount`: Number of times the bar was revealed (for analytics/review prompts)

### 7-Day Review Hook

After 7 days of use, a "Leave a Review" link appears in the settings menu. This is calculated from `firstInstalledDate`. The link points to the extension's own Chrome Web Store reviews page, so it only works once the extension is published there.

### Light and Dark Toolbar Icons

Chrome's manifest has no setting for theme-based icons (Firefox's `theme_icons` key isn't supported), so the icon is swapped in code:
1. The content script checks `window.matchMedia('(prefers-color-scheme: dark)')` and watches it for changes. This follows Chrome's light/dark mode, or the system setting when Chrome is set to "Device".
2. It sends the result to `background.js`, which calls `chrome.action.setIcon` with the light or dark icons. The background service worker can't check the theme itself, because it has no page to run `matchMedia` in.
3. The last theme is saved in `chrome.storage.local`, so the right icon is restored when Chrome restarts.

Because the theme is checked from Gemini tabs, a theme change is picked up the next time a Gemini tab is open.

Only the toolbar icon can switch. The `chrome://extensions` page and the Chrome Web Store always show the `icons` from `manifest.json` (the light set), and Chrome has no way for an extension to change those while it runs.

## Customization

### Adjust the Fade Timing

In `content.css`, the hidden state's `transition` sets how long the fade takes (`0.15s`). The wait before fading out comes from the **Delay before hiding** setting:

```css
transition: opacity 0.15s ease var(--hide-chatbar-hide-delay, 0ms) !important;
```

### Adjust the Pill Spacing

At the top of `content.js`, change these values:

```javascript
const EDGE_PADDING = 12; // Distance from the screen edge
const OBSTACLE_GAP = 8;  // Gap left beside other items
```

## Permissions

This extension requests minimal permissions:
- **storage**: Save user preferences
- **Site access**: The content script only runs on `gemini.google.com`

## Browser Compatibility

- Chrome 105+ (the hide/reveal styles use the CSS `:has()` selector)
- Edge 105+ (Chromium-based)
- Other Chromium browsers with MV3 support

## License

MIT License - Feel free to modify and distribute.
