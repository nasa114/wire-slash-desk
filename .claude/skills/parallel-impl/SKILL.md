# /parallel-impl — 並列サブエージェント実装

フェーズ内のタスクを schema / domain / api / e2e の4レイヤーに分解し、
サブエージェントを並列起動して実装を進める。

## 使い方

引数にフェーズ番号またはタスク ID を指定する。例: `/parallel-impl P6`

## 手順

1. **計画確認**: `docs/task-breakdown/` から対象フェーズのタスクを読み込む
2. **レイヤー分解**: 各タスクを以下の4カテゴリに振り分ける
   - `schema`: Drizzle スキーマ・マイグレーション
   - `domain`: core/domain・core/usecase（TDD: Red → Green）
   - `api`: adapter/http ルーター・JSX View
   - `e2e`: Playwright テスト
3. **並列起動**: 依存関係のないカテゴリを `Agent` ツールで同時起動
   - schema → domain は直列（domain は schema に依存）
   - api と e2e は domain 完了後に並列起動可能
4. **統合確認**: 全エージェント完了後に `npm test && npm run test:e2e` を実行
5. **コミット**: グリーンを確認してから論理単位でコミット

## サブエージェント起動例

```
Agent(
  subagent_type="general-purpose",
  model="sonnet",
  prompt="[タスクID] の domain 層を TDD で実装してください。
  参照: CLAUDE.md / SPEC.md / docs/task-breakdown/<file>.md
  - Red（テスト先行）→ Green（実装）の順を守る
  - core 層に I/O を持ち込まない（Port/Fake を使う）
  - 完了したらテスト結果を報告する"
)
```

## 注意

- 各エージェントのプロンプトに CLAUDE.md / SPEC.md / 該当 task-breakdown へのリンクを必ず含める
- git worktree を使うと競合を避けられる（ブランチ名: `agent/<layer>-<phase>`）
- エージェントにコミットさせず、統合後に本体がコミットする方が安全
- **依存追加は親に差し戻す**: サブエージェントが新規 npm パッケージの追加・更新を必要と判断した場合、**自分では install せず**、必要パッケージと理由を親（本体）に報告すること。依存追加は親が `/secure-npm-install` 経由で実施する。PreToolUse hook で `npm install` 等はブロックされるため、エージェントがどう頑張っても `SECURE_NPM_INSTALL=1` prefix なしでは通らないが、判断の一元化のため明示する。エージェント起動プロンプトにもこの方針を含める
