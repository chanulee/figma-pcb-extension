#!/usr/bin/env python3
"""Local bridge between the Figma plugin (tools/figma-pcb) and a KiCad board.

The plugin edits the same silkscreen.json as the web editor; copper is never
written. Saving rewrites board-level silk through silkscreen.apply_layout, and
"release" re-runs make_board.sh release (DRC, ERC, audit, Gerbers) so the
order files always match the saved board.
"""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from urllib.parse import parse_qs, urlsplit
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kicad_silk import KICAD, check_layout, revision, save_layout  # noqa: E402

PORT = 8767
HOLES = ('M2', 'M2.5', 'M3', 'M4', 'M5')


def projects(board_path):
    """Variant id -> (board path, placement plan), as the web editor sees them."""
    plan = json.loads((board_path.parent / 'placement.json').read_text())
    manifest_path = board_path.parent / 'variants.json'
    if not manifest_path.exists():
        return {'original': (board_path, plan)}, 'original', []
    manifest = json.loads(manifest_path.read_text())
    result = {}
    for entry in manifest['variants']:
        directory = (board_path.parent / entry['path']).resolve()
        directory.relative_to(board_path.parent.resolve())
        spec = json.loads((directory / 'placement.json').read_text())
        result[entry['id']] = (directory / board_path.name, spec)
    return result, manifest['default'], manifest['variants']


def reference_svg(board_path, plan, side):
    """Locked Figma reference: mask, copper (no pours), drills, outline, and
    footprint silk, seen from that side (the back is mirrored)."""
    import pcbnew as p
    info = plan['board']
    width, height = info['w'], info['h']
    board = p.LoadBoard(str(board_path))
    if info.get('editable_components'):
        # Movable modules arrive as their own Figma layers.
        for fp in list(board.GetFootprints()):
            board.Delete(fp)
        for track in list(board.GetTracks()):
            board.Delete(track)
        for drawing in list(board.GetDrawings()):
            if drawing.GetLayer() != p.Edge_Cuts or drawing.GetShape() != p.SHAPE_T_RECT:
                board.Delete(drawing)
    if info.get('editable_holes'):
        for fp in list(board.GetFootprints()):
            if fp.GetReference() in HOLES:
                board.Delete(fp)
    for drawing in list(board.GetDrawings()):
        if drawing.GetLayer() in (p.F_SilkS, p.B_SilkS):
            board.Delete(drawing)
    for zone in list(board.Zones()):
        board.Delete(zone)
    with tempfile.TemporaryDirectory(prefix='figma-ref-') as temp:
        source = Path(temp) / 'ref.kicad_pcb'
        p.SaveBoard(str(source), board)
        subprocess.run([str(KICAD / 'MacOS/kicad-cli'), 'pcb', 'export', 'svg', '--layers',
                        ','.join(name for name, *_ in reference_layers(side)), '--mode-multi',
                        '--page-size-mode', '1', '--exclude-drawing-sheet',
                        '--drill-shape-opt', '2', '-o', temp + '/', str(source)],
                       check=True, capture_output=True, timeout=60)
        parts = [f'<rect width="{width}" height="{height}" fill="{info.get("color", "#195039")}"/>']
        for name, file, color, opacity in reference_layers(side):
            plot = ET.fromstring((Path(temp) / f'ref-{file}.svg').read_text())
            body = ''.join(ET.tostring(child, encoding='unicode') for child in plot
                           if not child.tag.endswith(('}title', '}desc')))
            # Drill holes plot white on copper and mask; every other colour is
            # the layer's own.
            body = re.sub(r'#(?!FFFFFF\b)[0-9A-Fa-f]{6}\b', color, body)
            body = re.sub(r'#FFFFFF\b', '#0b0c0c', body)
            body = re.sub(r'\s(xmlns(:\w+)?|id)="[^"]*"', '', body)
            body = re.sub(r'<(/?)ns\d+:', r'<\1', body)
            parts.append(f'<g id="{name}" opacity="{opacity}">{body}</g>')
        return board_svg(f'<svg xmlns="http://www.w3.org/2000/svg">{"".join(parts)}</svg>',
                         width, height, side == 'B')


def reference_layers(side):
    """(KiCad layer, plot file suffix, colour, opacity), bottom to top."""
    return [(f'{side}.Cu', f'{side}_Cu', '#ffffff', .16),
            (f'{side}.Mask', f'{side}_Mask', '#d9b968', 1),
            (f'{side}.SilkS', f'{side}_Silkscreen', '#ffffff', .45),
            ('Edge.Cuts', 'Edge_Cuts', '#f3c96a', 1)]


