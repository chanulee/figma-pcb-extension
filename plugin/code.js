// LOVELACE PCB <-> Figma, main thread. Network and rasterising live in ui.html.
// Layer names decide what a node means (svg2shenzhen style): only the direct
// children of the "F.SilkS" / "B.SilkS" frames are printed. Everything is
// measured in the side frame, 1 mm = S px; the back is drawn as seen from the
// back, the same convention silkscreen.json uses.
'use strict';

// <geometry> pure helpers, also run by tests/test_figma_pcb.js
const S = 10;
// Inter's cap height is 0.727 em; KiCad's text size is the cap height and
// its line pitch 1.62 x size. Close enough to place text; the KiCad check
// shows the real stroke font.
const EM = 1.375;
const LINE = 1.62;

function rotation(deg) {
  const a = (deg * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a)];
}

// A w x h box centred on (cx, cy), turned deg clockwise (y down), as Figma's
// relativeTransform.
function placeAt(cx, cy, w, h, deg) {
  const [c, s] = rotation(deg);
  return [[c, -s, cx - (c * w) / 2 + (s * h) / 2],
          [s, c, cy - (s * w) / 2 - (c * h) / 2]];
}

function apply(m, x, y) {
  return [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];
}

function multiply(a, b) {
  return [[a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1],
           a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]],
          [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1],
           a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]]];
}

function invert(m) {
  const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  const a = m[1][1] / det, b = -m[0][1] / det, c = -m[1][0] / det, d = m[0][0] / det;
  return [[a, b, -(a * m[0][2] + b * m[1][2])], [c, d, -(c * m[0][2] + d * m[1][2])]];
}

function angleOf(m) {
  return (Math.atan2(m[1][0], m[0][0]) * 180) / Math.PI;
}

function flipped(m) {
  return m[0][0] * m[1][1] - m[0][1] * m[1][0] < 0;
}

function round(value, step) {
  const r = Math.round(value / step) * step;
  return Number(r.toFixed(6)) || 0;
}

function tidyAngle(deg) {
  let a = round(deg, 0.001) % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return Number(a.toFixed(3)) || 0;
}

// Movable modules (the ruler): footprint origin (x, y), bounds [bx, by, bw, bh]
// around it. The back view mirrors x, the angle and the artwork.
function moduleTransform(c, width, back) {
  const [bx, by, bw] = c.bounds;
  const vx = back ? width - c.x : c.x;
  const [cs, sn] = rotation(back ? -c.rotation : c.rotation);
  const lx = back ? -bx - bw : bx;
  return [[cs, -sn, (vx + cs * lx - sn * by) * S], [sn, cs, (c.y + sn * lx + cs * by) * S]];
}

function readModule(m, c, width, back) {
  const [bx, by, bw] = c.bounds;
  const deg = angleOf(m);
  const [cs, sn] = rotation(deg);
  const lx = back ? -bx - bw : bx;
  const vx = m[0][2] / S - (cs * lx - sn * by);
  const vy = m[1][2] / S - (sn * lx + cs * by);
  return {x: round(back ? width - vx : vx, 0.001), y: round(vy, 0.001),
          rotation: tidyAngle(back ? -deg : deg)};
}

