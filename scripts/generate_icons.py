"""Generate the extension icons from the logo.

Run from the repo root: python3 scripts/generate_icons.py

icons/hide-chat-bar-for-gemini-logo.png -> icons/icon{size}.png
"""
from PIL import Image

SOURCE = 'icons/hide-chat-bar-for-gemini-logo.png'
# 16 and 32 are the toolbar sizes (32 for high-resolution screens),
# 48 is used on the extensions page, 128 in the Chrome Web Store.
SIZES = (16, 32, 48, 128)


def trim_border(image):
    """Crops away the transparent border so the logo fills the whole icon."""
    alpha = image.getchannel('A').point(lambda a: 255 if a > 8 else 0)
    left, top, right, bottom = alpha.getbbox()
    side = max(right - left, bottom - top)
    cx, cy = (left + right) / 2, (top + bottom) / 2
    box = (round(cx - side / 2), round(cy - side / 2), round(cx + side / 2), round(cy + side / 2))
    return image.crop(box)


if __name__ == '__main__':
    logo = trim_border(Image.open(SOURCE).convert('RGBA'))
    for size in SIZES:
        logo.resize((size, size), Image.LANCZOS).save(f'icons/icon{size}.png', 'PNG', optimize=True)
