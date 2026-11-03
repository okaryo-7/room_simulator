// presets.js / geometry.js / planProcess.js / storage.js を先に通常の <script> で読み込んでおくこと
// （ES モジュールにしないのは、index.html を直接開いた file:// でも動かすため）

// ============================================================
// 状態
// ============================================================
// ワールド座標の単位は cm。画面座標 = ワールド * zoom + pan
const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const ctx = canvas.getContext('2d');

const WALL_RGB = [52, 56, 64];
const WALL_COLOR = `rgb(${WALL_RGB.join(',')})`;
const HANDLE_PX = 7;
const ROT_HANDLE_OFFSET_PX = 26;

const view = { panX: 0, panY: 0, zoom: 1 };

/**
 * plan: 間取り
 *  mask  … 壁だけの canvas（壁色・背景透明）。壁ペン/消しゴムで直接編集する
 *  orig  … 元写真の canvas
 *  scale … 画像1px あたりの cm
 */
let plan = null;
let maskAlpha = null; // 壁との重なり判定用（mask の α 値）
let maskUrlCache = null;
let origUrlCache = null;

let layouts = [];
let currentLayoutId = null;
let customPresets = [];

let items = []; // 現在のレイアウトの家具（layouts[].items と同一参照）
const selection = new Set();
let tool = 'select';

let overlapIds = new Set();
let wallHitIds = new Set();

const ui = {
  grid: true, snap: true, overlap: true, dims: true, origOpacity: 0, brush: 10,
};

// 操作中の一時状態
let drag = null;
let spaceDown = false;
let lastPointer = { sx: 0, sy: 0, wx: 0, wy: 0, inside: false };
let measureLine = null; // { a, b }
let guides = []; // スナップ時の補助線
let clipboard = [];

// ============================================================
// ユーティリティ
// ============================================================
const uid = () => Math.random().toString(36).slice(2, 10);
const round1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtCm = (v) => (Math.abs(v) >= 100 ? `${round1(v / 100)} m (${Math.round(v)} cm)` : `${round1(v)} cm`);

function screenToWorld(sx, sy) {
  return { x: (sx - view.panX) / view.zoom, y: (sy - view.panY) / view.zoom };
}
function worldToScreen(wx, wy) {
  return { x: wx * view.zoom + view.panX, y: wy * view.zoom + view.panY };
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/** 汎用入力ダイアログ（prompt の代わり） */
function ask({ title, text = '', value = '', unit = '', type = 'text' }) {
  return new Promise((resolve) => {
    $('promptTitle').textContent = title;
    $('promptText').textContent = text;
    $('promptUnit').textContent = unit;
    const input = $('promptInput');
    input.type = type;
    input.value = value;
    $('promptModal').hidden = false;
    setTimeout(() => { input.focus(); input.select(); }, 0);
    const done = (v) => {
      $('promptModal').hidden = true;
      $('promptOk').onclick = $('promptCancel').onclick = input.onkeydown = null;
      resolve(v);
    };
    $('promptOk').onclick = () => done(input.value);
    $('promptCancel').onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(input.value);
      if (e.key === 'Escape') done(null);
      e.stopPropagation();
    };
  });
}

function darken(hex, f = 0.62) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
}

function textColorFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const l = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return l > 140 ? '#1d2129' : '#ffffff';
}

// ============================================================
// 履歴（元に戻す / やり直し）
// ============================================================
const undoStack = [];
const redoStack = [];
let lastSnap = '[]';

const snapItems = () => JSON.stringify(items);

/** 家具の変更を確定し、差分があれば履歴に積む */
function commit() {
  const now = snapItems();
  if (now === lastSnap) return;
  const before = lastSnap;
  undoStack.push({ kind: 'items', before, after: now });
  redoStack.length = 0;
  lastSnap = now;
  changed();
}

function pushHistory(entry) {
  undoStack.push(entry);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  changed();
}

function applyItemsSnap(json) {
  const arr = JSON.parse(json);
  items.length = 0;
  items.push(...arr);
  lastSnap = json;
  for (const id of [...selection]) if (!items.some((i) => i.id === id)) selection.delete(id);
}

function undo() {
  const e = undoStack.pop();
  if (!e) return;
  if (e.kind === 'items') applyItemsSnap(e.before);
  else if (e.kind === 'mask') putMask(e.before);
  else if (e.kind === 'scale') setPlanScale(e.before);
  redoStack.push(e);
  changed();
}

function redo() {
  const e = redoStack.pop();
  if (!e) return;
  if (e.kind === 'items') applyItemsSnap(e.after);
  else if (e.kind === 'mask') putMask(e.after);
  else if (e.kind === 'scale') setPlanScale(e.after);
  undoStack.push(e);
  changed();
}

function resetHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  lastSnap = snapItems();
}

/** 何かが変わったら呼ぶ：再計算・UI更新・自動保存 */
function changed() {
  recomputeCollisions();
  refreshPanels();
  requestDraw();
  scheduleSave();
}

// ============================================================
// 間取り（壁マスク）
// ============================================================
function getMaskData() {
  return plan.mask.getContext('2d').getImageData(0, 0, plan.mask.width, plan.mask.height);
}

function putMask(imageData) {
  plan.mask.getContext('2d').putImageData(imageData, 0, 0);
  maskChanged();
}

function maskChanged() {
  maskUrlCache = null;
  const d = getMaskData().data;
  maskAlpha = new Uint8Array(d.length / 4);
  for (let i = 0; i < maskAlpha.length; i++) maskAlpha[i] = d[i * 4 + 3] > 128 ? 1 : 0;
}

function setPlanScale(scale) {
  if (!plan) return;
  const f = scale / plan.scale;
  plan.scale = scale;
  // 見た目の大きさが変わらないようにズームも合わせる
  view.zoom /= f;
  updateStatus();
}

/** 家具が壁に食い込んでいるか（端 1.5cm は許容） */
function hitsWall(item) {
  if (!plan || !maskAlpha) return false;
  const inset = 1.5;
  const hw = item.w / 2 - inset, hh = item.h / 2 - inset;
  if (hw <= 0 || hh <= 0) return false;
  const step = Math.max(plan.scale, 2);
  const outline = item.shape === 'rect' ? null : localOutline(item);
  const W = plan.mask.width, H = plan.mask.height;
  for (let ly = -hh; ly <= hh; ly += step) {
    for (let lx = -hw; lx <= hw; lx += step) {
      if (item.shape === 'ellipse') {
        if ((lx * lx) / (hw * hw) + (ly * ly) / (hh * hh) > 1) continue;
      } else if (outline && !insideInset(outline, lx, ly, item)) {
        continue;
      }
      const p = toWorld(item, lx, ly);
      const ix = Math.floor(p.x / plan.scale), iy = Math.floor(p.y / plan.scale);
      if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue;
      if (maskAlpha[iy * W + ix]) return true;
    }
  }
  return false;
}

function insideInset(outline, lx, ly, item) {
  // 多角形を中心に向かって少し縮めて判定
  const k = 1 - 3 / Math.max(item.w, item.h);
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = { x: outline[i].x * k, y: outline[i].y * k }, b = { x: outline[j].x * k, y: outline[j].y * k };
    if ((a.y > ly) !== (b.y > ly) && lx < ((b.x - a.x) * (ly - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const collides = (it) => it.shape !== 'text' && !it.ignoreOverlap;

function recomputeCollisions(onlyIds) {
  overlapIds = new Set();
  const list = items.filter(collides);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (itemsOverlap(list[i], list[j])) {
        overlapIds.add(list[i].id);
        overlapIds.add(list[j].id);
      }
    }
  }
  if (!onlyIds) wallHitIds = new Set();
  for (const it of list) {
    if (it.shape === 'door') continue;
    if (onlyIds && !onlyIds.has(it.id)) continue;
    if (hitsWall(it)) wallHitIds.add(it.id); else wallHitIds.delete(it.id);
  }
}

// ============================================================
// 描画
// ============================================================
let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  requestDraw();
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.width / dpr, H = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#eef0f3';
  ctx.fillRect(0, 0, W, H);

  ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.panX, dpr * view.panY);
  const tl = screenToWorld(0, 0), br = screenToWorld(W, H);

  renderScene(ctx, { tl, br, zoom: view.zoom, interactive: true });

  $('emptyHint').hidden = !!plan || items.length > 0;
}