def plain_svg(source):
    """Figma's SVG importer rejects namespace prefixes (<ns0:svg>), which
    ElementTree writes when nothing registered the default namespace."""
    ET.register_namespace('', 'http://www.w3.org/2000/svg')
    root = ET.fromstring(source.encode() if isinstance(source, str) else source)
    for child in list(root):
        if child.tag.endswith('}title') or child.tag.endswith('}desc'):
            root.remove(child)
    return ET.tostring(root, encoding='unicode')


def board_svg(source, width, height, mirror):
    """Normalise a kicad-cli SVG to a width x height mm view box."""
    ET.register_namespace('', 'http://www.w3.org/2000/svg')
    root = ET.fromstring(source)
    for child in list(root):
        if child.tag.endswith('}title') or child.tag.endswith('}desc'):
            root.remove(child)
    root.set('viewBox', f'0 0 {width} {height}')
    root.set('width', str(width))
    root.set('height', str(height))
    if mirror:
        group = ET.Element('{http://www.w3.org/2000/svg}g',
                           transform=f'translate({width} 0) scale(-1 1)')
        group.extend(list(root))
        for child in list(root):
            root.remove(child)
        root.append(group)
    return ET.tostring(root, encoding='unicode')


def state(board_path, plan, variant, variants):
    import pcbnew as p
    from silkscreen import LAYOUT_FILE, read_layout
    info = plan['board']
    width, height = info['w'], info['h']
    board = p.LoadBoard(str(board_path))
    release_ready = (board_path.parent / 'make_board.sh').exists() and bool(info.get('id'))
    catalog = []
    if info.get('editable_components'):
        from silkscreen import registry
        catalog = list(registry().values())
    return dict(width=width, height=height, name=info.get('name', board_path.stem),
                id=info.get('id', board_path.stem), rev=info.get('rev', ''),
                color=info.get('color', '#195039'), notes=info.get('notes', ''),
                variant=variant, variants=variants,
                editableComponents=bool(info.get('editable_components')),
                editableHoles=bool(info.get('editable_holes')),
                catalog=catalog,
                # make_board.sh release (audit_pcb.py) fails without this text.
                tag=f"{info['id']} rev {info['rev']}" if release_ready else '',
                release=release_ready,
                revision=revision(board_path, board_path.parent / LAYOUT_FILE),
                layout=read_layout(board, board_path.parent, width, height))


def release(board_path):
    """Order files for a silk-only change; any DRC/ERC/audit finding fails."""
    script = board_path.parent / 'make_board.sh'
    if not script.exists():
        raise ValueError('이 보드에는 주문 파일 생성 스크립트(make_board.sh)가 없습니다.')
    run = subprocess.run(['bash', str(script), 'release'], cwd=board_path.parent,
                         capture_output=True, text=True, timeout=900,
                         env={**os.environ, 'KICAD': str(KICAD)})
    log = (run.stdout + run.stderr)[-6000:]
    zips = sorted(board_path.parent.glob(f'{board_path.stem}-rev*-release.zip'))
    return dict(ok=run.returncode == 0, log=log,
                zip=str(zips[-1]) if zips and run.returncode == 0 else '')


