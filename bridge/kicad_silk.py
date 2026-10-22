"""KiCad side of the silkscreen round trip: check a layout with KiCad's DRC
and save it into the board, both through the board folder's silkscreen.py."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

KICAD = Path(os.environ.get('KICAD', '/Applications/KiCad/KiCad.app/Contents'))
if not KICAD.exists() and Path('/Volumes/KiCad/KiCad/KiCad.app/Contents').exists():
    KICAD = Path('/Volumes/KiCad/KiCad/KiCad.app/Contents')


def revision(board_path, layout_path):
    return hashlib.sha256(board_path.read_bytes() + b'\0' + (layout_path.read_bytes() if layout_path.exists() else b'')).hexdigest()


def check_layout(board_path, layout, width, height, side):
    """Check an unsaved layout on a temporary PCB; return native silk and markers."""
    import pcbnew as p
    from silkscreen import apply_layout
    if side not in ('F', 'B'):
        raise ValueError('잘못된 면입니다.')
    board = p.LoadBoard(str(board_path))
    apply_layout(board, layout, width, height)
    objects = list(board.GetDrawings())
    for fp in board.GetFootprints():
        objects.extend([fp.Reference(), fp.Value(), *fp.Pads(), *fp.GraphicalItems()])
    objects = {obj.m_Uuid.AsString(): obj for obj in objects}
    with tempfile.TemporaryDirectory(prefix='silk-check-') as temp:
        temp = Path(temp)
        pcb = temp / board_path.name
        project = board_path.with_suffix('.kicad_pro')
        if project.exists():
            shutil.copy2(project, pcb.with_suffix('.kicad_pro'))
        p.SaveBoard(str(pcb), board)
        report, svg = temp / 'drc.json', temp / 'silk.svg'
        cli = str(KICAD / 'MacOS/kicad-cli')
        subprocess.run([cli, 'pcb', 'drc', '--format', 'json', '-o', str(report), str(pcb)],
                       check=True, capture_output=True, timeout=60)
        issues = []
        labels = {'silk_edge_clearance': '보드 가장자리 간섭', 'silk_overlap': '실크끼리 겹침',
                  'silk_over_copper': '패드·솔더마스크 개구부 간섭',
                  'text_height': '글자 높이 규칙 위반', 'text_thickness': '글자 선 두께 규칙 위반'}
        layer = p.F_SilkS if side == 'F' else p.B_SilkS
        for violation in json.loads(report.read_text())['violations']:
            if violation['type'] not in labels:
                continue
            boxes = []
            for item in violation['items']:
                obj = objects.get(item['uuid'])
                if obj is not None and obj.GetLayer() == layer:
                    box = obj.GetBoundingBox()
                    boxes.append([p.ToMM(box.GetLeft()), p.ToMM(box.GetTop()),
                                  p.ToMM(box.GetWidth()), p.ToMM(box.GetHeight())])
            if boxes:
                issues.append(dict(label=labels[violation['type']], boxes=boxes))
        subprocess.run([cli, 'pcb', 'export', 'svg', '--layers', f'{side}.Mask,Edge.Cuts,{side}.SilkS',
                        '--mode-single', '--page-size-mode', '1', '--exclude-drawing-sheet',
                        '-o', str(svg), str(pcb)], check=True, capture_output=True, timeout=30)
        root = ET.fromstring(svg.read_text())
        root.set('viewBox', f'0 0 {width} {height}')
        root.set('width', f'{width}mm')
        root.set('height', f'{height}mm')
        return dict(side=side, svg=ET.tostring(root, encoding='unicode'), issues=issues)


def save_layout(board_path, layout, expected_revision, width, height):
    import pcbnew as p
    from silkscreen import LAYOUT_FILE, apply_layout
    layout_path = board_path.parent / LAYOUT_FILE
    if revision(board_path, layout_path) != expected_revision:
        raise ValueError('다른 프로그램에서 파일이 변경됐습니다. 페이지를 새로고침하세요.')
    if (board_path.parent / ('~' + board_path.stem + '.kicad_pcb.lck')).exists() or (board_path.parent / ('~' + board_path.stem + '.kicad_pro.lck')).exists():
        raise ValueError('KiCad 프로젝트를 닫은 뒤 저장하세요. 열려 있는 편집 내용과 충돌할 수 있습니다.')
    board = p.LoadBoard(str(board_path))
    apply_layout(board, layout, width, height)
    # Keep one recoverable previous state, and stage both outputs before replacing.
    with tempfile.TemporaryDirectory(prefix='.silk-', dir=board_path.parent) as temp:
        temp = Path(temp)
        pcb = temp / board_path.name
        settings = temp / LAYOUT_FILE
        p.SaveBoard(str(pcb), board)
        settings.write_text(json.dumps(layout, ensure_ascii=False, indent=2) + '\n')
        backup = board_path.with_suffix('.silk-backup.kicad_pcb')
        shutil.copy2(board_path, backup)
        old_layout = layout_path.read_bytes() if layout_path.exists() else None
        if old_layout is not None:
            shutil.copy2(layout_path, layout_path.with_suffix('.json.bak'))
        if revision(board_path, layout_path) != expected_revision:
            raise ValueError('저장 중 외부 변경을 발견했습니다. 새로고침하세요.')
        try:
            os.replace(pcb, board_path)
            os.replace(settings, layout_path)
        except OSError:
            shutil.copy2(backup, board_path)
            if old_layout is None:
                layout_path.unlink(missing_ok=True)
            else:
                layout_path.write_bytes(old_layout)
            raise
    return revision(board_path, layout_path)