/**
 * シーン描画（画面表示と PNG 書き出しで共用）
 * @param opt.tl/br 表示範囲（ワールド）, opt.zoom 1cm あたりの画面px
 */
function renderScene(g, opt) {
  const z = opt.zoom;
  const px = (n) => n / z; // 画面px → ワールド

  if (plan) {
    const pw = plan.mask.width * plan.scale, ph = plan.mask.height * plan.scale;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, pw, ph);
    if (ui.grid) drawGrid(g, opt.tl, opt.br, z);
    if (ui.origOpacity > 0) {
      g.globalAlpha = ui.origOpacity / 100;
      g.drawImage(plan.orig, 0, 0, pw, ph);
      g.globalAlpha = 1;
    }
    g.imageSmoothingEnabled = z < 1 / plan.scale; // 拡大時はくっきり
    g.drawImage(plan.mask, 0, 0, pw, ph);
    g.imageSmoothingEnabled = true;
  } else if (ui.grid) {
    drawGrid(g, opt.tl, opt.br, z);
  }

  for (const it of items) drawItem(g, it, z, opt.interactive);

  if (!opt.interactive) return;

  // 選択枠とハンドル
  for (const it of items) {
    if (!selection.has(it.id)) continue;
    g.save();
    g.setLineDash([px(5), px(4)]);
    g.lineWidth = px(1.5);
    g.strokeStyle = '#2f6fde';
    g.beginPath();
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => toWorld(it, (sx * it.w) / 2, (sy * it.h) / 2));
    corners.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.stroke();
    g.restore();
    if (selection.size === 1 && !it.locked) drawHandles(g, it, z);
  }

  // スナップ補助線
  if (guides.length) {
    g.save();
    g.strokeStyle = '#e0368c';
    g.lineWidth = px(1);
    g.setLineDash([px(4), px(3)]);
    for (const gd of guides) {
      g.beginPath();
      if (gd.axis === 'x') { g.moveTo(gd.v, opt.tl.y); g.lineTo(gd.v, opt.br.y); }
      else { g.moveTo(opt.tl.x, gd.v); g.lineTo(opt.br.x, gd.v); }
      g.stroke();
    }
    g.restore();
  }

  // 計測・縮尺合わせ・壁ペンのプレビュー線
  if (drag && (drag.type === 'line')) drawLine(g, drag.a, drag.b, z, drag.tool);
  else if (measureLine) drawLine(g, measureLine.a, measureLine.b, z, 'measure');

  // ラバーバンド
  if (drag && drag.type === 'marquee') {
    g.save();
    g.fillStyle = 'rgba(47,111,222,.08)';
    g.strokeStyle = '#2f6fde';
    g.lineWidth = px(1);
    const x = Math.min(drag.a.x, drag.b.x), y = Math.min(drag.a.y, drag.b.y);
    const w = Math.abs(drag.a.x - drag.b.x), h = Math.abs(drag.a.y - drag.b.y);
    g.fillRect(x, y, w, h);
    g.strokeRect(x, y, w, h);
    g.restore();
  }

  // 消しゴム・壁ペンのカーソル
  if ((tool === 'erase' || tool === 'wall') && plan && lastPointer.inside) {
    g.save();
    g.strokeStyle = tool === 'erase' ? '#d33a3a' : '#2f6fde';
    g.lineWidth = px(1);
    g.beginPath();
    g.arc(lastPointer.wx, lastPointer.wy, (ui.brush * plan.scale) / 2, 0, Math.PI * 2);
    g.stroke();
    g.restore();
  }
}

function drawGrid(g, tl, br, z) {
  // 画面上で 8px 以上の間隔になる最小の刻みを使う
  const steps = [10, 50, 100, 500, 1000];
  const minor = steps.find((s) => s * z >= 8) || 1000;
  const major = minor < 100 ? 100 : minor * 5;
  const x0 = Math.floor(tl.x / minor) * minor, y0 = Math.floor(tl.y / minor) * minor;
  g.save();
  for (const [step, color, lw] of [[minor, 'rgba(60,80,120,.08)', 1], [major, 'rgba(60,80,120,.18)', 1]]) {
    g.strokeStyle = color;
    g.lineWidth = lw / z;
    g.beginPath();
    for (let x = Math.floor(x0 / step) * step; x <= br.x; x += step) { g.moveTo(x, tl.y); g.lineTo(x, br.y); }
    for (let y = Math.floor(y0 / step) * step; y <= br.y; y += step) { g.moveTo(tl.x, y); g.lineTo(br.x, y); }
    g.stroke();
  }
  g.restore();
}

function tracePath(g, it) {
  const hw = it.w / 2, hh = it.h / 2;
  g.beginPath();
  if (it.shape === 'ellipse') {
    g.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
  } else if (it.shape === 'door') {
    g.moveTo(-hw, hh);
    g.lineTo(-hw, -hh);
    g.ellipse(-hw, hh, it.w, it.h, 0, -Math.PI / 2, 0);
    g.closePath();
  } else {
    const pts = localOutline(it);
    pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
  }
}

function drawItem(g, it, z, interactive) {
  const px = (n) => n / z;
  g.save();
  g.translate(it.x, it.y);
  g.rotate((it.rot * Math.PI) / 180);

  const warn = ui.overlap && (overlapIds.has(it.id) || wallHitIds.has(it.id));

  if (it.shape !== 'text') {
    tracePath(g, it);
    g.globalAlpha = (it.opacity ?? 85) / 100;
    g.fillStyle = it.color;
    g.fill();
    g.globalAlpha = 1;
    g.lineWidth = warn ? px(2.5) : px(1.2);
    g.strokeStyle = warn ? '#e02424' : darken(it.color);
    if (it.shape === 'door') g.setLineDash([px(4), px(3)]);
    g.stroke();
    g.setLineDash([]);
    if (it.shape === 'door') {
      // 扉本体
      g.lineWidth = px(3);
      g.strokeStyle = darken(it.color, 0.5);
      g.beginPath();
      g.moveTo(-it.w / 2, it.h / 2);
      g.lineTo(-it.w / 2, -it.h / 2);
      g.stroke();
    }
    if (it.locked && interactive) {
      g.fillStyle = darken(it.color, 0.5);
      g.font = `${px(11)}px sans-serif`;
      g.textAlign = 'right';
      g.textBaseline = 'top';
      g.fillText('🔒', it.w / 2 - px(2), -it.h / 2 + px(2));
    }
  }

  drawLabel(g, it, z);
  g.restore();
}