def main():
    try:
        import pcbnew  # noqa: F401
    except ImportError:
        python = KICAD / 'Frameworks/Python.framework/Versions/Current/bin/python3'
        if not python.exists():
            raise SystemExit('KiCad 10 Python not found: set KICAD to the KiCad.app/Contents folder.')
        os.execv(str(python), [str(python), str(Path(__file__).resolve()), *sys.argv[1:]])
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--board', type=Path, required=True,
                        help='the .kicad_pcb in a board folder (placement.json + silkscreen.py)')
    parser.add_argument('--port', type=int, default=PORT)
    parser.add_argument('--token', default=os.environ.get('FIGMA_BRIDGE_TOKEN'))
    args = parser.parse_args()
    board_path = args.board.resolve()
    # Variants share the board folder's silkscreen.py, as in the web editor.
    sys.path.insert(0, str(board_path.parent))
    table, default_variant, variants = projects(board_path)
    token = args.token or secrets.token_urlsafe(18)
    # pcbnew is not thread-safe; one request touches a board at a time.
    lock = threading.Lock()
    cache = {}

    class Handler(BaseHTTPRequestHandler):
        def cors(self):
            # The plugin iframe has an opaque ("null") origin; the token, not
            # the origin, authorises requests.
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Silk-Token')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Access-Control-Max-Age', '600')

        def send(self, data, content_type='application/json', status=200):
            if isinstance(data, (dict, list)):
                data = json.dumps(data, ensure_ascii=False).encode()
            elif isinstance(data, str):
                data = data.encode()
            self.send_response(status)
            self.cors()
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.send_response(204)
            self.cors()
            self.send_header('Content-Length', '0')
            self.end_headers()

        def target(self):
            parsed = urlsplit(self.path)
            variant = parse_qs(parsed.query).get('variant', [default_variant])[0]
            if variant not in table:
                raise ValueError('알 수 없는 설계안입니다.')
            return parsed.path, variant, *table[variant]

        def allowed(self):
            if secrets.compare_digest(self.headers.get('X-Silk-Token', ''), token):
                return True
            self.send({'error': '연결 코드가 맞지 않습니다. 브리지 터미널에 출력된 코드를 입력하세요.'}, status=403)
            return False

        def do_GET(self):
            try:
                path, variant, board, plan = self.target()
                if path == '/figma/ping':
                    self.send(dict(ok=True, board=board.stem))
                    return
                if not self.allowed():
                    return
                with lock:
                    if path == '/figma/state':
                        self.send(state(board, plan, variant, variants))
                    elif path in ('/figma/reference/F', '/figma/reference/B'):
                        side = path[-1]
                        key = (str(board), side, revision(board, board.parent / 'silkscreen.json'))
                        if key not in cache:
                            cache[key] = reference_svg(board, plan, side)
                        self.send(cache[key], 'image/svg+xml')
                    elif re.fullmatch(r'/figma/asset/[0-9a-f-]{36}-[FB]\.svg', path) and plan['board'].get('editable_components'):
                        name = path.rsplit('/', 1)[1]
                        asset = board_path.parent / 'assets' / name
                        if asset.is_file():
                            self.send(plain_svg(asset.read_bytes()), 'image/svg+xml')
                            return
                        # Copied or flipped modules borrow their source's art.
                        from silkscreen import instance_asset
                        data = instance_asset(board.parent, name)
                        if data is None:
                            self.send({'error': 'Not found'}, status=404)
                            return
                        self.send(plain_svg(data), 'image/svg+xml')
                    else:
                        self.send({'error': 'Not found'}, status=404)
            except (ValueError, OSError, subprocess.SubprocessError) as exc:
                self.send({'error': str(exc)}, status=400)

        def do_POST(self):
            try:
                path, variant, board, plan = self.target()
                if not self.allowed():
                    return
                if path not in ('/figma/check', '/figma/save', '/figma/release'):
                    self.send({'error': 'Not found'}, status=404)
                    return
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 16_000_000:
                    raise ValueError('요청은 16 MB 이하만 지원합니다.')
                request = json.loads(self.rfile.read(length))
                if not isinstance(request, dict):
                    raise ValueError('잘못된 요청입니다.')
                width, height = plan['board']['w'], plan['board']['h']
                with lock:
                    current = revision(board, board.parent / 'silkscreen.json')
                    if request.get('revision') != current:
                        raise ValueError('Figma로 가져온 뒤 PCB나 silkscreen.json이 바뀌었습니다. '
                                         '다시 가져오거나 변경 내용을 옮겨 적으세요.')
                    if path == '/figma/check':
                        result = check_layout(board, request.get('layout'), width, height,
                                              request.get('side'))
                        result['svg'] = board_svg(result['svg'], width, height, result['side'] == 'B')
                        self.send(result)
                    elif path == '/figma/save':
                        saved = save_layout(board, request.get('layout'), current, width, height)
                        cache.clear()
                        self.send(dict(revision=saved, release=(board.parent / 'make_board.sh').exists()))
                    else:
                        self.send(release(board))
            except (ValueError, OSError, TypeError, KeyError, subprocess.SubprocessError) as exc:
                self.send({'error': str(exc)}, status=400)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    # The plugin may only call http://localhost (Figma rejects IP addresses
    # in the manifest), which can resolve to ::1 first.
    try:
        class Server6(ThreadingHTTPServer):
            address_family = socket.AF_INET6
        server6 = Server6(('::1', args.port), Handler)
        threading.Thread(target=server6.serve_forever, daemon=True).start()
    except OSError:
        server6 = None
    print(f'Figma PCB bridge: http://localhost:{server.server_port}  board {board_path.name}', flush=True)
    print(f'연결 코드: {token}', flush=True)
    print('Ctrl+C로 종료. 저장할 때는 KiCad에서 이 프로젝트를 닫아 두세요.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if server6:
            server6.server_close()


if __name__ == '__main__':
    main()
