// Run with node tests/test_figma_pcb.js; no Figma or browser dependency.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');

const plugin = path.join(__dirname, '../plugin');
const code = fs.readFileSync(path.join(plugin, 'code.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(code.slice(code.indexOf('// <geometry>'), code.indexOf('// </geometry>')) +
                '\nthis.api = {S, EM, placeAt, apply, angleOf, moduleTransform, readModule, artHash, svgSize, tidyAngle, copyModule};',
                context);
const {S, EM, placeAt, apply, angleOf, moduleTransform, readModule, artHash, svgSize, tidyAngle, copyModule} = context.api;
const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, `${message}: ${a} != ${b}`);

// A box placed at a centre and angle reads back the same centre and angle.
for (const deg of [0, 30, -90, 179, 270]) {
  const m = placeAt(123, 45, 60, 20, deg);
  const [x, y] = apply(m, 30, 10);
  close(x, 123, 'centre x');
  close(y, 45, 'centre y');
  close(tidyAngle(angleOf(m)), tidyAngle(deg), 'angle');
}
// Positive angles turn clockwise on screen, as SVG rotate() and apply_layout do.
const [ex, ey] = apply(placeAt(0, 0, 2, 0, 90), 2, 0);
close(ex, 0, 'end x');
close(ey, 1, 'end y');

// Ruler modules round-trip through the front and the mirrored back view.
const part = {x: 42.5, y: 7.25, rotation: 15, bounds: [-3.925, -3.305, 7.85, 6.61]};
for (const back of [false, true]) {
  const read = readModule(moduleTransform(part, 155, back), part, 155, back);
  assert.deepEqual({...read}, {x: 42.5, y: 7.25, rotation: 15}, `module round trip, back=${back}`);
}
// Seen from the back, a module moves the other way along x.
const front = moduleTransform(part, 155, false), back = moduleTransform(part, 155, true);
assert.ok(front[0][2] / S < 50 && back[0][2] / S > 100, 'back view mirrors x');

// A front module copied onto the back is a flipped copy: mirrored bounds,
// labels and drills, the edited label texts kept, and it round-trips.
const gauge = {id: 'g', name: 'Gauge', side: 'F.SilkS', both: false, bounds: [-0.25, -0.25, 155.44, 4.44],
               drills: [[2, 1, 0.5]], texts: [{id: 't1', text: '1', x: 9.5, y: 2.5, size: 2, rotation: 0, side: 'F', mirror: false, align: 'end'}]};
const placedGauge = {...gauge, texts: [{...gauge.texts[0], text: '10', size: 0.8}]};
const copy = copyModule(gauge, placedGauge, 'B');
assert.equal(copy.flip, true);
assert.equal(copy.side, 'B.SilkS');
assert.equal(copy.copyOf, 'g');
assert.deepEqual([...copy.bounds], [-155.19, -0.25, 155.44, 4.44]);
assert.deepEqual([...copy.drills[0]], [-2, 1, 0.5]);
assert.deepEqual({...copy.texts[0]}, {id: 't1', text: '10', x: -9.5, y: 2.5, size: 0.8, rotation: -0, side: 'B', mirror: true, align: 'end'});
assert.equal(gauge.texts[0].x, 9.5, 'the catalog entry is not modified');
const same = copyModule(gauge, null, 'F');
assert.ok(!same.flip && same.side === 'F.SilkS' && same.bounds[0] === -0.25);
const placedCopy = {...copy, x: 152.1, y: 24.5, rotation: 180};
assert.deepEqual({...readModule(moduleTransform(placedCopy, 155, true), placedCopy, 155, true)}, {x: 152.1, y: 24.5, rotation: 180});

