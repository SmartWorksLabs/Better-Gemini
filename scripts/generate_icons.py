"""Generate the extension icons. Run from the repo root: python3 scripts/generate_icons.py"""
import os

from PIL import Image, ImageDraw


def create_icon(size, filename):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    padding = max(1, size // 16)
    radius = max(2, size // 8)
    draw.rounded_rectangle(
        [padding, padding, size - padding, size - padding],
        radius=radius,
        fill=(66, 133, 244, 255)  # Google Blue
    )

    bar_height = max(2, size // 8)
    bar_margin = max(2, size // 4)
    bar_gap = max(2, size // 6)

    # Bottom bar (solid white)
    y1 = size - bar_margin - bar_height
    draw.rectangle([bar_margin, y1, size - bar_margin, y1 + bar_height], fill=(255, 255, 255, 255))

    # Top bar (semi-transparent)
    y2 = y1 - bar_gap - bar_height
    draw.rectangle([bar_margin, y2, size - bar_margin, y2 + bar_height], fill=(255, 255, 255, 153))

    img.save(filename, 'PNG')


if __name__ == '__main__':
    os.makedirs('icons', exist_ok=True)
    create_icon(16, 'icons/icon16.png')
    create_icon(48, 'icons/icon48.png')
    create_icon(128, 'icons/icon128.png')
