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
my-application/          （手元のフォルダ名。GitHub では industry-sim）
├─ index.html            画面の骨組み（DOMはUIだけ。盤面は Canvas）
├─ tests.html / bench.html  テストと速さの測定のページ
├─ serve.py              開発用の小さなサーバ（ESモジュールは file:// で動かないため）
├─ data/                 ★ データ駆動。ここを足すだけで中身が増える
│   ├─ items/            アイテム定義
│   ├─ buildings/        建物定義（大きさ・能力）
│   └─ recipes/          レシピ定義
└─ src/
    ├─ core/             ★ ゲームの状態と規則。描画もDOMも知らない
    │   ├─ registry.js   データの読み込みと id 引き
    │   ├─ grid.js       座標・近傍・範囲・マスの鍵（数値）
    │   ├─ chunks.js     32x32 の区画でマスごとの値を持つ（World の層の入れ物）
    │   ├─ world.js      World（grid + buildings）。状態の持ち主。物の層・床の層（電線）・鉱脈をチャンクで持ち、変更を記録する
    │   ├─ placement.js  置ける/置けないの判定、設置・撤去・回転、ドラッグで通った道どおりに置く
    │   ├─ sim.js        時間と中身（ベルト・箱・炉・採掘機・床）。World の変更には sync() で追いつく（変更の記録を読み、変わった所の近くだけ計算し直す）
    │   ├─ belt.js       ベルトの線
    │   ├─ history.js    元に戻す / やり直す（置き方の変更を記録して逆に当てる）
    │   ├─ blueprint.js  設計図（範囲を写す・回す・反転・貼る・上書き・まとめて移動。Phase 7b / 7c）
    │   ├─ splitter.js   スプリッター（ベルトの分岐。Phase 7）
    │   ├─ inserter.js   アーム
    │   ├─ inventory.js  スロットとスタックの列
    │   ├─ machine.js    加工機
    │   ├─ miner.js      採掘機（鉱脈は world.resources）
    │   ├─ snapshot.js   画面に映る範囲の写し（Worker から画面へ送る）
    │   ├─ save.js       セーブデータの形（Phase 6）
    │   └─ power.js      電力網（電線は world の床の層）
    ├─ worker/
    │   ├─ worker.js     Web Worker の入口（Phase 5b）
    │   └─ engine.js     World と Sim を持ち、命令を実行して時間を進める
    ├─ client.js         画面から Engine を呼ぶ窓口（Worker が使えなければ同じスレッドで動かす）
    ├─ storage.js        ブラウザの中（IndexedDB）への保存
    ├─ render/
    │   ├─ renderer.js   World（の写し）を**読むだけ**。Canvas に描く
    │   └─ view.js       Worker から届いた写しを World / Sim と同じ形に戻す
    ├─ input/
    │   └─ input.js      入力を**コマンド**に変える。World を直接書き換えない
    ├─ app.js            配線（UI・Input・Renderer・client をつなぐ。World には直接触らない）
    ├─ tests.js          core の自動テスト
    └─ bench.js          速さの測定
```

### 守る約束

1. **core は描画もDOMも知らない。** `document` や `canvas` を core から触らない。
   これを守ったので、core をそのまま Web Worker に移せた（Phase 5b）。
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
| 作り直し | シミュレータが Main Thread / World が配列 | Phase 5 で済み（5a Chunk、5b Worker） |
| 廃止 | 無し | Core Keeper 固有の生成器（串型・バス型）は、将来 `apps/corekeeper/` としてこの基盤の上に乗せる |

## 段階ごとの到達点

| Phase | 入るもの | 終わったときに出来ること |
|---|---|---|
| 1 | Grid / Building / Item / Placement | 盤面に建物を置ける・消せる・回せる。中身は data/ の JSON |
| 2 | Belt / Inserter / アイテム搬送 | 置いたベルトの上をアイテムが流れる |
| 3 | Recipe / Machine / Production | 機械が材料を食べて製品を出す |
| 4 | Power（Fluid / Storage は未定） | 発電機から電線で電気が届き、届かない機械は止まる |
| 5 | Chunk / 最適化 / Web Worker | 大きなマップでも重くならない |
| 6 | 保存・読込 / API | 6a: ブラウザの中とファイルに保存（済み）。6b: サーバに保存（必要になったら） |
| 7 | 高度な物流 / 研究 / AI | — |
