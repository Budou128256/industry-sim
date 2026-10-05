# 工業シミュレーションWeb基盤 — 進行計画

ユーザーの指示書（2026-10-05 提示）に沿って**段階開発**する。
各段階で「分析 → 構造の説明 → 変更の提案 → 影響範囲 → 実装 → テスト → 報告」を行う。
**独断で大規模リファクタリング・ファイル削除をしない。要件が曖昧なら確認する。**
各段階の終わりで必ず「動く状態」を保つ。

---

## 現在の状態

| 項目 | 状態 |
|---|---|
| 段階 | **Phase 1 完了 → 次は Phase 2（Belt / 搬送 / Inserter）** |
| 置き場所 | `Desktop/drive-download-20260614T075216Z-3-001/my-application/`（**git 管理下**・ブランチ main） |
| remote | `origin` = https://github.com/Budou128256/industry-sim （**Private**）。以後は `git push` で上がる |
| 済んだこと | 環境調査 / 既存コードの分類 / git init / Phase 0（決定と ARCHITECTURE.md）/ **Phase 1（置く・消す・回す・連続設置）** / GitHub へ push |
| 次の作業 | Phase 2 の実装（下の「次にやること」） |
| 動かし方 | `py -3 serve.py` → http://127.0.0.1:8080/ （テストは `/tests.html`） |

---

## 環境（2026-10-05 実測）

| 項目 | 結果 | 影響 |
|---|---|---|
| Node.js / npm | **無し**（`node: command not found`） | **TypeScript をビルドできない。npm も使えない** |
| Python | 3.14.5 ✓ | シミュレータ・サーバ側は問題なし |
| pip | 26.1.1 ✓（ネット接続可） | 追加のライブラリは `py -3 -m pip install` で入る見込み |
| git | 2.54.0 ✓ | `my-application/` は git 管理下。`corekeeper_layout/` は管理外のまま |
| gh (GitHub CLI) | 2.102.0 ✓ | winget で導入。`Budou128256` で認証済み（scopes: repo / read:org / gist） |
| 資格情報の注意 | **2系統ある** | Windows の資格情報マネージャは停止済みの別アカウント `greap-lmkn` を返すため、このリポジトリのローカル設定で `credential.https://github.com.helper` を `gh auth git-credential` に向けている。**別の場所に clone したら同じ設定が必要**（無いと push が 403） |

---

## 決定事項（2026-10-05 すべて確定）

| 項目 | 決定 |
|---|---|
| 言語 | **素のJavaScript（ESモジュール）**。Node が無く TS をビルドできないため。構造は指示書どおり |
| 置き場所 | **`my-application/`**（git 管理下・ブランチ main） |
| 既存ツール | `../corekeeper_layout/` は**今の場所のまま・機能も維持**。移動も削除もしない |

詳しい責務の分担は [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 段階（指示書の Phase に対応）

- [x] **Phase 0** 準備: git init ✓ / 責務分離の設計メモ（ARCHITECTURE.md）✓ / 決定事項の確定 ✓
- [x] **Phase 1** Grid / Building / Item / Placement ✓ 2026-10-05（テスト19件すべて成功）
- [ ] **Phase 2** Belt / Item transportation / Inserter
- [ ] **Phase 3** Recipe / Machine / Production
- [ ] **Phase 4** Power / Fluid / Storage
- [ ] **Phase 5** Chunk / 最適化 / Web Worker
- [ ] **Phase 6** Save・Load / User / API
- [ ] **Phase 7** Advanced logistics / Research / AI / Multiplayer

---

## 既存コードの扱い（指示書 §16 の分類）

対象: `corekeeper_layout/`（合計 5,590 行）

### 再利用可能（そのまま core の土台になる）

| ファイル | 行 | 役割 | core での位置 |
|---|---|---|---|
| `static/sim.js` | 887 | Tick シミュレータ（20tick/秒。ベルト・アーム・加工機・電力・回路） | Simulation |
| `static/draw.js` | 427 | Canvas 描画（部品ごとの絵・アイコン・向き） | Renderer |
| `data/*.json` | — | 機械・レシピ・アイテム・**挙動** の定義 | Data Driven の原型 |
| `ck/model.py` | 187 | グリッドと配置物のモデル | World / Grid |
| `ck/validate.py` | 222 | 重なり・給電・物流の連結の検査 | 検証（core の不変条件） |

### 移すべき（責務が混ざっている）

| ファイル | 行 | 問題 |
|---|---|---|
| `static/app.js` | 1,261 | UI・入力・描画呼び出し・シミュレータ駆動・サーバ通信を1ファイルで抱えている → UI / Input / Renderer / Sim driver に分割 |

### 修正すべき

- シミュレータが **Main Thread** で動いている → Web Worker へ（Phase 5）
- World が「placements の配列」だけ → Grid / Chunk 構造へ（Phase 5）
- ベルトのアイテムが「配列の配列」→ 大規模化に備えたライン表現へ（Phase 2）
- Core Keeper 固有の挙動（アームは正面1マス等）が core に混ざらないよう、**アプリ層／データへ分離**

### 廃止すべき

- 現時点で無し。Core Keeper 固有の生成器（`ck/solver.py` の串型・バス型）は
  **core の上に乗るアプリ**として残す。

---

## 次にやること（次セッションの開始手順）

1. この `PLAN.md` と [ARCHITECTURE.md](ARCHITECTURE.md) を読む
2. `py -3 serve.py` で動かし、`/tests.html` が全部成功することを確かめる（いまの状態の確認）
3. Phase 2 を実装する（**実装前に方針を説明して合意を取る**）:
   - `src/core/belt.js` — ベルト1本を「線」として持つ表現（DOM要素は作らない）
   - `src/core/inserter.js` — 正面から取り背面へ置く
   - `src/core/sim.js` — Tick（入力 → 物流 → 生産 → … の順で回す骨組み）
   - 参考: `../corekeeper_layout/static/sim.js`（同じ規則が実装済み。読み替えの一次資料）
4. テストを足す（ベルトの搬送・詰まり・分岐）
5. この表と段階チェックを更新してコミットし、`git push` で GitHub へ上げる

## Phase 1 でできること（2026-10-05 時点）

- 左の一覧から建物を選び、盤面に**置く・ドラッグで連続設置・右クリックで撤去・R で回転**
- 2x2 の建物の重なり判定、盤面外の拒否、回すと入らない場所での巻き戻し
- ホイールで拡大縮小、Shift+ドラッグで移動
- 建物・アイテム・レシピは `data/` の JSON。**ファイルを足すだけで増える**
- `World.toJSON()` / `fromJSON()` で保存・復元の形が用意してある（Phase 6 で使う）

## 関連

- `corekeeper_layout/CLAUDE.md` — 既存ツールの作業ルール（py -3、サーバ再起動、挙動の一次資料）
- `corekeeper_layout/MECHANICS.md` — Core Keeper の部品の挙動（アプリ層の仕様）
- `corekeeper_layout/patterns/README.md` — ユーザーが作った設計
