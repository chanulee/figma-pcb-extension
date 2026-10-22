"""Bridge helpers (no KiCad needed): python3 -m unittest discover -s tests"""
from pathlib import Path
import json
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))
from figma_bridge import board_svg, plain_svg, projects, reference_layers  # noqa: E402

NS = '{http://www.w3.org/2000/svg}'


class BoardSvgTest(unittest.TestCase):
    SOURCE = ('<svg xmlns="http://www.w3.org/2000/svg" width="297mm" height="210mm" '
              'viewBox="0 0 297 210"><title>x</title><desc>y</desc><rect width="1" height="1"/></svg>')

    def test_view_box_is_the_board(self):
        root = ET.fromstring(board_svg(self.SOURCE, 37, 41, False))
        self.assertEqual(root.get('viewBox'), '0 0 37 41')
        self.assertEqual([child.tag for child in root], [NS + 'rect'])

    def test_back_is_mirrored_about_the_board(self):
        root = ET.fromstring(board_svg(self.SOURCE, 37, 41, True))
        group = list(root)
        self.assertEqual(len(group), 1)
        self.assertEqual(group[0].get('transform'), 'translate(37 0) scale(-1 1)')
        self.assertEqual(group[0][0].tag, NS + 'rect')

    def test_assets_lose_namespace_prefixes(self):
        # Figma: "Failed to convert SVG file" on <ns0:svg>.
        source = ('<ns0:svg xmlns:ns0="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><ns0:title>t</ns0:title>'
                  '<ns0:g><ns0:circle r="1"/></ns0:g></ns0:svg>')
        plain = plain_svg(source)
        self.assertNotIn('ns0', plain)
        self.assertTrue(plain.startswith('<svg xmlns="http://www.w3.org/2000/svg"'))
        self.assertNotIn('title', plain)


class ProjectTest(unittest.TestCase):
    def test_board_without_variants(self):
        with tempfile.TemporaryDirectory() as temp:
            board = Path(temp) / 'demo.kicad_pcb'
            (Path(temp) / 'placement.json').write_text(json.dumps({'board': {'w': 40, 'h': 20}}))
            table, default, variants = projects(board)
            self.assertEqual((default, variants, table['original'][0]), ('original', [], board))

    def test_reference_layers_follow_the_side(self):
        for side in 'FB':
            names = [name for name, *_ in reference_layers(side)]
            self.assertEqual(names, [f'{side}.Cu', f'{side}.Mask', f'{side}.SilkS', 'Edge.Cuts'])


if __name__ == '__main__':
    unittest.main()
