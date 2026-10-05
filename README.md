# 工業シミュレーション基盤

ブラウザで動く、汎用の工業シミュレーション基盤。
特定のゲームの複製ではなく、**データ（`data/` の JSON）を足すだけで中身が増える土台**を作ることが目的。

段階的に作っており、現在は **Phase 1（Grid / Building / Item / Placement）** まで。
進行状況と次にやることは [PLAN.md](PLAN.md)、設計の約束は [ARCHITECTURE.md](ARCHITECTURE.md) にあります。

## 動かす

Node.js は使いません。Python 3 があれば動きます。

```
py -3 serve.py
```

→ http://127.0.0.1:8080/ （テストは http://127.0.0.1:8080/tests.html ）

ES モジュール（`import` / `export`）は `file://` では読み込めないため、
標準ライブラリだけの小さな HTTP サーバ（`serve.py`）経由で開きます。

## 操作

| 操作 | 動き |
|---|---|
| 左クリック | 設置（押したままドラッグで連続設置） |
| 右クリック | 撤去 |
| R | 回転（カーソルの下の建物 / 何も無ければ次に置く向き） |
| ホイール | 拡大縮小 |
| Shift + ドラッグ | 画面を動かす |
| Esc | 選択を解除 |

## 構成

```
index.html        画面
serve.py          開発用サーバ（標準ライブラリのみ）
tests.html        テストの実行ページ
data/             中身の定義（items / buildings / recipes）。index.json が目録
src/
  core/           盤面の論理。DOM も描画も知らない
    registry.js   data/ を読んで定義を保持する
    grid.js       座標・向き・大きさ
    world.js      建物の集合と占有マス。保存/復元
    placement.js  置ける/置けないの判定、設置・撤去・回転・線引き
  render/         World を読んで描くだけ
  input/          入力をコマンドに変えるだけ（World は触らない）
  app.js          上記をつなぐ唯一の層
  tests.js        core の自動テスト
```

守っている約束（詳細は ARCHITECTURE.md）:

- `src/core/` は DOM も描画も知らない。あとで Web Worker へ移せるようにしておく
- 描画は World を読むだけ、入力はコマンドを出すだけ
- ゲームの中身はコードに埋めず `data/` に置く
- どの段階でも動く状態を保つ

## テスト

Node が無いのでブラウザで走らせます。`tests.html` を開くと core のテスト（19 件）が走ります。

## 予定

Phase 2 以降で搬送（ベルト / インサータ）、生産、電力、チャンク、Web Worker、保存へ進みます。