function drawLabel(g, it, z) {
  const label = it.label || '';
  const dims = ui.dims && it.shape !== 'text' ? `${round1(it.w)}×${round1(it.h)}` : '';
  if (!label && !dims) return;

  g.save();
  // 文字の中心位置（家具ローカル座標）
  let cx = 0, cy = 0;
  if (it.shape === 'lshape') cx = -it.w / 2 + lArm(it) / 2;
  if (it.shape === 'triangle') cy = it.h * 0.15;
  if (it.shape === 'door') { cx = -it.w * 0.1; cy = it.h * 0.15; }
  g.translate(cx, cy);

  // 画面上でなるべく水平に読めるよう、90°単位で回し戻す
  const rot = ((it.rot % 360) + 360) % 360;
  const quarter = Math.round(rot / 90) % 4;
  g.rotate((-quarter * Math.PI) / 2);
  let boxW = quarter % 2 ? it.h : it.w;
  let boxH = quarter % 2 ? it.w : it.h;

  let fs = it.font || 12;
  g.font = `600 ${fs}px "Hiragino Sans","Yu Gothic UI","Meiryo",sans-serif`;
  const tw = g.measureText(label).width;
  // 横書きが入りきらず、縦の方が長いときは縦向きに
  if (it.shape !== 'text' && it.shape !== 'lshape' && tw > boxW * 0.9 && boxH > boxW * 1.2) {
    g.rotate(-Math.PI / 2);
    [boxW, boxH] = [boxH, boxW];
  }
  const avail = it.shape === 'triangle' ? boxW * 0.55 : it.shape === 'lshape' ? lArm(it) * 0.9 : boxW * 0.9;
  if (tw > avail && it.shape !== 'text') fs = Math.max(fs * 0.4, (fs * avail) / tw);
  // 画面上で小さすぎる文字は少なくとも 9px に
  fs = Math.max(fs, 9 / z);

  g.fillStyle = it.shape === 'text' ? it.color : textColorFor(it.color);
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  g.font = `600 ${fs}px "Hiragino Sans","Yu Gothic UI","Meiryo",sans-serif`;
  const dfs = Math.max(fs * 0.72, 8 / z);
  const hasBoth = label && dims;
  if (label) g.fillText(label, 0, hasBoth ? -dfs * 0.55 : 0);
  if (dims) {
    g.font = `${dfs}px sans-serif`;
    g.globalAlpha = 0.75;
    g.fillText(dims, 0, hasBoth ? fs * 0.6 : 0);
  }
  g.restore();
}

function handlePoints(it) {
  const hw = it.w / 2, hh = it.h / 2;
  const list = [];
  // 画面上で小さい家具は辺のハンドルを出さない（本体をつかみやすくするため）
  const showEdgeX = it.h * view.zoom >= 50, showEdgeY = it.w * view.zoom >= 50;
  for (const sx of [-1, 0, 1]) {
    for (const sy of [-1, 0, 1]) {
      if (!sx && !sy) continue;
      if (!sy && !showEdgeX) continue;
      if (!sx && !showEdgeY) continue;
      list.push({ sx, sy, ...toWorld(it, sx * hw, sy * hh) });
    }
  }
  return list;
}

function rotHandlePoint(it) {
  return toWorld(it, 0, -it.h / 2 - ROT_HANDLE_OFFSET_PX / view.zoom);
}

function drawHandles(g, it, z) {
  const px = (n) => n / z;
  const r = rotHandlePoint(it);
  const top = toWorld(it, 0, -it.h / 2);
  g.save();
  g.strokeStyle = '#2f6fde';
  g.fillStyle = '#fff';
  g.lineWidth = px(1.5);
  g.beginPath();
  g.moveTo(top.x, top.y);
  g.lineTo(r.x, r.y);
  g.stroke();
  g.beginPath();
  g.arc(r.x, r.y, px(HANDLE_PX - 1), 0, Math.PI * 2);
  g.fill();
  g.stroke();
  for (const h of handlePoints(it)) {
    const s = px(HANDLE_PX * (h.sx && h.sy ? 1.6 : 1.3));
    g.save();
    g.translate(h.x, h.y);
    g.rotate((it.rot * Math.PI) / 180);
    g.fillRect(-s / 2, -s / 2, s, s);
    g.strokeRect(-s / 2, -s / 2, s, s);
    g.restore();
  }
  g.restore();
}

function drawLine(g, a, b, z, kind) {
  const px = (n) => n / z;
  g.save();
  if (kind === 'wall') {
    g.strokeStyle = 'rgba(52,56,64,.7)';
    g.lineWidth = ui.brush * plan.scale;
    g.lineCap = 'square';
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
    g.restore();
    return;
  }
  const color = kind === 'calibrate' ? '#e07b00' : '#e0368c';
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = px(2);
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.lineTo(b.x, b.y);
  g.stroke();
  // 端の目印
  const ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2;
  for (const p of [a, b]) {
    g.beginPath();
    g.moveTo(p.x + Math.cos(ang) * px(7), p.y + Math.sin(ang) * px(7));
    g.lineTo(p.x - Math.cos(ang) * px(7), p.y - Math.sin(ang) * px(7));
    g.stroke();
  }
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const text = fmtCm(len);
  g.font = `600 ${px(13)}px sans-serif`;
  const tw = g.measureText(text).width;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  g.fillStyle = 'rgba(255,255,255,.92)';
  g.fillRect(mx - tw / 2 - px(5), my - px(20), tw + px(10), px(18));
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, mx, my - px(11));
  g.restore();
}

// ============================================================
// 家具の追加・編集
// ============================================================
function viewCenterWorld() {
  const r = canvas.getBoundingClientRect();
  return screenToWorld(r.width / 2, r.height / 2);
}

function addItem(spec, at) {
  const c = at || viewCenterWorld();
  // 同じ場所に続けて置くときは少しずらす
  while (items.some((i) => Math.abs(i.x - Math.round(c.x)) < 1 && Math.abs(i.y - Math.round(c.y)) < 1)) {
    c.x += 20;
    c.y += 20;
  }
  const shape = spec.shape || 'rect';
  const it = {
    id: uid(),
    shape,
    label: spec.label ?? '',
    x: Math.round(c.x),
    y: Math.round(c.y),
    w: spec.w,
    h: spec.h,
    rot: spec.rot || 0,
    color: spec.color || '#9fb4d6',
    opacity: spec.opacity ?? (shape === 'text' ? 100 : 85),
    font: spec.font || (shape === 'text' ? 16 : 12),
    note: spec.note || '',
    locked: false,
    ignoreOverlap: !!spec.ignoreOverlap,
  };
  items.push(it);
  selection.clear();
  selection.add(it.id);
  commit();
  return it;
}

const selectedItems = () => items.filter((i) => selection.has(i.id));

function duplicateSelection(offset = 20) {
  const src = selectedItems();
  if (!src.length) return;
  pasteItems(src, offset);
}

function pasteItems(src, offset) {
  selection.clear();
  for (const s of src) {
    const it = { ...JSON.parse(JSON.stringify(s)), id: uid(), x: s.x + offset, y: s.y + offset, locked: false };
    items.push(it);
    selection.add(it.id);
  }
  commit();
}

function deleteSelection() {
  if (!selection.size) return;
  items = replaceItems(items.filter((i) => !selection.has(i.id)));
  selection.clear();
  commit();
}

/** items 配列の中身を入れ替える（レイアウトとの参照を保つ） */
function replaceItems(arr) {
  items.length = 0;
  items.push(...arr);
  return items;
}

function rotateSelection(deg) {
  for (const it of selectedItems()) {
    if (it.locked) continue;
    it.rot = (((it.rot + deg) % 360) + 360) % 360;
  }
  commit();
}

function reorder(toFront) {
  const sel = selectedItems();
  const rest = items.filter((i) => !selection.has(i.id));
  replaceItems(toFront ? [...rest, ...sel] : [...sel, ...rest]);
  commit();
}

function hitItem(wx, wy) {
  for (let i = items.length - 1; i >= 0; i--) if (hitTest(items[i], wx, wy)) return items[i];
  return null;
}

function hitHandle(it, sx, sy) {
  const rp = rotHandlePoint(it);
  const r = worldToScreen(rp.x, rp.y);
  if (Math.hypot(r.x - sx, r.y - sy) <= HANDLE_PX + 3) return { kind: 'rotate' };
  for (const h of handlePoints(it)) {
    const p = worldToScreen(h.x, h.y);
    if (Math.hypot(p.x - sx, p.y - sy) <= HANDLE_PX + 3) return { kind: 'resize', sx: h.sx, sy: h.sy };
  }
  return null;
}

