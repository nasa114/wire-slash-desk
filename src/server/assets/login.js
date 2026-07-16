// ログイン画面専用: 認証失敗時にアラートを出す。
// 文言はサーバー側が data-login-alert に埋め込む(ユーザー名/パスワードの
// どちらが誤りかを判別できない文言のみ — ユーザー列挙対策)。
// CSP script-src 'self' に適合させるため外部ファイルとして配信する。
document.addEventListener('DOMContentLoaded', function () {
  var el = document.querySelector('[data-login-alert]');
  if (el !== null) {
    window.alert(el.getAttribute('data-login-alert'));
  }
});