// Stable across clones: Figma names clip paths after node ids.
function artHash(svg) {
  const text = svg.replace(/\b([A-Za-z]+)\d+_\d+(_\d+)*\b/g, '$1');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function svgSize(svg) {
  const head = svg.slice(0, svg.indexOf('>'));
  const w = /\bwidth="([\d.]+)"/.exec(head), h = /\bheight="([\d.]+)"/.exec(head);
  return w && h ? [Number(w[1]), Number(h[1])] : null;
}
// A copy of catalog module `base` for face 'F' or 'B', keeping the label
// texts of `current` (the placed module it was copied from). Changing face
// mirrors the footprint about its origin, as KiCad's Flip does.
function copyModule(base, current, face) {
  const c = JSON.parse(JSON.stringify(base));
  const edited = new Map(((current && current.texts) || []).map(t => [t.id, t]));
  c.texts = c.texts.map(t => Object.assign(t, edited.has(t.id) ? {text: edited.get(t.id).text, size: edited.get(t.id).size} : {}));
  c.copyOf = base.id;
  delete c.flip;
  if (base.side[0] !== face) {
    const [bx, by, bw, bh] = base.bounds;
    c.flip = true;
    c.side = face + '.SilkS';
    c.bounds = [-(bx + bw), by, bw, bh];
    c.drills = (c.drills || []).map(([x, y, d]) => [-x, y, d]);
    c.texts = c.texts.map(t => Object.assign(t, {x: -t.x, rotation: -t.rotation, mirror: !t.mirror,
                                                  side: t.side === 'F' ? 'B' : 'F'}));
    c.name = `${base.name} · ${face === 'B' ? '뒷면' : '앞면'}`;
  }
  return c;
}
// </geometry>

const FONT = {family: 'Inter', style: 'Regular'};
const WHITE = [{type: 'SOLID', color: {r: 1, g: 1, b: 1}}];
const KEY = 'lovelace';
const GAP = 120;

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

function data(node) {
  const raw = node.getPluginData(KEY);
  return raw ? JSON.parse(raw) : null;
}

function mark(node, value) {
  node.setPluginData(KEY, JSON.stringify(value));
}

function boards() {
  return figma.currentPage.children.filter(n => n.type === 'FRAME' && data(n) && data(n).role === 'board');
}

function boardOfSelection() {
  for (let node of figma.currentPage.selection) {
    while (node && node.type !== 'PAGE') {
      const d = data(node);
      if (d && d.role === 'board') return node;
      node = node.parent;
    }
  }
  const all = boards();
  if (all.length === 1) return all[0];
  throw new Error(all.length ? '보드 프레임 안의 레이어를 하나 선택하세요.' : '먼저 PCB를 Figma로 가져오세요.');
}

function sameTransform(a, b) {
  return !!a && !!b && a.every((row, i) => row.every((v, j) => Math.abs(v - b[i][j]) < 0.05));
}

function childByRole(parent, role) {
  return parent.children.find(n => data(n) && data(n).role === role);
}

function fromSvg(svg, what) {
  try {
    return figma.createNodeFromSvg(svg);
  } catch (e) {
    throw new Error(`${what}: Figma가 SVG를 읽지 못했습니다 (${e.message || e}).`);
  }
}

function frame(name, w, h, role) {
  const f = figma.createFrame();
  f.name = name;
  f.resize(w, h);
  f.fills = [];
  f.clipsContent = false;
  mark(f, {role});
  return f;
}

function text(characters, size) {
  const t = figma.createText();
  t.fontName = FONT;
  t.characters = characters;
  t.fontSize = size * S * EM;
  t.lineHeight = {unit: 'PIXELS', value: size * S * LINE};
  t.textAlignHorizontal = 'CENTER';
  t.textAutoResize = 'WIDTH_AND_HEIGHT';
  t.fills = WHITE;
  return t;
}

function legend(state) {
  const t = figma.createText();
  t.fontName = FONT;
  t.fontSize = 12;
  t.lineHeight = {unit: 'PIXELS', value: 18};
  t.characters = [
    `${state.id} rev ${state.rev} · ${state.width} × ${state.height} mm · 1 mm = ${S} px`,
    '인쇄: F.SilkS / B.SilkS 프레임의 바로 아래 레이어만 (흰 실크)',
    'TEXT 레이어 = KiCad 실크 글자 · 도형·그룹·윤곽선 글자 = 그림 그대로 인쇄',
    '이름이 // 로 시작하거나 숨긴 레이어 = 인쇄하지 않음 (메모·가이드)',
    '잠긴 참조: 금색 = 노출 패드(피하기) · 노란 선 = 보드 외곽 · 반투명 = 부품 실크',
    state.tag ? `“${state.tag}” 글자는 TEXT로 남겨 두세요 (주문 전 감사 항목)` : '',
  ].filter(Boolean).join('\n');
  t.fills = [{type: 'SOLID', color: {r: 0.2, g: 0.2, b: 0.2}}];
  return t;
}

// Message payload from ui.html: state from /figma/state, references and
// pre-sized SVG strings (keys: item id, or module id + side).
async function importBoard(msg) {
  const state = msg.state;
  await figma.loadFontAsync(FONT);
  const name = `LOVELACE ${state.id} rev ${state.rev}${state.variants.length ? ` · ${state.variant}` : ''}`;
  const old = boards().find(b => data(b).name === state.name && data(b).variant === state.variant);
  const W = state.width * S, H = state.height * S;
  const root = frame(name, W * 2 + GAP * 3, H + GAP * 2 + 120, 'board');
  root.fills = [{type: 'SOLID', color: {r: 0.95, g: 0.95, b: 0.94}}];
  root.clipsContent = true;
  const extras = Object.assign({}, state.layout);
  delete extras.items;
  delete extras.components;
  mark(root, {role: 'board', name: state.name, variant: state.variant, revision: state.revision,
              width: state.width, height: state.height, id: state.id, rev: state.rev,
              tag: state.tag, release: state.release, extras});
  if (old) {
    root.x = old.x;
    root.y = old.y;
    old.remove();
  } else {
    const view = figma.viewport.center;
    root.x = Math.round(view.x - root.width / 2);
    root.y = Math.round(view.y - root.height / 2);
  }
  const note = legend(state);
  mark(note, {role: 'legend'});
  root.appendChild(note);
  note.x = GAP;
  note.y = GAP / 2 + H + GAP / 2;

  const placed = [];
  for (const side of ['F', 'B']) {
    const back = side === 'B';
    const sideFrame = frame(back ? 'B · 뒷면 (뒤에서 본 모습)' : 'F · 앞면', W, H, 'side');
    mark(sideFrame, {role: 'side', side});
    sideFrame.clipsContent = true;
    root.appendChild(sideFrame);
    sideFrame.x = GAP + (back ? W + GAP : 0);
    sideFrame.y = GAP / 2;

    const ref = fromSvg(msg.references[side], `${side} 참조 레이어`);
    ref.name = '참조 · 잠김 (KiCad)';
    ref.resize(W, H);
    ref.locked = true;
    sideFrame.appendChild(ref);
    ref.x = 0;
    ref.y = 0;
    mark(ref, {role: 'reference', t: ref.relativeTransform});

    if (state.editableComponents) {
      const modules = frame('Modules', W, H, 'modules');
      sideFrame.appendChild(modules);
      for (const c of state.layout.components) {
        if (c.side[0] !== side && !c.both) continue;
        const owner = c.side[0] === side;
        const node = await moduleNode(c, msg.svgs[`${c.id}-${side}`], back, owner);
        modules.appendChild(node);
        node.relativeTransform = moduleTransform(c, state.width, back);
        mark(node, Object.assign(data(node), {w: node.width, h: node.height, t: node.relativeTransform}));
      }
    }

    const silk = frame(`${side}.SilkS`, W, H, 'silk');
    mark(silk, {role: 'silk', side});
    sideFrame.appendChild(silk);
    for (const item of state.layout.items) {
      if (item.side[0] !== side) continue;
      const meta = Object.assign({}, item);
      delete meta.svg;
      delete meta.rectangles;
      if (item.kind === 'text') {
        const t = text(item.text, item.size);
        silk.appendChild(t);
        t.relativeTransform = placeAt(item.x * S, item.y * S, t.width, t.height, item.rotation);
        mark(t, {role: 'item', item: meta});
      } else {
        const art = fromSvg(msg.svgs[item.id], item.name || 'SVG');
        art.name = item.name || 'SVG';
        art.clipsContent = true;
        silk.appendChild(art);
        art.relativeTransform = placeAt(item.x * S, item.y * S, art.width, art.height, item.rotation);
        placed.push([art, meta]);
      }
    }
  }
  // Fingerprint the artwork as exported, so an untouched logo keeps its
  // original SVG and stencil byte for byte.
  for (const [art, meta] of placed) {
    const exported = await exportArt(art, art.parent);
    mark(art, {role: 'item', item: meta, hash: artHash(exported.svg)});
  }
  figma.currentPage.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root]);
  return {name};
}

