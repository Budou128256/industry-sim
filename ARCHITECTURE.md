# 構造と責務の分担

指示書（工業シミュレーションWeb基盤）の §2 を、この環境の制約に合わせて具体化したもの。
**Phase 0 の成果物。コードの約束ごとを先に決めておくためのメモ。**

## 決定事項（2026-10-05）

| 項目 | 決定 | 理由 |
|---|---|---|
| 言語 | **素のJavaScript（ESモジュール）** | この環境に Node.js / npm が無く、TypeScript をビルドできない。構造は指示書どおりに保ち、Node を入れた時点で型を足して移行できるようにする |
| 置き場所 | `my-application/`（git 管理下） | 新規に作る。履歴を残す |
| 既存ツール | `../corekeeper_layout/` は**今の場所のまま・機能も維持** | 壊さない。資産として参照し、移植は段階的に行う |

## 責務の分担

```
my-application/
├─ index.html            画面の骨組み（DOMはUIだけ。盤面は Canvas）
├─ serve.py              開発用の小さなサーバ（ESモジュールは file:// で動かないため）
├─ data/                 ★ データ駆動。ここを足すだけで中身が増える
│   ├─ items/            アイテム定義
│   ├─ buildings/        建物定義（大きさ・能力）
│   └─ recipes/          レシピ定義
└─ src/
    ├─ core/             ★ ゲームの状態と規則。描画もDOMも知らない
    │   ├─ registry.js   データの読み込みと id 引き
    │   ├─ grid.js       座標・近傍・範囲（後で Chunk に拡張する）
    │   ├─ world.js      World（grid + buildings）。状態の持ち主
    │   └─ placement.js  置ける/置けないの判定、設置・撤去・回転
    ├─ render/
    │   └─ renderer.js   World を**読むだけ**。Canvas に描く
    ├─ input/
    │   └─ input.js      入力を**コマンド**に変える。World を直接書き換えない
    └─ app.js            配線（UI・Input・Renderer・World をつなぐ）
```

### 守る約束

1. **core は描画もDOMも知らない。** `document` や `canvas` を core から触らない。
   これを守ると、あとで core をそのまま Web Worker に移せる（Phase 5）。
2. **renderer は World を書き換えない。** 読むだけ。
3. **input は World を直接書き換えない。** 「何をしたいか」をコマンドとして出し、
   app がそれを core に渡す。あとで取り消し（undo）や記録を足しやすくする。
4. **ゲームの中身はコードに埋めない。** アイテム・建物・レシピは `data/` の JSON。
   新しい鉱石や機械は**ファイルを足すだけ**で増やせる状態を保つ。
5. **各段階の終わりで必ず動く。** 画面を開けば操作できる状態を壊さない。

## 既存コード（`../corekeeper_layout/`）の扱い

指示書 §16 の分類。**この段階では移動も削除もしない。**

| 分類 | 対象 | 扱い |
|---|---|---|
| 再利用 | `static/sim.js`（Tickシミュレータ 887行） | Phase 2〜3 で core の Simulation として作り直すときの**一次資料**。規則はここに実装済み |
| 再利用 | `static/draw.js`（Canvas描画 427行） | renderer の参考。部品ごとの描き分け・向き・アイコン |
| 再利用 | `data/*.json`（機械・レシピ・アイテム・挙動） | データ駆動の原型。新しい `data/` の形を決めるときの見本 |
| 再利用 | `ck/model.py` / `ck/validate.py` | World / 検証の考え方 |
| 分割が要る | `static/app.js`（1,261行） | UI・入力・描画・シミュレータ駆動・通信が同居。新しい構造では4つに分かれる |
| 作り直し | シミュレータが Main Thread / World が配列 | Phase 5 で Worker と Chunk へ |
| 廃止 | 無し | Core Keeper 固有の生成器（串型・バス型）は、将来 `apps/corekeeper/` としてこの基盤の上に乗せる |

## 段階ごとの到達点

| Phase | 入るもの | 終わったときに出来ること |
|---|---|---|
| 1 | Grid / Building / Item / Placement | 盤面に建物を置ける・消せる・回せる。中身は data/ の JSON |
| 2 | Belt / Inserter / アイテム搬送 | 置いたベルトの上をアイテムが流れる |
| 3 | Recipe / Machine / Production | 機械が材料を食べて製品を出す |
| 4 | Power / Fluid / Storage | 電力網・液体・保管 |
| 5 | Chunk / 最適化 / Web Worker | 大きなマップでも重くならない |
| 6 | 保存・読込 / API | ワールドと設計図をサーバに保存 |
| 7 | 高度な物流 / 研究 / AI | — |
