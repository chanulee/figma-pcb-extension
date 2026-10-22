# figma-pcb-extension

Edit a KiCad board's silkscreen — and move its footprints — in Figma, then save
straight back into the `.kicad_pcb` and re-run DRC/Gerbers. A Figma plugin talks
to a small local bridge running in KiCad's Python; copper and pad geometry are
never edited.

KiCad 보드의 실크스크린을 Figma에서 디자인하고(풋프린트 위치·회전도), 그대로 `.kicad_pcb`에
저장해 DRC와 주문 파일까지 다시 만드는 Figma 플러그인 + 로컬 브리지.

```
plugin/  (Figma: code.js + ui.html)  ⇄  bridge/figma_bridge.py (localhost:8767, KiCad Python)
                                           ├─ silkscreen.json + .kicad_pcb
                                           ├─ KiCad DRC 실크 검사 (kicad-cli)
                                           └─ make_board.sh release → DRC/ERC/Gerber/ZIP (있을 때)
```

요구: KiCad 10 (Python에 `pcbnew`), Figma 데스크톱. 원래 [audiostream-esp32](https://github.com/chanulee/audiostream-esp32)의
LOVELACE 보드용으로 만들었다.

## 참고한 방식

PCB 툴과 원래 연결되지 않은 그림 도구를 "약속"으로 제조 파일에 연결한 사례를 기준으로 삼았다.

| 사례 | 약속 | 여기서 가져온 것 |
|---|---|---|
| 레이저 커팅 (LightBurn, LaserGRBL, Corel→LaserCut) | 선 색 = 공정 (빨강 자르기, 파랑 각인…) | 색 대신 **레이어 이름 = 공정**. PCB는 층이 고정이라 이름이 더 안전하다 |
| [svg2shenzhen](https://github.com/liquidcitymotors/svg2shenzhen) (Inkscape→KiCad) | Inkscape 레이어 이름 `F.SilkS`, `Edge.Cuts`…, 그 외 이름은 무시 | `F.SilkS`/`B.SilkS` 프레임만 인쇄, 나머지는 메모 |
| [svg2mod](https://github.com/mtl/svg2mod) | 레이어 이름으로 KiCad 층 결정 | 같은 규칙 |
| Gerbolyze, PCBmodE | SVG를 원본으로 두고 Gerber를 다시 생성 | 원본은 `silkscreen.json`, 저장 때마다 보드 재생성 |

차이: 이 플러그인은 **한 방향 내보내기가 아니라 왕복**이다. KiCad에서 읽어 오고, 항목마다 ID를
Figma 레이어에 기억해 저장 시 같은 항목을 갱신한다. 그리고 구리·마스크·외곽선은 아예 쓰지 않는다.

## Figma 안의 약속

| Figma | PCB |
|---|---|
| 면 프레임(`F · 앞면`, `B · 뒷면`) 안의 레이어. `F.SilkS`/`Modules` 프레임 안이든 밖이든, 그룹 안이든 | 해당 면 실크로 인쇄 |
| TEXT 레이어 | KiCad 실크 글자(KiCad 기본 글꼴, 선 두께 0.15 mm 이상). 내용·크기·위치·회전이 KiCad 텍스트로 저장 |
| 도형·벡터·윤곽선 글자(⇧⌘O)·모듈이 없는 그룹이나 프레임 | 그림 한 개. 0.025 mm 격자로 채워진 실크가 됨 (웹 편집기의 SVG와 동일) |
| 숨긴 레이어, 이름이 `//`로 시작하는 레이어 | 인쇄 안 함 (가이드·메모) |
| `◆` 모듈 (금색 패드, 자 보드만) | 위치·회전 저장. 그룹 안에 넣어도 된다 |
| `◆` 모듈을 지움 | 저장하면 보드에서 빠진다 |
| `◆` 모듈을 반대 면 프레임에 복사·붙여넣기, 같은 모듈 두 번째 복사, 다른 보드에서 붙여넣기 | 원본의 복사본(`copyOf`). 면이 바뀌면 KiCad Flip처럼 좌우로 뒤집혀 그 면에 놓인다 |
| `◆` 모듈 안 글자를 윤곽선으로 바꾸거나 지움, 모듈 안에 그림을 추가 | 그 그림이 실크로 인쇄되고, 바뀐 모듈 글자는 비워진다(이중 인쇄 없음) |

저장되지 않는 것 — 저장할 때 플러그인이 노란 안내로 알려 준다:

| 편집 | 안내 |
|---|---|
| `◆` 모듈 크기 조절 | 패드 치수가 실물 부품이라 고정. 위치·회전만 저장 |
| `◇` (다른 면 모듈이 비친 관통 부분) 이동 | 원래 면의 `◆`를 옮겨야 함 |
| `참조 · 잠김` 레이어(구리·마스크·외곽) 이동 | 저장 대상 아님 |
| 면 프레임 밖, 보드 프레임 안의 레이어 | 저장 대상 아님 |
| 그림자·흐림 효과 | 모양만 저장 |

패드·구멍·외곽선·새 구리 트레이스·회로 연결은 Figma에서 바꿀 수 없다. KiCad 작업이다.

**얇은 획 자동 보정**: 저장할 때 그림마다 획 두께를 80 px/mm로 재고, 약 0.14 mm보다 얇으면
(JLC 최소 실크 선폭 0.15 mm) 가장자리를 0.025 mm 단위로 늘려 약 0.175 mm로 만든다.
바뀌지 않은 그림도 저장된 스텐실로 매번 다시 재므로, 예전에 얇게 저장된 것도 다음 저장 때 보정된다.
보정된 그림은 인쇄될 모양 그대로 SVG에 저장되고, 저장 직후 Figma 레이어도 그 모양으로 바뀐다
(같은 자리·순서·이름·회전). 로고처럼 두꺼운 그림은 건드리지 않는다. 저장 결과에 보정한 항목과 두께가 표시된다.

- 1 mm = 10 px. 뒷면 프레임은 **뒤에서 본 모습**이다(`silkscreen.json`과 같은 좌표).
- Figma 글꼴을 그대로 인쇄하고 싶으면 글자를 윤곽선으로 바꾼다. 너무 가는 획(0.15 mm 미만)은
  공장에서 사라질 수 있으니 검사 결과와 `reports/preview_*.png`를 확인한다.
- 보드 버전 글자(`AS-008 rev A`)는 TEXT로 남겨야 한다. 감사(`audit_pcb.py`)가 찾는다.
- 래스터 이미지, 뒤집은 TEXT는 거부한다.

## 사용법

1. 브리지 실행 (KiCad를 `/Volumes/KiCad`에 마운트):
   ```sh
   python3 bridge/figma_bridge.py --board path/to/board.kicad_pcb
   ```
   터미널에 연결 코드가 출력된다. 고정하려면 `FIGMA_BRIDGE_TOKEN=...` 환경변수.
2. Figma 데스크톱 → Plugins → Development → **Import plugin from manifest…** →
   `plugin/manifest.json`.
3. 플러그인에서 연결 코드 입력 → 연결 → **PCB 가져오기**.
4. 편집 → **KiCad 검사**: 실제 KiCad 글꼴로 그린 결과와 DRC 위반(빨간 상자)이 덮인다.
5. **PCB · silkscreen.json에 저장**. 저장 전 KiCad에서 프로젝트를 닫는다(잠금 파일 확인).
   가져온 뒤 다른 곳(웹 편집기, KiCad)에서 파일이 바뀌었으면 저장을 거부한다.
6. **주문 파일 만들기**: `make_board.sh release`를 실행한다. 배치·배선은 그대로 두고
   DRC(위반 0) → ERC → 감사 → Gerber/드릴/IPC-356 → `release/`와 ZIP. 하나라도 실패하면
   ZIP을 만들지 않고 로그를 보여 준다.

## 주문 가능성을 지키는 장치

- 쓰는 것은 보드 레벨 실크뿐이다(`silkscreen.apply_layout`). 구리·마스크·드릴·CPL은 바뀌지 않는다.
  AS-008 사본으로 확인: 로고를 옮긴 뒤 다시 만든 release에서 `B_Silkscreen`만 달라지고
  나머지 Gerber·드릴·`cpl.csv`는 동일했다.
- 실크만 바뀌므로 AS 번호는 그대로다(CLAUDE.md 버전 규칙은 구리 변경 기준).
- 저장은 웹 편집기와 같은 `save_layout`: 리비전 확인, 백업(`*.silk-backup.kicad_pcb`,
  `silkscreen.json.bak`), 원자적 교체.
- 패드 위 실크는 검사와 release DRC가 모두 잡는다(사본에서 패드 위 TEXT → DRC 3건, ZIP 생성 안 함).

## 한계

- 자 보드는 주문 스크립트가 없어 "주문 파일 만들기"가 꺼져 있다. 자 README의 남은 DRC 항목 참고.
- 모듈의 구성 텍스트(눈금 숫자 등)는 Figma에서 보기만 한다. 수정은 웹 편집기에서.
- Figma 화면의 TEXT는 Inter로 근사한다. 정확한 모양은 KiCad 검사 오버레이로 본다.
- 다시 가져오면 Figma 쪽 보드 프레임은 파일 내용으로 바뀐다(저장 안 한 Figma 편집은 사라짐).

## 보드 폴더 규약

브리지는 `--board`로 받은 `.kicad_pcb`의 폴더에서 다음을 읽는다.

| 파일 | 내용 |
|---|---|
| `placement.json` | `{"board": {"w": mm, "h": mm, "id": "...", "rev": "...", "color": "#195039"}}` |
| `silkscreen.py` | `LAYOUT_FILE`, `validate`, `read_layout`, `apply_layout`. 예: [`examples/board/silkscreen.py`](examples/board/silkscreen.py) (보드 레벨 실크 텍스트 + 그림) |
| `silkscreen.json` | 저장되는 레이아웃 (없으면 보드의 실크 텍스트를 가져옴) |
| `variants.json` (선택) | 설계안 목록 `{"default": id, "variants": [{"id", "name", "path"}]}` |
| `make_board.sh` (선택) | `make_board.sh release`로 DRC·Gerber를 만드는 주문 스크립트. 있으면 “주문 파일 만들기”가 켜진다 |

움직이는 풋프린트(◆ 모듈)를 쓰려면 보드의 `silkscreen.py`가 `registry()`(모듈 목록)와
`instance_asset()`(복사본 미리보기)을 제공하고, `placement.json`에 `"editable_components": true`를 둔다.
[lovelace-ruler](https://github.com/chanulee/lovelace-ruler)가 그 예다.

## 개발

`plugin/ui.html`은 생성 파일이다. `stencil.js`(웹 편집기와 같은 SVG→실크 변환)를 그대로 넣는다.

```sh
python3 plugin/build.py                    # ui.template.html + stencil.js → ui.html
node tests/test_plugin.js                  # 좌표 왕복, 스텐실, 얇은 획 보정, ui.html 최신 여부
python3 -m unittest discover -s tests      # 브리지
```

## 라이선스

Copyright © 2026 Chanwoo Lee. All rights reserved.

공개 저장소지만 오픈소스 라이선스를 부여하지 않았다. 읽고 살펴보는 것은 GitHub 약관 범위에서 가능하며,
복제·수정·재배포·다른 프로젝트에서 사용하려면 저자의 허락이 필요하다.

