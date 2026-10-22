"""Persistent board-level silkscreen, shared by the editor and PCB generator."""
import json
import math
import uuid
from pathlib import Path

LAYOUT_FILE = 'silkscreen.json'
LAYERS = ('F.SilkS', 'B.SilkS')


def validate(layout, width, height):
    if not isinstance(layout, dict) or layout.get('version') != 1:
        raise ValueError('지원하지 않는 배치 파일입니다.')
    items = layout.get('items')
    if not isinstance(items, list) or len(items) > 100:
        raise ValueError('최대 100개 항목을 배치할 수 있습니다.')
    ids = set()
    rectangle_count = 0
    for item in items:
        if not isinstance(item, dict):
            raise ValueError('잘못된 항목입니다.')
        identifier = item.get('id')
        if not isinstance(identifier, str) or not identifier or identifier in ids:
            raise ValueError('항목 ID가 잘못되었거나 중복되었습니다.')
        ids.add(identifier)
        if item.get('side') not in LAYERS:
            raise ValueError('실크 레이어만 편집할 수 있습니다.')
        for key in ('x', 'y', 'rotation'):
            number(item.get(key))
        if not 0 <= item['x'] <= width or not 0 <= item['y'] <= height:
            raise ValueError('항목 중심을 PCB 안에 배치하세요.')
        if abs(item['rotation']) > 360:
            raise ValueError('회전은 -360~360도 범위입니다.')
        if item.get('kind') == 'text':
            if not isinstance(item.get('text'), str) or len(item['text']) > 120:
                raise ValueError('텍스트는 최대 120자로 입력하세요.')
            if any(ord(c) < 32 and c != '\n' for c in item['text']):
                raise ValueError('텍스트에 제어 문자를 사용할 수 없습니다.')
            if not .3 <= number(item.get('size')) <= 10:
                raise ValueError('글자 높이는 0.3~10 mm입니다.')
            if not .05 <= number(item.get('thickness')) <= 1:
                raise ValueError('선 두께는 0.05~1 mm입니다.')
        elif item.get('kind') == 'svg':
            w, h = number(item.get('width')), number(item.get('height'))
            if not .1 <= w <= width or not .1 <= h <= height:
                raise ValueError('SVG 크기를 PCB 크기 안으로 줄이세요.')
            source = item.get('svg')
            if not isinstance(source, str) or len(source.encode()) > 512000:
                raise ValueError('SVG 원본은 500 KB 이하만 지원합니다.')
            rectangles = item.get('rectangles')
            if not isinstance(rectangles, list) or not rectangles:
                raise ValueError('인쇄할 SVG 도형이 없습니다.')
            rectangle_count += len(rectangles)
            if rectangle_count > 40000:
                raise ValueError('SVG가 너무 복잡합니다. 도형을 단순화하세요.')
            for rect in rectangles:
                if not isinstance(rect, list) or len(rect) != 4:
                    raise ValueError('잘못된 SVG 도형입니다.')
                x, y, rw, rh = map(number, rect)
                if min(x, y) < 0 or min(rw, rh) <= 0 or x + rw > 1.000001 or y + rh > 1.000001:
                    raise ValueError('SVG 도형 범위를 벗어났습니다.')
            # Check rotated artwork, not just its center.
            a = math.radians(item['rotation'])
            dx = (abs(math.cos(a)) * w + abs(math.sin(a)) * h) / 2
            dy = (abs(math.sin(a)) * w + abs(math.cos(a)) * h) / 2
            if item['x'] - dx < 0 or item['x'] + dx > width or item['y'] - dy < 0 or item['y'] + dy > height:
                raise ValueError('SVG가 보드 가장자리를 넘어갑니다.')
        else:
            raise ValueError('지원하지 않는 항목입니다.')
    return layout


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('유한한 숫자를 입력하세요.')
    return value


def read_layout(board, directory, width, height):
    """Migrate existing native text only when no editable layout exists."""
    import pcbnew as p
    path = Path(directory) / LAYOUT_FILE
    if path.exists():
        return validate(json.loads(path.read_text()), width, height)
    items = []
    for drawing in board.GetDrawings():
        if drawing.GetLayer() not in (p.F_SilkS, p.B_SilkS):
            continue
        if not isinstance(drawing, p.PCB_TEXT):
            raise ValueError('기존 보드 실크 도형을 먼저 백업하세요. 자동 가져오기는 텍스트만 지원합니다.')
        back = drawing.GetLayer() == p.B_SilkS
        if drawing.IsMirrored() != back:
            raise ValueError('비표준 미러 텍스트는 KiCad에서 먼저 정리하세요.')
        x = p.ToMM(drawing.GetPosition().x)
        items.append(dict(id=str(uuid.uuid4()), kind='text', side='B.SilkS' if back else 'F.SilkS',
                          text=drawing.GetText(), x=width - x if back else x,
                          y=p.ToMM(drawing.GetPosition().y), size=p.ToMM(drawing.GetTextSize().y),
                          thickness=p.ToMM(drawing.GetTextThickness()),
                          rotation=drawing.GetTextAngle().AsDegrees() * (1 if back else -1)))
    return validate(dict(version=1, items=items), width, height)


def apply_layout(board, layout, width, height):
    """Replace board-level silk only; footprint markings and copper are retained."""
    import pcbnew as p
    validate(layout, width, height)
    for drawing in list(board.GetDrawings()):
        if drawing.GetLayer() in (p.F_SilkS, p.B_SilkS):
            board.Delete(drawing)
    for item in layout['items']:
        back = item['side'] == 'B.SilkS'
        layer = p.B_SilkS if back else p.F_SilkS
        if item['kind'] == 'text':
            if not item['text'].strip():
                continue
            text = p.PCB_TEXT(board)
            text.SetText(item['text'])
            text.SetPosition(p.VECTOR2I(round(p.FromMM(1) * (width - item['x'] if back else item['x'])), round(p.FromMM(1) * item['y'])))
            text.SetTextSize(p.VECTOR2I(p.FromMM(item['size']), p.FromMM(item['size'])))
            text.SetTextThickness(p.FromMM(item['thickness']))
            text.SetTextAngle(p.EDA_ANGLE(item['rotation'] * (1 if back else -1), p.DEGREES_T))
            text.SetMirrored(back)
            text.SetLayer(layer)
            board.Add(text)
            continue
        angle = math.radians(item['rotation'])
        ca, sa = math.cos(angle), math.sin(angle)
        for x, y, w, h in item['rectangles']:
            polygon = p.SHAPE_POLY_SET()
            polygon.NewOutline()
            for u, v in ((x, y), (x + w, y), (x + w, y + h), (x, y + h)):
                lx, ly = (u - .5) * item['width'], (v - .5) * item['height']
                px = item['x'] + ca * lx - sa * ly
                py = item['y'] + sa * lx + ca * ly
                polygon.Append(p.FromMM(width - px if back else px), p.FromMM(py))
            shape = p.PCB_SHAPE(board)
            shape.SetShape(p.SHAPE_T_POLY)
            shape.SetPolyShape(polygon)
            shape.SetFilled(True)
            shape.SetWidth(0)
            shape.SetLayer(layer)
            board.Add(shape)


def apply_saved(board, directory, width, height):
    path = Path(directory) / LAYOUT_FILE
    if path.exists():
        apply_layout(board, json.loads(path.read_text()), width, height)
