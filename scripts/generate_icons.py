"""Generate an extension's icons and its Chrome Web Store icon from its logo.

Run from the repo root with the extension's folder:
    python3 scripts/generate_icons.py hide-chat-bar

<folder>/icons/logo.png -> <folder>/icons/icon{size}.png
                        -> <folder>/store/store-icon.png

A logo with a transparent background is used as a shape: the installed icons
are the shape alone, and the store icon draws it in white on a blue tile.
A logo that fills its whole square (no transparency) is used as a picture:
every icon is that picture with rounded corners.
"""
import os
import sys

from PIL import Image, ImageDraw

# 16 and 32 are the toolbar sizes (32 for high-resolution screens),
# 48 is used on the extensions page, 128 in the Chrome Web Store.
SIZES = (16, 32, 48, 128)

# The store listing icon is uploaded separately in the developer dashboard, so
# it can sit on a rounded tile while the installed icons stay transparent.
# Google's guidelines: 128x128 canvas, 96x96 artwork, 16px transparent padding.
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


def has_transparency(image):
    return image.getchannel('A').getextrema()[0] < 250


def rounded_tile(source, size, tile):
    """The whole picture as a rounded tile of `tile` px, centred on a `size` px canvas."""
    big = tile * SUPERSAMPLE
    art = source.resize((big, big), Image.LANCZOS)
    mask = Image.new('L', (big, big), 0)
    radius = round(big * STORE_RADIUS / STORE_TILE)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=255)
    art.putalpha(mask)
    canvas = Image.new('RGBA', (size * SUPERSAMPLE, size * SUPERSAMPLE), (0, 0, 0, 0))
    offset = (size - tile) // 2 * SUPERSAMPLE
    canvas.alpha_composite(art, (offset, offset))
    return canvas.resize((size, size), Image.LANCZOS)


def picture_icons(source, folder):
    """Toolbar sizes fill the whole square to stay legible; 128 and the store
    icon keep Google's 16px transparent margin around a 96px tile."""
    for size in SIZES:
        tile = STORE_TILE if size == STORE_SIZE else size
        rounded_tile(source, size, tile).save(
            os.path.join(folder, 'icons', f'icon{size}.png'), 'PNG', optimize=True)
    rounded_tile(source, STORE_SIZE, STORE_TILE).save(
        os.path.join(folder, 'store', 'store-icon.png'), 'PNG', optimize=True)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('usage: python3 scripts/generate_icons.py <extension folder>')
    folder = sys.argv[1]
    source = Image.open(os.path.join(folder, 'icons', 'logo.png')).convert('RGBA')
    os.makedirs(os.path.join(folder, 'store'), exist_ok=True)
    if not has_transparency(source):
        picture_icons(source, folder)
        sys.exit()
    logo = trim_border(source)
    for size in SIZES:
        icon = clear_faint_pixels(logo.resize((size, size), Image.LANCZOS))
        icon.save(os.path.join(folder, 'icons', f'icon{size}.png'), 'PNG', optimize=True)
    store_icon(source).save(os.path.join(folder, 'store', 'store-icon.png'), 'PNG', optimize=True)
