# /handoff — セッション引き継ぎドキュメント生成

コンテキストが枯渇しそうなとき、または作業を中断するときに実行する。
以下の内容を含む引き継ぎ文書を生成し `docs/handoffs/YYYY-MM-DD-handoff.md` に保存する。

## 出力する内容

1. **完了したタスク** — コミット SHA と Conventional Commits メッセージをリストアップ
2. **進行中の作業** — 現在どのファイルを触っていて、どこまで終わったか
3. **次のタスク** — フェーズ計画（`docs/task-breakdown/`）から次に着手すべき項目
4. **未解決の問題・ブロッカー** — テストが red のまま、環境の問題、設計上の疑問点
5. **環境上の注意点** — このセッションで遭遇した OOM / drizzle TTY / Playwright 依存 など
6. **依存変更ログ** — `/secure-npm-install` でセッション中に追加・更新したパッケージと、`inspect.sh` の検査結果（warn 件数・trust-tier 該当の有無・既知 CVE 件数）。次セッションで再検査・対応が必要なら明記

## 手順

1. `git log --oneline -20` でセッション中のコミットを確認
2. `npm test 2>&1 | tail -5` でテスト状態を確認
3. `git diff HEAD~10 -- package.json package-lock.json | head -50` で依存変更を確認（あれば項目 6 に記載）
4. 上記6項目を日本語で記述した Markdown を生成
5. `docs/handoffs/` ディレクトリがなければ作成して保存
6. 「引き継ぎ文書を `docs/handoffs/YYYY-MM-DD-handoff.md` に保存しました」と報告

## 注意

- コミットは**しない**（引き継ぎ文書は git 管理外でも可）
- 次セッションの冒頭でこのファイルを読むよう促す文を末尾に添える
