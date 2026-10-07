"""Generate the extension icons from the source logo.

Run from the repo root: python3 scripts/generate_icons.py
"""
from PIL import Image

SOURCE = 'icons/logo-source.png'
SIZES = (16, 48, 128)


if __name__ == '__main__':
    logo = Image.open(SOURCE).convert('RGBA')
    for size in SIZES:
        logo.resize((size, size), Image.LANCZOS).save(f'icons/icon{size}.png', 'PNG', optimize=True)
