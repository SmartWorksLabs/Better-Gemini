"""Generate the extension icons from the source logos.

Run from the repo root: python3 scripts/generate_icons.py

icons/logo-source.png       -> icons/icon{size}.png       (light mode, the default)
icons/logo-source-dark.png  -> icons/icon{size}-dark.png  (dark mode toolbar icon)
"""
from PIL import Image

SOURCES = {
    'icons/logo-source.png': '',
    'icons/logo-source-dark.png': '-dark',
}
# 16 and 32 are the toolbar sizes (32 for high-resolution screens),
# 48 is used on the extensions page, 128 in the Chrome Web Store.
SIZES = (16, 32, 48, 128)


if __name__ == '__main__':
    for source, suffix in SOURCES.items():
        logo = Image.open(source).convert('RGBA')
        for size in SIZES:
            logo.resize((size, size), Image.LANCZOS).save(f'icons/icon{size}{suffix}.png', 'PNG', optimize=True)