async function moduleNode(c, svg, back, owner) {
  const [bx, by, bw, bh] = c.bounds;
  const lx = back ? -bx - bw : bx;
  const node = figma.createFrame();
  node.name = owner ? `◆ ${c.name}` : `◇ ${c.name} (다른 면 · 잠김)`;
  node.resize(Math.max(bw * S, 0.01), Math.max(bh * S, 0.01));
  node.fills = [];
  node.clipsContent = false;
  if (svg) {
    const art = fromSvg(svg, c.name);
    art.name = 'footprint';
    art.locked = true;
    mark(art, {role: 'part'});
    node.appendChild(art);
    art.x = 0;
    art.y = 0;
  }
  // Labels (ruler numbers) are drawn for orientation only; edit them in the
  // web editor.
  for (const t of c.texts || []) {
    if (t.side !== (back ? 'B' : 'F')) continue;
    const label = text(t.text, t.size);
    label.textAlignHorizontal = t.align === 'end' ? 'RIGHT' : t.align === 'start' ? 'LEFT' : 'CENTER';
    label.locked = true;
    mark(label, {role: 'part', text: t.id});
    node.appendChild(label);
    const ax = t.align === 'end' ? label.width : t.align === 'start' ? 0 : label.width / 2;
    const ay = t.valign === 'hanging' ? 0 : t.valign === 'central' ? label.height / 2 : label.height * 0.8;
    const [cs, sn] = rotation(t.rotation);
    const mx = t.mirror ? -1 : 1;
    // footprint-local -> view-local (mirrored on the back) -> frame-local
    let m = [[cs * mx, -sn, t.x * S], [sn * mx, cs, t.y * S]];
    m = multiply(m, [[1, 0, -ax], [0, 1, -ay]]);
    if (back) m = multiply([[-1, 0, 0], [0, 1, 0]], m);
    m = multiply([[1, 0, -lx * S], [0, 1, -by * S]], m);
    try {
      label.relativeTransform = m;
    } catch (e) {
      label.remove();
    }
  }
  for (const [dx, dy, d] of c.drills || []) {
    const hole = figma.createEllipse();
    hole.resize(d * S, d * S);
    hole.fills = [{type: 'SOLID', color: {r: 0.71, g: 0.72, b: 0.73}}];
    hole.locked = true;
    mark(hole, {role: 'part'});
    node.appendChild(hole);
    hole.x = ((back ? -dx : dx) - lx - d / 2) * S;
    hole.y = (dy - by - d / 2) * S;
  }
  mark(node, {role: 'module', id: c.id, copyOf: c.copyOf, owner});
  if (!owner) node.locked = true;
  return node;
}

