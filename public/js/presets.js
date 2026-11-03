// 家具プリセット（サイズは cm、w = 幅, h = 奥行）。一般的な目安の寸法。
export const PRESET_CATEGORIES = [
  {
    name: '水回り・家電',
    items: [
      { label: '洗濯機', w: 60, h: 60, color: '#7fb3e6' },
      { label: 'ドラム式洗濯機', w: 64, h: 72, color: '#7fb3e6' },
      { label: '冷蔵庫（一人暮らし）', w: 55, h: 60, color: '#9ecbe0' },
      { label: '冷蔵庫（ファミリー）', w: 68, h: 70, color: '#9ecbe0' },
      { label: '電子レンジ', w: 50, h: 40, color: '#b8c6d6' },
      { label: '食器棚', w: 90, h: 45, color: '#c9a37a' },
      { label: 'レンジ台', w: 60, h: 45, color: '#c9a37a' },
      { label: 'ゴミ箱', w: 30, h: 40, color: '#a8b5a2' },
      { label: 'エアコン室外機', w: 80, h: 30, color: '#b0b0b0' },
    ],
  },
  {
    name: '寝室',
    items: [
      { label: 'シングルベッド', w: 100, h: 200, color: '#e8c3a0' },
      { label: 'セミダブルベッド', w: 120, h: 200, color: '#e8c3a0' },
      { label: 'ダブルベッド', w: 140, h: 200, color: '#e8c3a0' },
      { label: 'クイーンベッド', w: 160, h: 200, color: '#e8c3a0' },
      { label: '布団', w: 100, h: 210, color: '#f0dcc4' },
      { label: 'ベビーベッド', w: 75, h: 125, color: '#f3d1dc' },
      { label: 'ワードローブ', w: 90, h: 60, color: '#b98b63' },
      { label: 'チェスト', w: 80, h: 45, color: '#b98b63' },
      { label: 'ドレッサー', w: 80, h: 40, color: '#d4a98a' },
    ],
  },
  {
    name: 'リビング・ダイニング',
    items: [
      { label: '2人掛けソファ', w: 150, h: 85, color: '#8fb78a' },
      { label: '3人掛けソファ', w: 190, h: 90, color: '#8fb78a' },
      { label: 'ローテーブル', w: 100, h: 50, color: '#d2b48c' },
      { label: 'ダイニングテーブル(2人)', w: 75, h: 75, color: '#d2b48c' },
      { label: 'ダイニングテーブル(4人)', w: 135, h: 80, color: '#d2b48c' },
      { label: 'ダイニングチェア', w: 45, h: 50, color: '#c4a27c' },
      { label: 'テレビ台', w: 150, h: 40, color: '#8d7766' },
      { label: 'こたつ', w: 80, h: 80, color: '#d9a86c' },
      { label: 'ラグ', w: 140, h: 200, color: '#e6dccd', ignoreOverlap: true, opacity: 60 },
      { label: '丸テーブル', w: 80, h: 80, color: '#d2b48c', shape: 'ellipse' },
      { label: '観葉植物', w: 40, h: 40, color: '#6da86a', shape: 'ellipse' },
    ],
  },
  {
    name: '書斎・収納',
    items: [
      { label: 'デスク', w: 120, h: 60, color: '#a3a7c9' },
      { label: 'L字デスク', w: 140, h: 120, color: '#a3a7c9', shape: 'lshape' },
      { label: 'オフィスチェア', w: 60, h: 60, color: '#7b7f9e', shape: 'ellipse' },
      { label: '本棚', w: 80, h: 30, color: '#b98b63' },
      { label: 'カラーボックス', w: 42, h: 30, color: '#d6c2a8' },
      { label: '衣装ケース', w: 40, h: 70, color: '#d9dde3' },
      { label: 'ハンガーラック', w: 90, h: 45, color: '#9aa3ad' },
      { label: '段ボール', w: 40, h: 30, color: '#c8a46e' },
    ],
  },
  {
    name: '建具・その他',
    items: [
      { label: 'ドア', w: 80, h: 80, color: '#f4b860', shape: 'door', opacity: 45 },
      { label: '引き戸', w: 90, h: 8, color: '#f4b860' },
      { label: '柱', w: 30, h: 30, color: '#555b66' },
      { label: '自転車', w: 60, h: 180, color: '#9aa3ad' },
      { label: '動線（通路60cm）', w: 60, h: 200, color: '#ffe08a', ignoreOverlap: true, opacity: 40 },
    ],
  },
];

export const SHAPE_DEFAULTS = {
  rect: { label: '四角', w: 80, h: 60, color: '#9fb4d6' },
  ellipse: { label: '円', w: 60, h: 60, color: '#a8d0b0' },
  triangle: { label: '三角', w: 60, h: 60, color: '#d6b49f' },
  lshape: { label: 'L字', w: 120, h: 120, color: '#b9a3d6' },
  door: { label: 'ドア', w: 80, h: 80, color: '#f4b860', opacity: 45 },
  text: { label: 'テキスト', w: 80, h: 20, color: '#222222', ignoreOverlap: true },
};