// ============================================================
// スナップ
// ============================================================
/** 選択中の家具を動かすときのずれ補正（他の家具の辺 → グリッドの順） */
function snapMove(movingBounds, others, disabled) {
  guides = [];
  if (disabled || !ui.snap) return { dx: 0, dy: 0 };
  const thr = 8 / view.zoom;
  const best = { x: null, y: null };
  for (const o of others) {
    const b = bounds(o);
    for (const [axis, mv, ov] of [
      ['x', [movingBounds.minX, movingBounds.maxX, (movingBounds.minX + movingBounds.maxX) / 2], [b.minX, b.maxX]],
      ['y', [movingBounds.minY, movingBounds.maxY, (movingBounds.minY + movingBounds.maxY) / 2], [b.minY, b.maxY]],
    ]) {
      for (const m of mv) {
        for (const v of ov) {
          const d = v - m;
          if (Math.abs(d) < thr && (best[axis] === null || Math.abs(d) < Math.abs(best[axis].d))) {
            best[axis] = { d, v };
          }
        }
      }
    }
  }
  const grid = 5;
  const dx = best.x ? best.x.d : Math.round(movingBounds.minX / grid) * grid - movingBounds.minX;
  const dy = best.y ? best.y.d : Math.round(movingBounds.minY / grid) * grid - movingBounds.minY;
  if (best.x) guides.push({ axis: 'x', v: best.x.v });
  if (best.y) guides.push({ axis: 'y', v: best.y.v });
  return { dx, dy };
}

function unionBounds(list) {
  const u = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const it of list) {
    const b = bounds(it);
    u.minX = Math.min(u.minX, b.minX); u.minY = Math.min(u.minY, b.minY);
    u.maxX = Math.max(u.maxX, b.maxX); u.maxY = Math.max(u.maxY, b.maxY);
  }
  return u;
}

/** 水平・垂直に近い線は吸着させる */
function snapLine(a, b, free) {
  if (free) return b;
  const dx = b.x - a.x, dy = b.y - a.y;
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  const near = (t) => Math.abs(((ang - t + 540) % 360) - 180) < 6;
  if (near(0) || near(180)) return { x: b.x, y: a.y };
  if (near(90) || near(-90)) return { x: a.x, y: b.y };
  return b;
}

// ============================================================
// ポインタ操作
// ============================================================
function pointerPos(e) {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  return { sx, sy, ...screenToWorld(sx, sy) };
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const p = pointerPos(e);
  const start = { sx: p.sx, sy: p.sy, x: p.x, y: p.y };

  // 中ボタン・Space+ドラッグは常にパン
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    drag = { type: 'pan', start, panX: view.panX, panY: view.panY };
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;

  if (tool === 'measure' || tool === 'calibrate' || (tool === 'wall' && plan)) {
    measureLine = null;
    drag = { type: 'line', tool, a: { x: p.x, y: p.y }, b: { x: p.x, y: p.y } };
    requestDraw();
    return;
  }
  if (tool === 'erase' && plan) {
    drag = { type: 'erase', before: getMaskData(), last: { x: p.x, y: p.y } };
    eraseAt(p, p);
    return;
  }
  if (tool !== 'select') {
    if (!plan) toast('先に間取り図を読み込んでください');
    drag = { type: 'pan', start, panX: view.panX, panY: view.panY };
    return;
  }

  // 単一選択中ならハンドルを優先
  if (selection.size === 1) {
    const it = selectedItems()[0];
    const h = !it.locked && hitHandle(it, p.sx, p.sy);
    if (h) {
      drag = { type: h.kind, item: it, orig: { ...it }, hsx: h.sx, hsy: h.sy };
      return;
    }
  }

  const hit = hitItem(p.x, p.y);
  if (hit) {
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (selection.has(hit.id)) selection.delete(hit.id); else selection.add(hit.id);
    } else if (!selection.has(hit.id)) {
      selection.clear();
      selection.add(hit.id);
    }
    const moving = selectedItems().filter((i) => !i.locked);
    drag = {
      type: 'move',
      start,
      moving,
      origins: moving.map((i) => ({ x: i.x, y: i.y })),
      startBounds: moving.length ? unionBounds(moving) : null,
      others: items.filter((i) => !selection.has(i.id) && i.shape !== 'text'),
      moved: false,
    };
    refreshPanels();
    requestDraw();
    return;
  }

  if (e.shiftKey) {
    drag = { type: 'marquee', a: { x: p.x, y: p.y }, b: { x: p.x, y: p.y } };
    return;
  }
  drag = { type: 'pan', start, panX: view.panX, panY: view.panY, clickToDeselect: true };
  canvas.style.cursor = 'grabbing';
});

canvas.addEventListener('pointermove', (e) => {
  const p = pointerPos(e);
  lastPointer = { sx: p.sx, sy: p.sy, wx: p.x, wy: p.y, inside: true };
  $('statusCursor').textContent = `X ${Math.round(p.x)}  Y ${Math.round(p.y)} cm`;

  if (!drag) {
    updateHoverCursor(p);
    if (tool === 'erase' || tool === 'wall') requestDraw();
    return;
  }

  switch (drag.type) {
    case 'pan': {
      view.panX = drag.panX + (p.sx - drag.start.sx);
      view.panY = drag.panY + (p.sy - drag.start.sy);
      if (Math.hypot(p.sx - drag.start.sx, p.sy - drag.start.sy) > 3) drag.clickToDeselect = false;
      updateStatus();
      break;
    }
    case 'move': {
      if (!drag.moving.length) break;
      let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (!drag.moved && Math.hypot(p.sx - drag.start.sx, p.sy - drag.start.sy) < 3) break;
      drag.moved = true;
      const b = drag.startBounds;
      const s = snapMove(
        { minX: b.minX + dx, maxX: b.maxX + dx, minY: b.minY + dy, maxY: b.maxY + dy },
        drag.others,
        e.altKey,
      );
      dx += s.dx;
      dy += s.dy;
      drag.moving.forEach((it, k) => {
        it.x = round1(drag.origins[k].x + dx);
        it.y = round1(drag.origins[k].y + dy);
      });
      recomputeCollisions(new Set(drag.moving.map((i) => i.id)));
      updatePropsFields();
      break;
    }
    case 'resize':
      doResize(drag, p, e);
      recomputeCollisions(new Set([drag.item.id]));
      updatePropsFields();
      break;
    case 'rotate': {
      const it = drag.item;
      let ang = (Math.atan2(p.y - it.y, p.x - it.x) * 180) / Math.PI + 90;
      if (e.shiftKey) ang = Math.round(ang / 15) * 15;
      else {
        const r90 = Math.round(ang / 90) * 90;
        if (Math.abs(ang - r90) < 4) ang = r90;
      }
      it.rot = Math.round(((ang % 360) + 360) % 360);
      recomputeCollisions(new Set([it.id]));
      updatePropsFields();
      break;
    }
    case 'line':
      drag.b = snapLine(drag.a, { x: p.x, y: p.y }, e.shiftKey);
      break;
    case 'erase':
      eraseAt(drag.last, p);
      drag.last = { x: p.x, y: p.y };
      break;
    case 'marquee':
      drag.b = { x: p.x, y: p.y };
      break;
  }
  requestDraw();
});

canvas.addEventListener('pointerleave', () => {
  lastPointer.inside = false;
  requestDraw();
});

