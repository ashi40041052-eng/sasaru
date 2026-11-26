# ササル

公開 URL: https://ashi40041052-eng.github.io/sasaru/ (リポジトリ: github.com/ashi40041052-eng/sasaru、GitHub Pages)

刺さった名言・名シーンのスクショを入れて、TikTok のように縦スワイプで見返す iPhone 用 Web アプリ(PWA)。
外部ライブラリなし。データは各端末の IndexedDB にだけ保存される(サーバーなし)。

## できること
- 写真アプリから何枚でも一度に追加(100枚で約20秒)。同じスクショは自動で飛ばす。追加時にまとめてタグ
- 縦スワイプのフィード。シャッフルは「見た回数が少ない物」を優先して出す。新しい順・古い順も
- ダブルタップで ♥(刺さる)、タップで表示を消して画像だけに
- メモ(なぜ刺さったか)を字幕のように表示、タグと絞り込み(♥ / メモあり / タグなし / 各タグ)
- 自動めくり(5・10・20秒)、縦長スクショの拡大表示、共有、削除
- 一覧(3列)から複数選んでタグ・♥・削除
- バックアップ zip の書き出しと戻し(機種変更用)

## ファイル
- `index.html` `style.css` `app.js` 本体 / `sw.js` オフライン用 / `manifest.webmanifest` `icons/`
- `tools/selftest.cjs` 自動テスト(100枚取り込み〜バックアップ往復の17項目)
  `NODE_PATH=~/claudecode/jev-tools/jev-voice-browser/node_modules node tools/selftest.cjs`
- `tools/make-icons.cjs` アイコン作り直し(同じ NODE_PATH で)
- `tools/try-local.sh` 同じ Wi-Fi の iPhone ですぐ試す(http なのでオフライン不可・Mac が必要)
- `tools/publish.sh` GitHub Pages に公開して https の URL を作る(本人の指示があった時だけ)

## iPhone に入れる
1. https の URL を Safari で開く
2. 共有ボタン →「ホーム画面に追加」
3. ホームのアイコンから開いて「＋」でスクショを選ぶ

## 更新する時
1. `sw.js` の `V` の数字を上げる
2. `tools/selftest.cjs` を流す
3. `git commit` して `git push`(1〜2分で反映)→ `tools/livecheck.cjs` で公開版を確認

`tools/` は公開しない(.gitignore)。コミットのメールは GitHub の noreply を使う(このリポジトリだけ設定済み)。

## セキュリティ(2026-11-26 点検)
- 外部通信なし・外部スクリプトなし。CSP で自分のファイル以外のスクリプトを止めている
- 表示する文字はすべてエスケープ。バックアップ zip から戻す時は id・数値・タグの形を確かめてから入れる(selftest に細工 zip のテストあり)
- 画像は各端末の IndexedDB だけ。公開しているのはアプリの部品だけ
