"""Generate the extension icons and the Chrome Web Store icon from the logo.

Run from the repo root: python3 scripts/generate_icons.py

icons/better-gemini-logo.png -> icons/icon{size}.png
                             -> store/better-gemini-store-icon.png
"""
from PIL import Image, ImageDraw

SOURCE = 'icons/better-gemini-logo.png'
# 16 and 32 are the toolbar sizes (32 for high-resolution screens),
# 48 is used on the extensions page, 128 in the Chrome Web Store.
SIZES = (16, 32, 48, 128)

# The store listing icon is uploaded separately in the developer dashboard, so
# it can sit on a rounded tile while the installed icons stay transparent.
# Google's guidelines: 128x128 canvas, 96x96 artwork, 16px transparent padding.
STORE_ICON = 'store/better-gemini-store-icon.png'
STORE_SIZE = 128
STORE_TILE = 96
STORE_RADIUS = 22
STORE_TILE_COLOR = (30, 144, 255, 255)
STORE_GLYPH_COLOR = (255, 255, 255)
STORE_GLYPH_WIDTH = 0.74
SUPERSAMPLE = 4


def trim_border(image):
    """Crops away the transparent border so the logo fills the whole icon."""
    alpha = image.getchannel('A').point(lambda a: 255 if a > 8 else 0)
    left, top, right, bottom = alpha.getbbox()
    side = max(right - left, bottom - top)
    cx, cy = (left + right) / 2, (top + bottom) / 2
    box = (round(cx - side / 2), round(cy - side / 2), round(cx + side / 2), round(cy + side / 2))
    return image.crop(box)


def clear_faint_pixels(image):
    """Resizing leaves near-invisible specks around shapes; make them fully transparent."""
    alpha = image.getchannel('A').point(lambda a: 0 if a <= 8 else a)
    image.putalpha(alpha)
    return image


def store_icon(source):
    """The logo in white on a rounded tile, drawn large and scaled down for smooth edges."""
    glyph = source.crop(source.getchannel('A').getbbox())
    size = STORE_SIZE * SUPERSAMPLE
    pad = (STORE_SIZE - STORE_TILE) // 2 * SUPERSAMPLE
    tile_end = size - pad - 1

    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).rounded_rectangle(
        [pad, pad, tile_end, tile_end], radius=STORE_RADIUS * SUPERSAMPLE, fill=STORE_TILE_COLOR
    )

    width = int(STORE_TILE * STORE_GLYPH_WIDTH * SUPERSAMPLE)
    height = round(width * glyph.height / glyph.width)
    glyph = glyph.resize((width, height), Image.LANCZOS)
    channels = [Image.new('L', glyph.size, c) for c in STORE_GLYPH_COLOR]
    glyph = Image.merge('RGBA', (*channels, glyph.getchannel('A')))
    canvas.alpha_composite(glyph, ((size - width) // 2, (size - height) // 2))

    return clear_faint_pixels(canvas.resize((STORE_SIZE, STORE_SIZE), Image.LANCZOS))


if __name__ == '__main__':
    source = Image.open(SOURCE).convert('RGBA')
    logo = trim_border(source)
    for size in SIZES:
        icon = clear_faint_pixels(logo.resize((size, size), Image.LANCZOS))
        icon.save(f'icons/icon{size}.png', 'PNG', optimize=True)
    store_icon(source).save(STORE_ICON, 'PNG', optimize=True)