canvas.addEventListener('pointerup', async () => {
  const d = drag;
  drag = null;
  guides = [];
  canvas.style.cursor = '';
  if (!d) return;

  if (d.type === 'pan' && d.clickToDeselect) {
    selection.clear();
    refreshPanels();
  } else if (d.type === 'move' || d.type === 'resize' || d.type === 'rotate') {
    commit();
  } else if (d.type === 'marquee') {
    const x0 = Math.min(d.a.x, d.b.x), x1 = Math.max(d.a.x, d.b.x);
    const y0 = Math.min(d.a.y, d.b.y), y1 = Math.max(d.a.y, d.b.y);
    for (const it of items) {
      const b = bounds(it);
      if (b.maxX >= x0 && b.minX <= x1 && b.maxY >= y0 && b.minY <= y1) selection.add(it.id);
    }
    refreshPanels();
  } else if (d.type === 'erase') {
    maskChanged();
    pushHistory({ kind: 'mask', before: d.before, after: getMaskData() });
  } else if (d.type === 'line') {
    await finishLine(d);
  }
  requestDraw();
});

canvas.addEventListener('dblclick', async (e) => {
  if (tool !== 'select') return;
  const p = pointerPos(e);
  const it = hitItem(p.x, p.y);
  if (!it) return;
  const v = await ask({ title: '名前を変更', value: it.label });
  if (v !== null) {
    it.label = v;
    commit();
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = pointerPos(e);
  const factor = Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 30 : 1));
  zoomAt(p.sx, p.sy, view.zoom * factor);
}, { passive: false });

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function zoomAt(sx, sy, newZoom) {
  newZoom = clamp(newZoom, 0.05, 40);
  const w = screenToWorld(sx, sy);
  view.zoom = newZoom;
  view.panX = sx - w.x * newZoom;
  view.panY = sy - w.y * newZoom;
  updateStatus();
  requestDraw();
}

function updateHoverCursor(p) {
  let c = '';
  if (spaceDown) c = 'grab';
  else if (tool === 'select') {
    const sel = selection.size === 1 ? selectedItems()[0] : null;
    const h = sel && !sel.locked && hitHandle(sel, p.sx, p.sy);
    if (h) c = h.kind === 'rotate' ? 'alias' : resizeCursor(sel, h);
    else c = hitItem(p.x, p.y) ? 'move' : 'grab';
  } else if (tool === 'erase' || tool === 'wall') c = 'none';
  else c = 'crosshair';
  canvas.style.cursor = c;
}

function resizeCursor(it, h) {
  const ang = ((Math.atan2(h.sy, h.sx) * 180) / Math.PI + it.rot + 360) % 180;
  const names = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
  return names[Math.round(ang / 45) % 4];
}

function doResize(d, p, e) {
  const o = d.orig;
  const it = d.item;
  const local = toLocal(o, p.x, p.y);
  const hw = o.w / 2, hh = o.h / 2;
  const min = 5;
  const step = ui.snap && !e.altKey ? 5 : 1;
  let w = o.w, h = o.h;
  let fx = 0, fy = 0; // 固定される反対側（ローカル）
  if (d.hsx) { fx = -d.hsx * hw; w = Math.max(min, Math.round(((local.x - fx) * d.hsx) / step) * step); }
  if (d.hsy) { fy = -d.hsy * hh; h = Math.max(min, Math.round(((local.y - fy) * d.hsy) / step) * step); }
  if (e.shiftKey && d.hsx && d.hsy) {
    const k = Math.max(w / o.w, h / o.h);
    w = Math.round(o.w * k);
    h = Math.round(o.h * k);
  }
  const cx = d.hsx ? fx + (d.hsx * w) / 2 : 0;
  const cy = d.hsy ? fy + (d.hsy * h) / 2 : 0;
  const c = toWorld(o, cx, cy);
  it.w = w;
  it.h = h;
  it.x = round1(c.x);
  it.y = round1(c.y);
}

function eraseAt(a, b) {
  const g = plan.mask.getContext('2d');
  g.save();
  g.globalCompositeOperation = 'destination-out';
  g.lineCap = 'round';
  g.lineWidth = ui.brush;
  g.beginPath();
  g.moveTo(a.x / plan.scale, a.y / plan.scale);
  g.lineTo(b.x / plan.scale + 0.01, b.y / plan.scale);
  g.stroke();
  g.restore();
  maskUrlCache = null;
  requestDraw();
}

async function finishLine(d) {
  const len = Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y);
  if (d.tool === 'measure') {
    if (len > 0.5) measureLine = { a: d.a, b: d.b };
    return;
  }
  if (d.tool === 'wall') {
    const before = getMaskData();
    const g = plan.mask.getContext('2d');
    g.save();
    g.strokeStyle = WALL_COLOR;
    g.lineWidth = ui.brush;
    g.lineCap = 'square';
    g.beginPath();
    g.moveTo(d.a.x / plan.scale, d.a.y / plan.scale);
    g.lineTo(d.b.x / plan.scale + 0.01, d.b.y / plan.scale);
    g.stroke();
    g.restore();
    maskChanged();
    pushHistory({ kind: 'mask', before, after: getMaskData() });
    return;
  }
  if (d.tool === 'calibrate') {
    if (!plan) { toast('先に間取り図を読み込んでください'); return; }
    if (len < 1) { toast('長さの分かる壁の端から端までドラッグしてください'); return; }
    const v = await ask({
      title: '縮尺合わせ',
      text: `引いた線の実際の長さを入力してください（現在の表示: ${round1(len)} cm）。例: 1間 = 182cm、半間 = 91cm`,
      value: String(Math.round(len)),
      unit: 'cm',
      type: 'number',
    });
    const real = parseFloat(v);
    if (!(real > 0)) return;
    const before = plan.scale;
    setPlanScale(plan.scale * (real / len));
    pushHistory({ kind: 'scale', before, after: plan.scale });
    toast(`縮尺を設定しました（1px = ${round1(plan.scale * 10) / 10} cm）`);
    setTool('select');
  }
}

// ============================================================
// キーボード
// ============================================================
let nudgePending = false;

window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (!$('importModal').hidden || !$('promptModal').hidden) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;

  if (k === ' ') { spaceDown = true; canvas.style.cursor = 'grab'; e.preventDefault(); return; }
  if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
  if (mod && (k === 'd' || k === 'D')) { e.preventDefault(); duplicateSelection(); return; }
  if (mod && (k === 'c' || k === 'C')) { clipboard = JSON.parse(JSON.stringify(selectedItems())); return; }
  if (mod && (k === 'v' || k === 'V')) { if (clipboard.length) { e.preventDefault(); pasteItems(clipboard, 20); clipboard = clipboard.map((c) => ({ ...c, x: c.x + 20, y: c.y + 20 })); } return; }
  if (mod && (k === 'a' || k === 'A')) { e.preventDefault(); items.forEach((i) => selection.add(i.id)); refreshPanels(); requestDraw(); return; }
  if (mod) return;

  if (k === 'Delete' || k === 'Backspace') { deleteSelection(); return; }
  if (k === 'Escape') {
    measureLine = null;
    selection.clear();
    setTool('select');
    refreshPanels();
    requestDraw();
    return;
  }
  if (k.startsWith('Arrow') && selection.size) {
    e.preventDefault();
    const s = e.shiftKey ? 10 : 1;
    const dx = k === 'ArrowLeft' ? -s : k === 'ArrowRight' ? s : 0;
    const dy = k === 'ArrowUp' ? -s : k === 'ArrowDown' ? s : 0;
    for (const it of selectedItems()) if (!it.locked) { it.x = round1(it.x + dx); it.y = round1(it.y + dy); }
    nudgePending = true;
    recomputeCollisions();
    updatePropsFields();
    requestDraw();
    return;
  }
  const lower = k.toLowerCase();
  if (lower === 'r' && selection.size) { rotateSelection(e.shiftKey ? -90 : 90); return; }
  if (lower === 'v') setTool('select');
  else if (lower === 'm') setTool('measure');
  else if (lower === 'w') setTool('wall');
  else if (lower === 'e') setTool('erase');
  else if (lower === 'f') fitView();
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') { spaceDown = false; canvas.style.cursor = ''; }
  if (e.key.startsWith('Arrow') && nudgePending) { nudgePending = false; commit(); }
});

