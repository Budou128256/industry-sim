# 工業シミュレーションWeb基盤 — 進行計画

ユーザーの指示書（2026-10-05 提示）に沿って**段階開発**する。
各段階で「分析 → 構造の説明 → 変更の提案 → 影響範囲 → 実装 → テスト → 報告」を行う。
**独断で大規模リファクタリング・ファイル削除をしない。要件が曖昧なら確認する。**
各段階の終わりで必ず「動く状態」を保つ。

---

## 現在の状態

| 項目 | 状態 |
|---|---|
| 段階 | **Phase 0（準備・合意形成）** |
| 直近の作業 | 環境調査とコードベース分析を実施。**実装は未着手** |
| 次の作業 | 下の「次にやること」を参照。**4つの決定待ち** |

---

## 環境（2026-10-05 実測）

| 項目 | 結果 | 影響 |
|---|---|---|
| Node.js / npm | **無し**（`node: command not found`） | **TypeScript をビルドできない。npm も使えない** |
| Python | 3.14.5 ✓ | シミュレータ・サーバ側は問題なし |
| pip | 26.1.1 ✓（ネット接続可） | Django は `py -3 -m pip install django` で入る見込み |
| Django | 未インストール | Phase 6 まで不要 |
| git | 2.54.0 ✓ | ただし**プロジェクトは git 管理外**（履歴が無い） |

---

## 決定待ち（これが決まるまで実装に入らない）

1. **TypeScript を使うか**
   - A: Node.js を入れてもらう（本人が nodejs.org の LTS を入れる。私からは入れない）
   - B: 素のJS + ES モジュールで、**構造だけ指示書どおり**にする（ビルド不要・今すぐ動く）
2. **Django をいま入れるか**（Phase 6 まで不要という理解で合っているか）
3. **作る場所**
   - A: 新規 `industry_sim/` を作り、Core Keeper ツールはその上のアプリとして移植
   - B: `corekeeper_layout/` を土台に作り替える
4. **いまの Core Keeper 機能（探索・パターン集・MECHANICS・シミュレータ）を維持したまま進めるか**

---

## 段階（指示書の Phase に対応）

- [ ] **Phase 0** 準備: git init、責務分離の設計メモ、決定事項の確定
- [ ] **Phase 1** Grid / Building / Item / Placement（データ駆動の core を切り出す）
- [ ] **Phase 2** Belt / Item transportation / Inserter
- [ ] **Phase 3** Recipe / Machine / Production
- [ ] **Phase 4** Power / Fluid / Storage
- [ ] **Phase 5** Chunk / 最適化 / Web Worker
- [ ] **Phase 6** Django / Save・Load / User / API
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

1. この `PLAN.md` を読む
2. 「決定待ち」の4点をユーザーに確認する（未確定なら実装に入らない）
3. 決まったら Phase 0 を実施:
   - `git init` して現状を1コミット目にする（安全網）
   - `core/` と `apps/corekeeper/` の責務分離メモを書く（コードはまだ動かさない）
4. 各段階の終わりに、この表の「現在の状態」と段階チェックを更新する

## 関連

- `corekeeper_layout/CLAUDE.md` — 既存ツールの作業ルール（py -3、サーバ再起動、挙動の一次資料）
- `corekeeper_layout/MECHANICS.md` — Core Keeper の部品の挙動（アプリ層の仕様）
- `corekeeper_layout/patterns/README.md` — ユーザーが作った設計