// Clip-path ids change with every clone; the fingerprint ignores them.
assert.equal(artHash('<clipPath id="clip0_12_34"/>'), artHash('<clipPath id="clip0_99_1"/>'));
assert.notEqual(artHash('<path d="M0 0"/>'), artHash('<path d="M0 1"/>'));
assert.deepEqual([...svgSize('<svg width="320" height="286" viewBox="0 0 320 286">')], [320, 286]);
// 0.8 mm KiCad text reads back as 0.8 mm.
close(Number(((0.8 * S * EM) / (S * EM)).toFixed(3)), 0.8, 'text size');

// The plugin inlines stencil.js verbatim, and ui.html is built.
const stencilSource = fs.readFileSync(path.join(plugin, 'stencil.js'), 'utf8');
const stencil = stencilSource.slice(stencilSource.indexOf('function maskRectangles(')).trimEnd();
const ui = fs.readFileSync(path.join(plugin, 'ui.html'), 'utf8');
assert.ok(ui.includes(stencil), 'ui.html carries stencil.js; run python3 plugin/build.py');
const built = execFileSync('python3', ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import build; sys.stdout.write(build.build())', plugin]).toString();
assert.equal(ui, built, 'ui.html is stale; run python3 plugin/build.py');
new vm.Script(ui.slice(ui.indexOf('<script>') + 8, ui.lastIndexOf('</script>')));
new vm.Script(code);

// Thin artwork is grown to print. Strokes are measured at 80 px/mm: a
// 0.125 mm stroke is thin and gets one 0.025 mm pixel per side, 0.1 mm two;
// 0.15 mm and wider are left alone.
const thicken = vm.createContext({});
vm.runInContext(ui.slice(ui.indexOf('/* <thicken>'), ui.indexOf('/* </thicken> */')) +
                '\nthis.api = {strokeWidth, growFor, grow, inkOf, doubled, GRID, FINE_GRID};', thicken);
const bar = (w, h, sw) => { const m = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 10; x < 10 + sw; x++) m[y * w + x] = 1; return m; };
for (const [mm, thin, r] of [[0.1, true, 2], [0.125, true, 1], [0.15, false, 0], [0.2, false, 0]]) {
  const got = thicken.api.strokeWidth(bar(60, 80, Math.round(mm * 80)), 60, 80);
  assert.ok(Math.abs(got - mm) <= 0.007, `${mm} mm stroke reads ${got}`);
  assert.equal(thicken.api.growFor(got), r, `${mm} mm grows ${r}`);
  assert.equal(got < 0.14, thin);
}
assert.equal(thicken.api.growFor(0), 0, 'no ink, nothing to grow');
const grown = thicken.api.grow(bar(30, 60, 5), 30, 60, 1);
let row = 0; for (let x = 0; x < 32; x++) row += grown[30 * 32 + x];
assert.equal(row, 7, 'one pixel added on each side');
// A stencil saved earlier is measured too: a 5 px (0.125 mm) bar stored as
// rectangles reads thin and is grown; an 8 px (0.2 mm) one is left alone.
for (const [px, r] of [[5, 1], [8, 0]]) {
  const ink = thicken.api.inkOf([[10 / 40, 0, px / 40, 1]], 40, 60);
  let n = 0; for (const v of ink) n += v;
  assert.equal(n, px * 60);
  assert.equal(thicken.api.growFor(thicken.api.strokeWidth(thicken.api.doubled(ink, 40, 60), 80, 120)), r, `saved ${px} px bar`);
}
assert.ok(ui.includes("main('reshape'"), 'thickened artwork is shown in Figma after saving');
assert.ok(ui.includes('무엇을 고칠 수 있나요?'), 'the plugin explains what can be edited');

const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'manifest.json'), 'utf8'));
assert.equal(manifest.main, 'code.js');
// Figma rejects IP addresses here; the bridge listens on both loopbacks.
assert.deepEqual(manifest.networkAccess.devAllowedDomains, ['http://localhost:8767']);
assert.ok(ui.includes('value="http://localhost:8767"'));
assert.ok(!code.includes('\u2028'), 'a raw U+2028 breaks the Figma sandbox parser');
console.log('Figma PCB plugin tests passed');