// ============================================================
// ツール・表示
// ============================================================
const TOOL_HINTS = {
  measure: '2点間をドラッグして距離を測ります（Shiftで角度自由）',
  calibrate: '長さが分かる壁の端から端までドラッグしてください → 実寸を入力',
  wall: '壁を描き足します。ドラッグで直線（Shiftで角度自由）。太さは上のスライダー',
  erase: 'ドラッグで間取りの不要な部分を消します。太さは上のスライダー',
};

function setTool(t) {
  tool = t;
  document.querySelectorAll('#toolGroup .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  $('brushBox').hidden = !(t === 'wall' || t === 'erase');
  const hint = TOOL_HINTS[t];
  $('modeHint').hidden = !hint;
  $('modeHint').textContent = hint || '';
  if (t !== 'measure') measureLine = null;
  if ((t === 'wall' || t === 'erase' || t === 'calibrate') && !plan) toast('このツールは間取り図を読み込んでから使えます');
  canvas.style.cursor = '';
  requestDraw();
}

function fitView() {
  const r = canvas.getBoundingClientRect();
  let b = items.length ? unionBounds(items) : null;
  if (plan) {
    const pb = { minX: 0, minY: 0, maxX: plan.mask.width * plan.scale, maxY: plan.mask.height * plan.scale };
    b = b ? {
      minX: Math.min(b.minX, pb.minX), minY: Math.min(b.minY, pb.minY),
      maxX: Math.max(b.maxX, pb.maxX), maxY: Math.max(b.maxY, pb.maxY),
    } : pb;
  }
  if (!b) {
    view.zoom = 1;
    view.panX = r.width / 2;
    view.panY = r.height / 2;
  } else {
    const pad = 40;
    const w = Math.max(b.maxX - b.minX, 50), h = Math.max(b.maxY - b.minY, 50);
    view.zoom = clamp(Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h), 0.05, 40);
    view.panX = r.width / 2 - ((b.minX + b.maxX) / 2) * view.zoom;
    view.panY = r.height / 2 - ((b.minY + b.maxY) / 2) * view.zoom;
  }
  updateStatus();
  requestDraw();
}

function updateStatus() {
  $('statusZoom').textContent = `${Math.round(view.zoom * 100)}%`;
  $('statusScale').textContent = plan ? `縮尺: 画像1px = ${round1(plan.scale * 100) / 100} cm` : '縮尺: 間取りなし';
}

// ============================================================
// パネル（プリセット・プロパティ・一覧・レイアウト）
// ============================================================
function renderPresets() {
  const q = $('presetFilter').value.trim();
  const list = $('presetList');
  list.innerHTML = '';
  for (const cat of PRESET_CATEGORIES) {
    const its = cat.items.filter((p) => !q || p.label.includes(q));
    if (!its.length) continue;
    const h = document.createElement('div');
    h.className = 'preset-cat';
    h.textContent = cat.name;
    list.appendChild(h);
    for (const p of its) list.appendChild(presetButton(p));
  }
}

function presetButton(p, onDelete) {
  const b = document.createElement('button');
  b.className = 'preset';
  b.title = 'クリックで画面中央に配置';
  b.innerHTML = '<span class="sw"></span><span class="nm"></span><span class="sz"></span>';
  b.querySelector('.sw').style.background = p.color;
  b.querySelector('.nm').textContent = p.label;
  b.querySelector('.sz').textContent = `${p.w}×${p.h}`;
  b.addEventListener('click', () => { addItem(p); setTool('select'); });
  if (onDelete) {
    const x = document.createElement('span');
    x.className = 'del';
    x.textContent = '×';
    x.title = 'このプリセットを削除';
    x.addEventListener('click', (e) => { e.stopPropagation(); onDelete(); });
    b.appendChild(x);
  }
  return b;
}

function renderCustomPresets() {
  const box = $('customPresetList');
  box.innerHTML = '';
  if (!customPresets.length) {
    box.className = 'hint';
    box.textContent = '選択中の家具を「プリセットに追加」で登録できます';
    return;
  }
  box.className = '';
  customPresets.forEach((p, i) => {
    box.appendChild(presetButton(p, () => {
      customPresets.splice(i, 1);
      renderCustomPresets();
      scheduleSave();
    }));
  });
}

const propInputs = ['pLabel', 'pW', 'pH', 'pX', 'pY', 'pRot', 'pColor', 'pOpacity', 'pFont', 'pNote', 'pLock', 'pIgnore'];

function refreshPanels() {
  const sel = selectedItems();
  $('props').hidden = !sel.length;
  $('propsEmpty').hidden = !!sel.length;
  $('propCount').textContent = sel.length > 1 ? `(${sel.length}個選択中)` : '';
  const single = sel.length === 1;
  for (const id of ['pLabel', 'pW', 'pH', 'pX', 'pY', 'pRot', 'pNote']) $(id).disabled = !single;
  $('btnAddPreset').disabled = !single;
  updatePropsFields();
  renderItemList();
  $('btnUndo').disabled = !undoStack.length;
  $('btnRedo').disabled = !redoStack.length;
}

function updatePropsFields() {
  const sel = selectedItems();
  if (!sel.length) return;
  const it = sel[0];
  const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };
  set('pLabel', it.label);
  set('pW', round1(it.w));
  set('pH', round1(it.h));
  set('pX', round1(it.x));
  set('pY', round1(it.y));
  set('pRot', Math.round(it.rot));
  set('pColor', it.color);
  set('pOpacity', it.opacity ?? 85);
  set('pFont', it.font || 12);
  set('pNote', it.note || '');
  $('pLock').checked = sel.every((i) => i.locked);
  $('pIgnore').checked = sel.every((i) => i.ignoreOverlap);
}

function renderItemList() {
  const ul = $('itemList');
  ul.innerHTML = '';
  $('itemCount').textContent = items.length ? `${items.length}個` : '';
  [...items].reverse().forEach((it) => {
    const li = document.createElement('li');
    if (selection.has(it.id)) li.classList.add('sel');
    const warns = [];
    if (overlapIds.has(it.id)) warns.push('他の家具と重なっています');
    if (wallHitIds.has(it.id)) warns.push('壁に重なっています');
    if (warns.length && ui.overlap) li.classList.add('warn');
    li.title = [it.note, ...warns].filter(Boolean).join('\n');
    li.innerHTML = '<span class="sw"></span><span class="nm"></span><span class="sz"></span>';
    li.querySelector('.sw').style.background = it.color;
    li.querySelector('.nm').textContent = (warns.length && ui.overlap ? '⚠ ' : '') + (it.label || '(名前なし)');
    li.querySelector('.sz').textContent = it.shape === 'text' ? '文字' : `${round1(it.w)}×${round1(it.h)}`;
    li.addEventListener('click', (e) => {
      if (e.shiftKey || e.ctrlKey) {
        if (selection.has(it.id)) selection.delete(it.id); else selection.add(it.id);
      } else {
        selection.clear();
        selection.add(it.id);
      }
      refreshPanels();
      requestDraw();
    });
    li.addEventListener('dblclick', () => {
      // 画面中央に表示
      const r = canvas.getBoundingClientRect();
      view.panX = r.width / 2 - it.x * view.zoom;
      view.panY = r.height / 2 - it.y * view.zoom;
      requestDraw();
    });
    ul.appendChild(li);
  });
}

