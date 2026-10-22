#!/usr/bin/env python3
"""Write ui.html: Figma loads one HTML file, so stencil.js is inlined."""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def stencil():
    source = (HERE / 'stencil.js').read_text()
    return source[source.index('function maskRectangles('):].rstrip()


def build():
    return (HERE / 'ui.template.html').read_text().replace('/*STENCIL*/', stencil())


if __name__ == '__main__':
    (HERE / 'ui.html').write_text(build())
