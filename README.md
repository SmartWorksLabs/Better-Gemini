# Hide Chat Bar for Gemini

A Manifest V3 Chrome Extension that natively hides and reveals the Gemini chat input bar with a smooth Material 3 experience.

## Features

- **Auto-Hide**: The chat input bar fades out in place, and the conversation uses its space, running down to just above the "Gemini is AI and can make mistakes" line. It is fully invisible by default
- **Adjustable Visibility**: A slider sets how visible the hidden bar is, from 0% to 100%
- **Smart Reveal**: Bar appears on hover or when focused
- **Type Anywhere to Chat**: Start typing anywhere on the page and the bar opens with your text already in it
- **Content Protection**: Bar stays visible when you're typing
- **Material 3 Design**: Matches Gemini's native styling using its CSS variables
- **Corner Pill That Makes Room**: The settings pill sits 12px from the chosen corner, adapts to the window size, and moves aside for Gemini's buttons and other extensions' widgets (can be turned off)
- **Shadow DOM Isolation**: UI won't break from Gemini's CSS updates
- **Instant Reactivity**: Settings changes apply immediately without page reload

## Installation

### From Source (Developer Mode)

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the extension folder
6. Navigate to [gemini.google.com](https://gemini.google.com) to see it in action

### Icons

The icons in `/icons` are resized from the full-size logo, `icons/logo-source.png`, by `scripts/generate_icons.py`. To change the logo, replace `logo-source.png` with a square image and regenerate the icons (requires [Pillow](https://pypi.org/project/Pillow/)) from the repo root:

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
│   ├── logo-source.png    # Full-size logo the icons are made from
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
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

Because the bar never moves, it reacts to the mouse over its whole normal area, and small mouse movements can't make it flicker. It also waits 0.4 seconds before fading out, so a brief slip off the bar doesn't hide it. The bar smoothly fades in on:
- **Hover**: Moving your mouse over where the bar normally sits
- **Focus**: Clicking into the input area
- **Content**: When there's text in the draft (prevents hiding mid-message)
- **Typing**: Pressing a letter, number or symbol key while no text box is focused moves the key into the chat box. Shortcuts that use Ctrl, Cmd or Alt, the space bar, and keys pressed while a dialog or menu is open are left alone

### The Pill UI

A floating pill widget is injected using a **closed Shadow DOM** for style isolation. It:
- Uses Gemini's native CSS variables for colors
- Sits 12px from the chosen corner and re-checks its spot when the window is resized and every 2 seconds
- With **Make room for other items** on (the default), it slides along the edge, away from the corner, until it finds a free spot with an 8px gap. Big layout areas such as side rails and top bars don't count as being in the way, and neither does scrolling chat content. If there's no free spot before the middle of the screen, it tries going down (or up) instead, then falls back to the exact corner
- Opens a settings menu on click, sized to fit the window

### Settings Storage

User preferences are stored in `chrome.storage.sync` (synced across the user's browsers):
- `corner`: Pill position (`'top-left'`, `'top-right'`, `'bottom-left'`, `'bottom-right'`)
- `autoHide`: Whether auto-hide is enabled
- `hiddenOpacity`: How visible the hidden bar is, from `0` to `100` (default `0`)
- `typeToChat`: Whether typing anywhere opens the chat bar (default `true`)
- `avoidOverlap`: Whether the pill moves aside for other items (default `true`)
- `firstInstalledDate`: Timestamp of first install

The reveal counter is stored in `chrome.storage.local`, because it changes often and `sync` storage has strict write limits:
- `interactionsCount`: Number of times the bar was revealed (for analytics/review prompts)

### 7-Day Review Hook

After 7 days of use, a "Leave a Review" link appears in the settings menu. This is calculated from `firstInstalledDate`. The link points to the extension's own Chrome Web Store reviews page, so it only works once the extension is published there.

## Customization

### Adjust the Fade Timing

In `content.css`, the hidden state's `transition` sets how long the bar waits before fading out (`0.4s`) and how long the fade takes (`0.3s`):

```css
transition: opacity 0.3s ease 0.4s !important;
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