function bindProps() {
  const apply = (fn) => {
    for (const it of selectedItems()) fn(it);
    recomputeCollisions();
    requestDraw();
  };
  const num = (id) => parseFloat($(id).value);
  $('pLabel').addEventListener('input', () => apply((it) => { it.label = $('pLabel').value; }));
  $('pNote').addEventListener('input', () => apply((it) => { it.note = $('pNote').value; }));
  $('pW').addEventListener('input', () => { const v = num('pW'); if (v > 0) apply((it) => { it.w = v; }); });
  $('pH').addEventListener('input', () => { const v = num('pH'); if (v > 0) apply((it) => { it.h = v; }); });
  $('pX').addEventListener('input', () => { const v = num('pX'); if (Number.isFinite(v)) apply((it) => { it.x = v; }); });
  $('pY').addEventListener('input', () => { const v = num('pY'); if (Number.isFinite(v)) apply((it) => { it.y = v; }); });
  $('pRot').addEventListener('input', () => { const v = num('pRot'); if (Number.isFinite(v)) apply((it) => { it.rot = ((v % 360) + 360) % 360; }); });
  $('pColor').addEventListener('input', () => apply((it) => { it.color = $('pColor').value; }));
  $('pOpacity').addEventListener('input', () => apply((it) => { it.opacity = num('pOpacity'); }));
  $('pFont').addEventListener('input', () => apply((it) => { it.font = num('pFont'); }));
  $('pLock').addEventListener('change', () => apply((it) => { it.locked = $('pLock').checked; }));
  $('pIgnore').addEventListener('change', () => apply((it) => { it.ignoreOverlap = $('pIgnore').checked; }));
  for (const id of propInputs) $(id).addEventListener('change', commit);

  $('btnRotL').addEventListener('click', () => rotateSelection(-90));
  $('btnRotR').addEventListener('click', () => rotateSelection(90));
  $('btnDup').addEventListener('click', () => duplicateSelection());
  $('btnDelete').addEventListener('click', deleteSelection);
  $('btnFront').addEventListener('click', () => reorder(true));
  $('btnBack').addEventListener('click', () => reorder(false));
  $('btnAddPreset').addEventListener('click', () => {
    const it = selectedItems()[0];
    if (!it) return;
    customPresets.push({
      label: it.label || '家具', w: it.w, h: it.h, color: it.color, shape: it.shape,
      opacity: it.opacity, ignoreOverlap: it.ignoreOverlap, font: it.font,
    });
    renderCustomPresets();
    scheduleSave();
    toast(`「${it.label || '家具'}」をプリセットに追加しました`);
  });
}

// ---------- レイアウト案 ----------
function currentLayout() {
  return layouts.find((l) => l.id === currentLayoutId);
}

function switchLayout(id) {
  currentLayoutId = id;
  items = currentLayout().items;
  selection.clear();
  measureLine = null;
  resetHistory();
  renderLayoutSelect();
  changed();
}

function renderLayoutSelect() {
  const s = $('layoutSelect');
  s.innerHTML = '';
  for (const l of layouts) {
    const o = document.createElement('option');
    o.value = l.id;
    o.textContent = `${l.name}（${l.items.length}）`;
    o.selected = l.id === currentLayoutId;
    s.appendChild(o);
  }
  $('btnLayoutDel').disabled = layouts.length <= 1;
}

function bindLayouts() {
  $('layoutSelect').addEventListener('change', (e) => switchLayout(e.target.value));
  $('btnLayoutNew').addEventListener('click', async () => {
    const name = await ask({ title: '新しいレイアウト案', text: '現在の配置をコピーして新しい案を作ります', value: `案${layouts.length + 1}` });
    if (name === null) return;
    const l = { id: uid(), name: name || `案${layouts.length + 1}`, items: JSON.parse(JSON.stringify(items)) };
    layouts.push(l);
    switchLayout(l.id);
  });
  $('btnLayoutRename').addEventListener('click', async () => {
    const l = currentLayout();
    const name = await ask({ title: 'レイアウト案の名前', value: l.name });
    if (!name) return;
    l.name = name;
    renderLayoutSelect();
    scheduleSave();
  });
  $('btnLayoutDel').addEventListener('click', () => {
    if (layouts.length <= 1) return;
    const l = currentLayout();
    if (!confirm(`「${l.name}」を削除しますか？`)) return;
    layouts = layouts.filter((x) => x !== l);
    switchLayout(layouts[0].id);
  });
}

// ============================================================
// 間取り図の取り込み
// ============================================================
const imp = { src: null, lum: null, mask: null, timer: null };

function readImportOptions() {
  return {
    threshold: +$('sThresh').value,
    wall: +$('sWall').value,
    speck: +$('sSpeck').value,
    grow: +$('sGrow').value,
    invert: $('cInvert').checked,
    raw: $('cRaw').checked,
    flatten: $('cFlatten').checked,
  };
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i;
const HEIC = /\.(heic|heif)$/i;

async function openImport(file) {
  if (!file) return;
  const isHeic = HEIC.test(file.name) || /image\/hei[cf]/.test(file.type);
  if (!file.type.startsWith('image/') && !IMAGE_EXT.test(file.name)) {
    toast(`画像ファイルではないようです（${file.name}）。JPEG / PNG などを選んでください`, 5000);
    return;
  }
  try {
    toast('画像を読み込んでいます…', 10000);
    const source = isHeic ? await heicToJpeg(file) : file;
    imp.src = await loadImageFile(source);
  } catch (err) {
    console.error(err);
    toast(isHeic
      ? 'HEIC 画像を変換できませんでした。写真アプリなどで JPEG に変換してから読み込んでください'
      : `画像を読み込めませんでした（${file.name}）`, 6000);
    return;
  }
  $('toast').hidden = true;
  startImport();
}

/** iPhone の HEIC 写真はブラウザが直接表示できないので、変換ライブラリを必要なときだけ読み込む */
async function heicToJpeg(file) {
  if (!window.heic2any) {
    await new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
      sc.onload = resolve;
      sc.onerror = () => reject(new Error('heic2any を読み込めませんでした'));
      document.head.appendChild(sc);
    });
  }
  const out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  return Array.isArray(out) ? out[0] : out;
}

function startImport() {
  imp.lum = luminance(imp.src);
  const o = $('prevOrig');
  o.width = imp.src.width;
  o.height = imp.src.height;
  o.getContext('2d').drawImage(imp.src, 0, 0);
  // 壁の太さの初期値は画像サイズに合わせる
  $('sWall').value = Math.max(2, Math.round(Math.max(imp.src.width, imp.src.height) / 300));
  $('importModal').hidden = false;
  updateImportLabels();
  scheduleImportPreview();
}

function updateImportLabels() {
  $('oThresh').textContent = $('sThresh').value;
  $('oWall').textContent = $('sWall').value;
  $('oSpeck').textContent = $('sSpeck').value;
  $('oGrow').textContent = $('sGrow').value;
  const raw = $('cRaw').checked;
  for (const id of ['sWall', 'sSpeck', 'sGrow']) $(id).disabled = raw;
}

function scheduleImportPreview() {
  clearTimeout(imp.timer);
  $('importBusy').hidden = false;
  imp.timer = setTimeout(() => {
    imp.mask = extractWalls(imp.src, readImportOptions(), imp.lum);
    const out = $('prevOut');
    maskToCanvas(imp.mask, imp.src.width, imp.src.height, WALL_RGB, out);
    $('importBusy').hidden = true;
  }, 120);
}

