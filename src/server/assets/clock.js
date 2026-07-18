// 全ページ共通: マストヘッドの時刻・日付(JST)を動的に更新する。
// クライアントの OS 時計そのものは信頼せず、サーバーが data-epoch に埋め込んだ
// 描画時刻との差分(オフセット)で補正して表示する。hx-boost のページ遷移で
// data-epoch が新しくなるたびにオフセットを取り直す(=サーバー時刻へ再同期)。
// CSP script-src 'self' に適合させるため外部ファイルとして配信する。
(function () {
  var WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  var JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  var lastEpoch = null;
  var offset = 0;

  function tick() {
    var timeEl = document.querySelector('[data-clock="time"]');
    if (timeEl === null) return;
    var epoch = timeEl.getAttribute('data-epoch');
    if (epoch === null) return;
    if (epoch !== lastEpoch) {
      lastEpoch = epoch;
      offset = Number(epoch) - Date.now();
    }
    // サーバー側 views.ts の toJstClock と同じ「UTC+9 シフト + UTC フィールド読み」方式。
    var j = new Date(Date.now() + offset + JST_OFFSET_MS);
    timeEl.textContent = j.toISOString().slice(11, 16);
    var dateEl = document.querySelector('[data-clock="date"]');
    if (dateEl !== null) {
      dateEl.textContent =
        j.getUTCFullYear() +
        '年' +
        (j.getUTCMonth() + 1) +
        '月' +
        j.getUTCDate() +
        '日(' +
        WEEKDAYS[j.getUTCDay()] +
        ')';
    }
  }

  document.addEventListener('DOMContentLoaded', tick);
  setInterval(tick, 10 * 1000);
})();
