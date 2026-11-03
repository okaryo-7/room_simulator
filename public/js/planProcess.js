// 間取り図の写真から「壁（太い線）」だけを抜き出す画像処理
//
// 手順:
//   1. グレースケール化（任意で照明ムラ補正）
//   2. しきい値で二値化（暗い = 1）
//   3. モルフォロジー・オープニング（収縮→膨張）で、指定より細い線＝文字・寸法線・建具の線を除去
//   4. 小さな連結成分（残った太字や点）を除去
//   5. 任意で壁を少し太らせる

const MAX_DIM = 2000;

/** File/Blob を読み込み、長辺 MAX_DIM 以下に縮小した canvas を返す */
async function loadImageFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('画像を読み込めませんでした'));
      im.src = url;
    });
    return imageToCanvas(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function imageToCanvas(img, maxDim = MAX_DIM) {
  const s = Math.min(1, maxDim / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const w = Math.max(1, Math.round((img.naturalWidth || img.width) * s));
  const h = Math.max(1, Math.round((img.naturalHeight || img.height) * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

/** canvas から輝度配列 (0-255) を作る */
function luminance(canvas) {
  const { width: w, height: h } = canvas;
  const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  }
  return lum;
}

/**
 * 照明ムラ補正: 紙の白さ（局所的な最大輝度）を背景として推定し、それで割って正規化する。
 * スマホで撮った写真の影やグラデーションを打ち消す。
 */
function flattenLighting(lum, w, h) {
  const cell = Math.max(8, Math.round(Math.max(w, h) / 60));
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const grid = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const gy = (y / cell) | 0;
    for (let x = 0; x < w; x++) {
      const gi = gy * gw + ((x / cell) | 0);
      const v = lum[y * w + x];
      if (v > grid[gi]) grid[gi] = v;
    }
  }
  // セル単位でさらに最大値フィルタ（太い壁の上でも背景を拾うため）→ 平滑化
  const maxed = boxFilter(grid, gw, gh, 2, 'max');
  const bg = boxFilter(maxed, gw, gh, 2, 'mean');
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1, Math.max(0, y / cell - 0.5));
    const y0 = fy | 0, y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1, Math.max(0, x / cell - 0.5));
      const x0 = fx | 0, x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
      const b =
        (bg[y0 * gw + x0] * (1 - tx) + bg[y0 * gw + x1] * tx) * (1 - ty) +
        (bg[y1 * gw + x0] * (1 - tx) + bg[y1 * gw + x1] * tx) * ty;
      out[y * w + x] = Math.min(255, (lum[y * w + x] / Math.max(b, 30)) * 255);
    }
  }
  return out;
}

function boxFilter(src, w, h, r, mode) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const pass = (a, b, horizontal) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = horizontal ? x + k : x;
          const yy = horizontal ? y : y + k;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const v = a[yy * w + xx];
          if (mode === 'max') { if (v > acc) acc = v; } else { acc += v; n++; }
        }
        b[y * w + x] = mode === 'max' ? acc : acc / n;
      }
    }
  };
  pass(src, tmp, true);
  pass(tmp, out, false);
  return out;
}

/**
 * 二値画像の正方形カーネル（半径 r、一辺 2r+1）による収縮/膨張。
 * 行・列ごとの累積和で O(画素数) で計算する。
 */
function morph(mask, w, h, r, erode) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const win = 2 * r + 1;
  const line = new Int32Array(Math.max(w, h) + 1);

  // 横方向
  for (let y = 0; y < h; y++) {
    const row = y * w;
    line[0] = 0;
    for (let x = 0; x < w; x++) line[x + 1] = line[x] + mask[row + x];
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - r), b = Math.min(w, x + r + 1);
      const cnt = line[b] - line[a];
      tmp[row + x] = erode ? (cnt === win ? 1 : 0) : (cnt > 0 ? 1 : 0);
    }
  }
  // 縦方向
  for (let x = 0; x < w; x++) {
    line[0] = 0;
    for (let y = 0; y < h; y++) line[y + 1] = line[y] + tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - r), b = Math.min(h, y + r + 1);
      const cnt = line[b] - line[a];
      out[y * w + x] = erode ? (cnt === win ? 1 : 0) : (cnt > 0 ? 1 : 0);
    }
  }
  return out;
}

/** 面積が minArea 未満の連結成分（8近傍）を消す */
function removeSmall(mask, w, h, minArea) {
  if (minArea <= 0) return mask;
  const out = mask.slice();
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const comp = new Int32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    if (!out[i] || seen[i]) continue;
    let sp = 0, n = 0;
    stack[sp++] = i;
    seen[i] = 1;
    while (sp) {
      const p = stack[--sp];
      comp[n++] = p;
      const px = p % w, py = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = py + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = px + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (out[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
        }
      }
    }
    if (n < minArea) for (let k = 0; k < n; k++) out[comp[k]] = 0;
  }
  return out;
}

/**
 * @param {HTMLCanvasElement} src
 * @param {{threshold:number, wall:number, speck:number, grow:number, invert:boolean, raw:boolean, flatten:boolean}} opt
 * @param {Float32Array} [lumCache] 同じ画像で何度も処理するときの輝度キャッシュ
 * @returns {Uint8Array} 1 = 壁
 */
function extractWalls(src, opt, lumCache) {
  const w = src.width, h = src.height;
  let lum = lumCache || luminance(src);
  if (opt.flatten) lum = flattenLighting(lum, w, h);

  let mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    const dark = lum[i] < opt.threshold;
    mask[i] = (opt.invert ? !dark : dark) ? 1 : 0;
  }
  if (opt.raw) return mask;

  const r = Math.floor(opt.wall / 2);
  mask = morph(mask, w, h, r, true);
  mask = morph(mask, w, h, r, false);
  mask = removeSmall(mask, w, h, opt.speck);
  if (opt.grow > 0) mask = morph(mask, w, h, opt.grow, false);
  return mask;
}

/** マスクを「壁色・背景透明」の canvas に描く */
function maskToCanvas(mask, w, h, color = [52, 56, 64], target) {
  const c = target || document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (mask[i]) {
      d[p] = color[0];
      d[p + 1] = color[1];
      d[p + 2] = color[2];
      d[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