function bindImport() {
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    openImport(f);
  });
  for (const id of ['sThresh', 'sWall', 'sSpeck', 'sGrow', 'cInvert', 'cRaw', 'cFlatten']) {
    $(id).addEventListener('input', () => { updateImportLabels(); scheduleImportPreview(); });
  }
  $('btnImportCancel').addEventListener('click', () => { $('importModal').hidden = true; });
  $('btnImportOk').addEventListener('click', () => {
    clearTimeout(imp.timer);
    const mask = imp.mask || extractWalls(imp.src, readImportOptions(), imp.lum);
    const hadPlan = !!plan;
    const prevScale = plan?.scale;
    const w = imp.src.width, h = imp.src.height;
    plan = {
      mask: maskToCanvas(mask, w, h, WALL_RGB),
      orig: imp.src,
      // 仮の縮尺：長辺を 10m と仮定（あとで縮尺合わせ）
      scale: hadPlan && confirmKeepScale() ? prevScale : 1000 / Math.max(w, h),
    };
    origUrlCache = null;
    maskChanged();
    $('importModal').hidden = true;
    undoStack.length = 0;
    redoStack.length = 0;
    changed();
    fitView();
    setTool('calibrate');
    toast('長さの分かる壁をドラッグして「縮尺合わせ」をしましょう', 5000);
  });

  // ドラッグ＆ドロップ（画面のどこに落としても受け付ける。ブラウザが画像を開いてしまうのを防ぐ）
  const wrap = document.querySelector('.stage-wrap');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    wrap.classList.add('dragover');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) wrap.classList.remove('dragover');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    wrap.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f && /\.json$/i.test(f.name)) loadJsonFile(f);
    else openImport(f);
  });
  // クリップボードから画像を貼り付け
  window.addEventListener('paste', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const file = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))?.getAsFile();
    if (file) openImport(file);
  });
}

function confirmKeepScale() {
  return confirm('前の間取りの縮尺をそのまま使いますか？\n（同じ図面を撮り直した場合は OK、別の図面ならキャンセル）');
}

// ============================================================
// 保存・読み込み・書き出し
// ============================================================
function serializeProject() {
  if (plan && !maskUrlCache) maskUrlCache = plan.mask.toDataURL('image/png');
  if (plan && !origUrlCache) origUrlCache = plan.orig.toDataURL('image/jpeg', 0.85);
  return {
    app: 'room-simulator',
    version: 1,
    plan: plan ? { mask: maskUrlCache, orig: origUrlCache, scale: plan.scale } : null,
    layouts,
    currentLayoutId,
    customPresets,
    ui: { grid: ui.grid, snap: ui.snap, overlap: ui.overlap, dims: ui.dims },
    view: { ...view },
  };
}

async function applyProject(p) {
  plan = null;
  maskAlpha = null;
  maskUrlCache = origUrlCache = null;
  if (p.plan) {
    const [mask, orig] = await Promise.all([dataUrlToCanvas(p.plan.mask), dataUrlToCanvas(p.plan.orig)]);
    plan = { mask, orig, scale: p.plan.scale };
    maskUrlCache = p.plan.mask;
    origUrlCache = p.plan.orig;
    maskChanged();
  }
  layouts = p.layouts?.length ? p.layouts : [{ id: uid(), name: '案1', items: [] }];
  customPresets = p.customPresets || [];
  Object.assign(ui, p.ui || {});
  $('chkGrid').checked = ui.grid;
  $('chkSnap').checked = ui.snap;
  $('chkOverlap').checked = ui.overlap;
  $('chkDims').checked = ui.dims;
  renderCustomPresets();
  const id = layouts.some((l) => l.id === p.currentLayoutId) ? p.currentLayoutId : layouts[0].id;
  switchLayout(id);
  if (p.view) Object.assign(view, p.view); else fitView();
  updateStatus();
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await saveProject(serializeProject());
    } catch (err) {
      console.error(err);
      toast('自動保存に失敗しました。「保存」でファイルに書き出してください');
    }
  }, 600);
}

async function loadJsonFile(file) {
  try {
    const p = JSON.parse(await file.text());
    if (p.app !== 'room-simulator') throw new Error('このアプリのファイルではありません');
    if (!confirm('現在の内容を、読み込むファイルで置き換えますか？')) return;
    await applyProject(p);
    fitView();
    scheduleSave();
    toast('読み込みました');
  } catch (err) {
    toast(`読み込みに失敗しました: ${err.message}`);
  }
}

function exportPng() {
  let b = items.length ? unionBounds(items) : null;
  if (plan) {
    const pw = plan.mask.width * plan.scale, ph = plan.mask.height * plan.scale;
    b = b ? { minX: Math.min(b.minX, 0), minY: Math.min(b.minY, 0), maxX: Math.max(b.maxX, pw), maxY: Math.max(b.maxY, ph) }
      : { minX: 0, minY: 0, maxX: pw, maxY: ph };
  }
  if (!b) { toast('書き出す内容がありません'); return; }
  const pad = 20;
  const w = b.maxX - b.minX + pad * 2, h = b.maxY - b.minY + pad * 2;
  const z = Math.min(3, 4000 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * z);
  c.height = Math.round(h * z);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.setTransform(z, 0, 0, z, (pad - b.minX) * z, (pad - b.minY) * z);
  renderScene(g, {
    tl: { x: b.minX - pad, y: b.minY - pad }, br: { x: b.maxX + pad, y: b.maxY + pad }, zoom: z, interactive: false,
  });
  c.toBlob((blob) => downloadBlob(blob, `${currentLayout().name}_家具配置.png`), 'image/png');
}

function bindFileButtons() {
  $('btnSave').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(serializeProject())], { type: 'application/json' });
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    downloadBlob(blob, `家具配置_${stamp}.json`);
  });
  $('btnLoad').addEventListener('click', () => $('jsonInput').click());
  $('jsonInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) loadJsonFile(f);
  });
  $('btnPng').addEventListener('click', exportPng);
  $('btnFit').addEventListener('click', fitView);
  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
  $('btnHelp').addEventListener('click', () => { $('helpModal').hidden = false; });
  $('btnHelpClose').addEventListener('click', () => { $('helpModal').hidden = true; });
  $('helpModal').addEventListener('click', (e) => { if (e.target.id === 'helpModal') $('helpModal').hidden = true; });
}

function bindToolbar() {
  document.querySelectorAll('#toolGroup .tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('brushSize').addEventListener('input', (e) => { ui.brush = +e.target.value; requestDraw(); });
  const toggle = (id, key) => $(id).addEventListener('change', (e) => { ui[key] = e.target.checked; changed(); });
  toggle('chkGrid', 'grid');
  toggle('chkSnap', 'snap');
  toggle('chkOverlap', 'overlap');
  toggle('chkDims', 'dims');
  $('origOpacity').addEventListener('input', (e) => { ui.origOpacity = +e.target.value; requestDraw(); });

  document.querySelectorAll('.shape-btn').forEach((b) => b.addEventListener('click', async () => {
    const shape = b.dataset.shape;
    const spec = { ...SHAPE_DEFAULTS[shape], shape };
    if (shape === 'text') {
      const v = await ask({ title: '文字を追加', value: '', text: '部屋名などを入力（例: 洋室 6畳）' });
      if (!v) return;
      spec.label = v;
      spec.w = Math.max(40, v.length * 17);
    }
    addItem(spec);
    setTool('select');
  }));
  $('presetFilter').addEventListener('input', renderPresets);
}

// ============================================================
// 起動
// ============================================================
async function init() {
  $('scriptError').hidden = true;
  bindToolbar();
  bindProps();
  bindLayouts();
  bindImport();
  bindFileButtons();
  renderPresets();
  new ResizeObserver(resizeCanvas).observe(canvas);
  resizeCanvas();

  let saved = null;
  try {
    saved = await loadProject();
  } catch (err) {
    console.error(err);
  }
  if (saved) {
    try {
      await applyProject(saved);
    } catch (err) {
      console.error(err);
      toast('保存データの復元に失敗しました');
      saved = null;
    }
  }
  if (!saved) {
    layouts = [{ id: uid(), name: '案1', items: [] }];
    switchLayout(layouts[0].id);
    fitView();
  }
  setTool('select');
  updateStatus();
}

init();
