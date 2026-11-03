// 図形の座標計算・当たり判定。ワールド座標の単位は cm。
// 家具 item = { x, y (中心), w, h, rot (度), shape }

const DEG = Math.PI / 180;

/** ワールド座標 → 家具ローカル座標（中心原点、回転なし） */
export function toLocal(item, px, py) {
  const dx = px - item.x, dy = py - item.y;
  const c = Math.cos(-item.rot * DEG), s = Math.sin(-item.rot * DEG);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

export function toWorld(item, lx, ly) {
  const c = Math.cos(item.rot * DEG), s = Math.sin(item.rot * DEG);
  return { x: item.x + lx * c - ly * s, y: item.y + lx * s + ly * c };
}

/** L字の腕の太さ（短辺の 45%） */
export function lArm(item) {
  return Math.min(item.w, item.h) * 0.45;
}

/** ローカル座標での形状の輪郭（描画・判定共用） */
export function localOutline(item) {
  const hw = item.w / 2, hh = item.h / 2;
  switch (item.shape) {
    case 'ellipse': {
      const pts = [];
      for (let i = 0; i < 32; i++) {
        const t = (i / 32) * Math.PI * 2;
        pts.push({ x: Math.cos(t) * hw, y: Math.sin(t) * hh });
      }
      return pts;
    }
    case 'triangle':
      return [{ x: 0, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }];
    case 'door': {
      // 蝶番 = 左下。扉は上に開き、右へ弧を描く
      const pts = [{ x: -hw, y: hh }];
      for (let i = 0; i <= 12; i++) {
        const t = (i / 12) * (Math.PI / 2);
        pts.push({ x: -hw + Math.sin(t) * item.w, y: hh - Math.cos(t) * item.h });
      }
      return pts;
    }
    case 'lshape': {
      const a = lArm(item);
      return [
        { x: -hw, y: -hh }, { x: -hw + a, y: -hh }, { x: -hw + a, y: hh - a },
        { x: hw, y: hh - a }, { x: hw, y: hh }, { x: -hw, y: hh },
      ];
    }
    default:
      return [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }];
  }
}

/** 重なり判定用の凸多角形群（L字は2つの長方形に分割）ワールド座標 */
export function convexParts(item) {
  const hw = item.w / 2, hh = item.h / 2;
  let parts;
  if (item.shape === 'lshape') {
    const a = lArm(item);
    parts = [
      [{ x: -hw, y: -hh }, { x: -hw + a, y: -hh }, { x: -hw + a, y: hh }, { x: -hw, y: hh }],
      [{ x: -hw + a, y: hh - a }, { x: hw, y: hh - a }, { x: hw, y: hh }, { x: -hw + a, y: hh }],
    ];
  } else {
    parts = [localOutline(item)];
  }
  return parts.map((poly) => poly.map((p) => toWorld(item, p.x, p.y)));
}

export function worldOutline(item) {
  return localOutline(item).map((p) => toWorld(item, p.x, p.y));
}

/** 点が家具の内側にあるか */
export function hitTest(item, px, py) {
  const p = toLocal(item, px, py);
  const hw = item.w / 2, hh = item.h / 2;
  if (item.shape === 'ellipse') {
    return (p.x * p.x) / (hw * hw) + (p.y * p.y) / (hh * hh) <= 1;
  }
  if (item.shape === 'rect' || item.shape === 'text' || !item.shape) {
    return Math.abs(p.x) <= hw && Math.abs(p.y) <= hh;
  }
  return pointInPoly(p, localOutline(item));
}

export function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** 分離軸定理による凸多角形同士の交差判定（接しているだけは重なりとしない） */
function convexOverlap(A, B) {
  for (const poly of [A, B]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
      const nx = p2.y - p1.y, ny = p1.x - p2.x;
      const len = Math.hypot(nx, ny);
      if (len < 1e-9) continue;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const q of A) { const d = (q.x * nx + q.y * ny) / len; minA = Math.min(minA, d); maxA = Math.max(maxA, d); }
      for (const q of B) { const d = (q.x * nx + q.y * ny) / len; minB = Math.min(minB, d); maxB = Math.max(maxB, d); }
      if (maxA <= minB + 0.5 || maxB <= minA + 0.5) return false; // 0.5cm の許容
    }
  }
  return true;
}

export function itemsOverlap(a, b) {
  const pa = convexParts(a), pb = convexParts(b);
  for (const x of pa) for (const y of pb) if (convexOverlap(x, y)) return true;
  return false;
}

/** 回転後の外接矩形（ワールド） */
export function bounds(item) {
  const pts = worldOutline(item);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}