// Export a node unrotated when possible so the layout keeps its angle; a
// mirrored node is baked as drawn. Figma rounds SVG sizes to whole pixels,
// so the copy is exported at FINE x (0.01 mm).
const FINE = 10;

async function exportArt(node, silk) {
  const rel = multiply(invert(silk.absoluteTransform), node.absoluteTransform);
  const clone = node.clone();
  figma.currentPage.appendChild(clone);
  try {
    clone.relativeTransform = rel;
    let local = false;
    if (!flipped(rel)) {
      try {
        clone.relativeTransform = [[1, 0, 0], [0, 1, 0]];
        local = true;
      } catch (e) {
        clone.relativeTransform = rel;
      }
    }
    const box = clone.absoluteRenderBounds || clone.absoluteBoundingBox;
    if (!box || !box.width || !box.height) throw new Error('내보낼 모양이 없습니다.');
    let [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
    if (local) [cx, cy] = apply(rel, cx, cy);
    let scale = FINE;
    try {
      clone.rescale(FINE);
    } catch (e) {
      scale = 1;
    }
    const svg = await clone.exportAsync({format: 'SVG_STRING', svgOutlineText: true,
                                          svgIdAttribute: false, svgSimplifyStroke: true});
    const size = svgSize(svg);
    if (!size) throw new Error('SVG 크기를 읽을 수 없습니다.');
    return {svg, cx: cx / S, cy: cy / S, w: size[0] / (S * scale), h: size[1] / (S * scale),
            rotation: local ? angleOf(rel) : 0};
  } finally {
    clone.remove();
  }
}

// Layers that print on a face: everything in its side frame except the
// locked KiCad reference and check overlays. Modules (◆) may sit anywhere,
// also inside groups; a group or frame without modules prints as one artwork.
function printed(sideFrame, notes) {
  const found = [];
  const visit = (node, inRole) => {
    if (!node.visible || node.name.startsWith('//')) return;
    const d = data(node);
    const role = d && d.role;
    if (role === 'check') return;
    if (role === 'reference') {
      if (d.t && !sameTransform(d.t, node.relativeTransform)) notes.push(`“${node.name}”: 참조 레이어(구리·마스크·외곽)는 저장 대상이 아닙니다. 옮긴 내용은 무시됩니다.`);
      return;
    }
    if (role === 'module') {
      if (d.owner) {
        // Labels still drawn as the module's own text; outlined or deleted
        // ones are emptied on save. Anything else added inside prints as silk.
        const marked = node.children.some(c => data(c) && data(c).role === 'part');
        const labels = new Set();
        for (const child of node.children) {
          const cd = data(child);
          if (cd && cd.role === 'part') {
            if (cd.text && child.visible && child.type === 'TEXT') labels.add(cd.text);
          } else if (marked && child.visible && !child.name.startsWith('//')) {
            found.push({node: child});
          }
        }
        found.push({node, module: d, labels: marked ? [...labels] : null});
        if (d.w && (Math.abs(node.width - d.w) > 0.5 || Math.abs(node.height - d.h) > 0.5)) notes.push(`“${node.name}”: 모듈 크기는 바꿀 수 없습니다(패드 치수 고정). 위치·회전만 저장됩니다.`);
      } else if (d.t && !sameTransform(d.t, node.relativeTransform)) {
        notes.push(`“${node.name}”: 다른 면 모듈의 관통 부분입니다. 원래 면의 ◆를 옮기세요. 이 이동은 저장되지 않습니다.`);
      }
      return;
    }
    const container = role === 'silk' || role === 'modules' ||
      ((node.type === 'GROUP' || (node.type === 'FRAME' && !role)) &&
       !!node.findOne(n => !!data(n) && data(n).role === 'module'));
    if (container) {
      for (const child of node.children) visit(child, true);
      return;
    }
    if (inRole) found.push({node});
  };
  for (const child of sideFrame.children) visit(child, true);
  return found;
}

// Art layers of the last collect, by item id, for 'reshape'.
let collectedArt = new Map();

// Swap an art layer for the shape that was saved (thickened), in place:
// same parent, order, name and centre; plugin data follows.
async function reshape(entries) {
  let done = 0;
  for (const {id, item, svg} of entries) {
    const entry = collectedArt.get(id);
    if (!entry || entry.node.removed) continue;
    const {node, sideFrame} = entry;
    const fresh = fromSvg(svg, item.name);
    fresh.name = node.name;
    fresh.clipsContent = true;
    const parent = node.parent;
    parent.insertChild(parent.children.indexOf(node), fresh);
    const toParent = multiply(invert(multiply(invert(sideFrame.absoluteTransform), parent.absoluteTransform)),
                              placeAt(item.x * S, item.y * S, fresh.width, fresh.height, item.rotation));
    fresh.relativeTransform = toParent;
    node.remove();
    const exported = await exportArt(fresh, sideFrame);
    mark(fresh, {role: 'item', item: Object.assign({}, item, {svg: undefined, rectangles: undefined}), hash: artHash(exported.svg)});
    collectedArt.set(id, {node: fresh, sideFrame});
    done++;
  }
  return done;
}

// Gather the printed layers; ui.html rasterises artwork and posts the layout.
async function collect() {
  collectedArt = new Map();
  const root = boardOfSelection();
  const meta = data(root);
  const errors = [], warnings = [], items = [], modules = [];
  const seen = new Set();
  const label = node => `“${node.name}”`;
  const summary = {};
  for (const node of root.children) {
    const d = data(node);
    if (d && (d.role === 'side' || d.role === 'legend')) continue;
    if (!d && node.type === 'TEXT') continue; // the legend of an older import
    warnings.push(`${label(node)}: 앞면·뒷면 프레임 밖에 있어 저장되지 않습니다. 인쇄하려면 면 프레임 안으로 옮기세요.`);
  }
  for (const side of ['F', 'B']) {
    const sideFrame = root.children.find(n => data(n) && data(n).role === 'side' && data(n).side === side);
    if (!sideFrame) {
      errors.push(`${side} 면 프레임을 찾을 수 없습니다. 다시 가져오세요.`);
      continue;
    }
    const counts = {text: 0, art: 0, modules: 0};
    for (const {node, module, labels} of printed(sideFrame, warnings)) {
      const rel = multiply(invert(sideFrame.absoluteTransform), node.absoluteTransform);
      if (module) {
        modules.push({node, id: module.id, copyOf: module.copyOf, back: side === 'B', transform: rel, labels});
        counts.modules++;
        continue;
      }
      const d = data(node);
      let base = d && d.role === 'item' ? d.item : null;
      if (base && (seen.has(base.id) || base.side[0] !== side)) base = null; // duplicated or moved across sides
      const id = base ? base.id : uuid();
      seen.add(id);
      if (node.type === 'TEXT') {
        if (node.fontSize === figma.mixed) {
          errors.push(`${label(node)}: 글자 크기를 하나로 맞추세요.`);
          continue;
        }
        if (flipped(rel)) {
          errors.push(`${label(node)}: 뒤집은 글자는 KiCad 글자로 만들 수 없습니다. 반대 면 프레임에 넣으세요.`);
          continue;
        }
        if (node.fontName !== figma.mixed && node.fontName.family !== FONT.family) {
          warnings.push(`${label(node)}: KiCad 기본 글꼴로 인쇄됩니다. Figma 글꼴을 쓰려면 윤곽선으로 변환(⇧⌘O)하세요.`);
        }
        const [cx, cy] = apply(rel, node.width / 2, node.height / 2);
        const item = Object.assign({thickness: 0.15}, base || {}, {
          id, kind: 'text', side: `${side}.SilkS`,
          text: node.characters.split(String.fromCharCode(0x2028)).join('\n'),
          x: round(cx / S, 0.001), y: round(cy / S, 0.001),
          size: round(node.fontSize / (S * EM), 0.001), rotation: tidyAngle(angleOf(rel)),
        });
        // JLC's minimum silkscreen line is 0.15 mm.
        item.thickness = Math.max(0.15, (!base || base.kind !== 'text') ? round(item.size * 0.15, 0.01) : item.thickness);
        counts.text++;
        mark(node, {role: 'item', item});
        items.push({item});
        continue;
      }
      if ('effects' in node && node.effects.some(e => e.visible !== false)) warnings.push(`${label(node)}: 그림자·흐림 같은 효과는 인쇄되지 않습니다. 모양만 저장됩니다.`);
      counts.art++;
      let art;
      try {
        art = await exportArt(node, sideFrame);
      } catch (e) {
        errors.push(`${label(node)}: ${e.message || e}`);
        continue;
      }
      const unchanged = !!(base && base.kind === 'svg' && d.hash === artHash(art.svg) &&
                           Math.abs(base.width - art.w) < 0.015 && Math.abs(base.height - art.h) < 0.015);
      const item = Object.assign({ignoreWhite: false}, base && base.kind === 'svg' ? base : {}, {
        id, kind: 'svg', side: `${side}.SilkS`, name: node.name.slice(0, 80),
        x: round(art.cx, 0.001), y: round(art.cy, 0.001), rotation: tidyAngle(art.rotation),
      });
      if (unchanged) {
        Object.assign(item, {width: base.width, height: base.height});
      } else {
        Object.assign(item, {width: round(art.w, 0.001), height: round(art.h, 0.001)});
      }
      mark(node, {role: 'item', item, hash: artHash(art.svg)});
      collectedArt.set(id, {node, sideFrame});
      items.push({item, svg: unchanged ? null : art.svg});
    }
    summary[side] = counts;
  }
  if (meta.tag && !items.some(({item}) => item.kind === 'text' && item.text.includes(meta.tag))) {
    errors.push(`“${meta.tag}” 글자가 TEXT 레이어로 실크에 있어야 주문 전 감사를 통과합니다.`);
  }
  return {meta, items, modules, errors, warnings: [...new Set(warnings)], summary};
}

// Modules as placed in Figma. A module drawn on the other face, a second
// copy, or one pasted from another board becomes a copy of its catalog
// source (flipped when it changed face); a module with no ◆ left is removed.
function moduleLayouts(components, catalog, modules, width) {
  const placed = new Map(components.map(c => [c.id, c]));
  const known = new Map(catalog.map(c => [c.id, c]));
  const used = new Set();
  const out = [];
  for (const m of modules) {
    const face = m.back ? 'B' : 'F';
    const current = placed.get(m.id);
    if (current && !used.has(current.id) && current.side[0] === face) {
      used.add(current.id);
      out.push(withLabels(Object.assign({}, current, readModule(m.transform, current, width, m.back)), m.labels));
      continue;
    }
    const source = current ? (current.copyOf || current.id) : (m.copyOf || m.id);
    const base = known.get(source);
    if (!base) throw new Error(`${m.node.name}: 이 보드의 모듈 목록에 없는 요소입니다.`);
    const c = copyModule(base, current, face);
    // A copy keeps its id once given, also when a save failed halfway.
    c.id = !current && m.copyOf && !used.has(m.id) ? m.id : uuid();
    used.add(c.id);
    mark(m.node, {role: 'module', id: c.id, copyOf: source, owner: true});
    out.push(withLabels(Object.assign(c, readModule(m.transform, c, width, m.back)), m.labels));
  }
  return out;
}

// Module labels no longer drawn as text in Figma print nothing.
function withLabels(c, labels) {
  if (labels) c.texts = c.texts.map(t => labels.includes(t.id) ? t : Object.assign({}, t, {text: ''}));
  return c;
}

function overlay(msg) {
  const root = boardOfSelection();
  const meta = data(root);
  for (const sideFrame of root.children.filter(n => data(n) && data(n).role === 'side')) {
    const old = childByRole(sideFrame, 'check');
    if (old) old.remove();
    const result = msg.results && msg.results[data(sideFrame).side];
    if (!result) continue;
    const back = result.side === 'B';
    const group = frame(`KiCad 검사 · ${result.issues.length}건 (숨기거나 지우세요)`, sideFrame.width, sideFrame.height, 'check');
    sideFrame.appendChild(group);
    const art = fromSvg(result.svg, 'KiCad 검사 결과');
    art.resize(sideFrame.width, sideFrame.height);
    art.opacity = 0.9;
    group.appendChild(art);
    result.issues.forEach((issue, index) => {
      for (const [x, y, w, h] of issue.boxes) {
        const box = figma.createRectangle();
        box.name = `${index + 1}. ${issue.label}`;
        box.resize(Math.max(w * S, 1), Math.max(h * S, 1));
        box.x = ((back ? meta.width - x - w : x)) * S;
        box.y = y * S;
        box.fills = [{type: 'SOLID', color: {r: 1, g: 0.2, b: 0.15}, opacity: 0.18}];
        box.strokes = [{type: 'SOLID', color: {r: 1, g: 0.2, b: 0.15}}];
        box.strokeWeight = 1;
        group.appendChild(box);
      }
    });
    group.locked = true;
  }
}

function clearChecks() {
  const root = boardOfSelection();
  for (const sideFrame of root.children.filter(n => data(n) && data(n).role === 'side')) {
    const old = childByRole(sideFrame, 'check');
    if (old) old.remove();
  }
}

figma.showUI(__html__, {width: 360, height: 720, themeColors: true});

figma.ui.onmessage = async msg => {
  const reply = (type, body) => figma.ui.postMessage(Object.assign({type, request: msg.request}, body));
  try {
    if (msg.type === 'settings') {
      reply('settings', {settings: (await figma.clientStorage.getAsync('bridge')) || {}});
    } else if (msg.type === 'remember') {
      await figma.clientStorage.setAsync('bridge', msg.settings);
      reply('ok', {});
    } else if (msg.type === 'boards') {
      reply('boards', {boards: boards().map(b => data(b))});
    } else if (msg.type === 'import') {
      reply('imported', await importBoard(msg));
    } else if (msg.type === 'collect') {
      const result = await collect();
      if (msg.components) result.components = moduleLayouts(msg.components, msg.catalog || [], result.modules, result.meta.width);
      result.modules = result.modules.length;
      reply('collected', result);
    } else if (msg.type === 'reshape') {
      reply('ok', {count: await reshape(msg.items)});
    } else if (msg.type === 'overlay') {
      overlay(msg);
      reply('ok', {});
    } else if (msg.type === 'clear-checks') {
      clearChecks();
      reply('ok', {});
    } else if (msg.type === 'saved') {
      const root = boardOfSelection();
      mark(root, Object.assign(data(root), {revision: msg.revision}));
      reply('ok', {});
    } else if (msg.type === 'notify') {
      figma.notify(msg.text, {error: !!msg.error});
      reply('ok', {});
    }
  } catch (e) {
    reply('error', {error: e && e.message ? e.message : String(e)});
  }
};
