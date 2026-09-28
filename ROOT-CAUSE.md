# 原因調査・再実装・検証記録

対象: ChatGPT Navigator + Stay v2.0.3 → v3.0.0  
調査日: 2026-09-28

## 結論と確度

**確定した欠陥:** v2.0.3はスクロール位置が常に非負であると仮定している。下端が0、上方向が負の値になる領域では、合法な移動先を0へ丸めるため、拡張自身が最下部を指定する。さらに、Follow中にも起動される移動先の保持処理が、負の位置へ動かした後も0を再指定する。

**未確認:** 利用者のログイン済みChatGPTのスクロール領域がこの方式か、追加の干渉要因があるか。利用者の画面を直接検査していないため、この欠陥が実環境の唯一の原因とは断定しない。

## 1. 旧コードの問題

提供済み `chatgpt-nav-extension-v2.0.3.zip` を読み直した。該当 `content.js` は次の箇所で座標を0以上へ制限している。

| 箇所 | 旧ファイル行 | 問題 |
|---|---:|---|
| `setScrollTop` | 375 | `clamp(top, 0, scrollHeight - clientHeight)` |
| `centerElementInScroller` | 701 | `clamp(before + delta, 0, max)` |
| `targetScrollTopForPrompt` | 785 | `clamp(target, 0, max)` |
| `rawSetScrollerTop` | 792 | `clamp(top, 0, max)` |
| `scrollToPrompt` | 930 | Stay/Followに関係なく `startNavigationHold(prompt)` を実行 |

したがって、例えば正しい移動先が `-4234` の場合、前4箇所のような計算では0になる。下端基準では0が最下部であり、これはChatGPT側によるスクロールが一切なくても発生する。

以前の「ChatGPT側が継続的に最下部へ戻す」模擬テストは、その動きが原因だと先に仮定した検証だった。通常の非負スクロール領域だけでは、根本の座標系の誤りを検出できていなかった。

## 2. ブラウザの仕様と公開実装

MDNは `flex-direction: column-reverse` のような構成について、最下部が0で上へ移動するほど `scrollTop` が負になると説明している。CSSOM Viewの要素スクロール手順にも、上方向へあふれる領域に対して負の値を許容する境界処理が定義されている。

- MDN, Element.scrollTop: https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollTop
- CSSOM View Module Level 1, “To scroll an element”: https://drafts.csswg.org/cssom-view/#scroll-an-element

調査時に取得したChatGPT Exporter 2.36.3の公開ソースにも、`[data-app-action-timeline-scroll]` を扱い、負の `scrollTop` を検出して座標変換する `createScrollPosition` があった。これはChatGPT向けツールが負の座標系を考慮しているという補助証拠であり、利用者全員のDOM構造を確認した証拠ではない。v3にこの第三者ソースを複製・同梱していない。

- 作者公開ソース: https://greasyfork.org/en/scripts/456055-chatgpt-exporter/code

## 3. ChatGPTのコードを入れない比較再現

`tests/compare_v203.py` で、20個の質問・各300pxのターン・高さ700pxのスクロール領域を用意した。通常構成と `column-reverse` 構成のそれぞれに旧版と新版を隔離実行環境で読み込み、5番目の質問をクリックした。ChatGPTのコードや強制的に最下部へ戻すページ側処理は入れていない。

ブラウザ: Chromium 144.0.7559.96。以下はこの疑似ページでの測定値であり、利用者の実画面の測定値ではない。

| 領域 | 版 | クリック後のscrollTop | 対象上端（領域内px） | 結果 |
|---|---|---:|---:|---|
| 通常・上端基準 | v2.0.3 | 882 | 338 | 表示範囲内 |
| 通常・上端基準 | v3.0.0 | 1066 | 154 | 表示範囲内 |
| 下端基準 | v2.0.3 | 0 | -4080 | 最下部のまま・対象は画面外 |
| 下端基準 | v3.0.0 | -4234 | 154 | 対象へ移動 |

さらに下端基準のケースで、テスト側から `scrollTop = -1000` を1回だけ設定し、300ms後を観測した。

| 版 | 設定直後に要求した値 | 300ms後 |
|---|---:|---:|
| v2.0.3 | -1000 | 0 |
| v3.0.0（Follow） | -1000 | -1000 |

旧版のみが自分で最下部に戻すことを確認した。記録: [v203-v3-comparison.json](tests/v203-v3-comparison.json)。

## 4. v3の修正

座標計算の中心は次の形とした。

```js
const requested = root.scrollTop
  + target.getBoundingClientRect().top
  - viewportTop
  - desiredScreenOffset;
root.scrollTo({ top: requested, behavior: 'instant' });
```

負の座標を絶対値化したり0以上に制限したりしない。実際の移動可能範囲への制限はブラウザに任せる。下端基準かどうかを事前に試し書きして検出する必要もない。

Followでは通常の移動は原則1回。移動直後に対象の内容上の位置が変わったときだけ、短い期間に最大2回補正する。スクロールだけで対象の内容上の位置は変化しないので、単なるページ側スクロールと競り合わない。無期限の移動先固定を廃止した。

Stayは別の明示的な機能にし、要素の画面上の位置を符号付き計算で保持する。手動操作後は新しい位置へ更新する。Followに戻すと保持処理を停止する。レイアウト変化でなく頻繁な位置競合が続いた場合は自動的にFollowへ戻して通知する。

ページ側のスクロールAPI、プロトタイプ、React内部状態は変更しない。異常が残った場合は、返された位置とレイアウトの観測結果を収集し、実画面の計測なしに別の原因を決めつけない。

## 5. 回帰検証

`tests/browser_tests.py` の3グループで **84/84チェック** が通過した。84種類の実環境をテストしたという意味ではなく、疑似DOM上の検証条件・アサーションの合計である。

| グループ | 成功/チェック数 | 主な範囲 |
|---|---:|---|
| navigation | 56/56 | 通常／下端基準／document／hidden fallback／マーカーなし／旧マーカー、目次・前後移動、Followの非固定、診断の秘匿性、API差し替えなし |
| stay | 16/16 | 上下での高さ変化、連続的な回答伸長、手動ホイール、保持と解除、連続移動 |
| extra | 12/12 | 負の小数座標、ブラウザによる境界処理、一時的な子要素の消失、外枠の削除・新規追加、0高さ、入れ子、実レイアウト変化への限定補正 |

生の結果は `tests/results-navigation.json`、`tests/results-stay.json`、`tests/results-extra.json` に同梱した。ページ側に公開されない隔離実行環境でテストした。スクリーンショットも確認した。

### 未検証の範囲

利用者の実際のChatGPT画面、実Chromeへの拡張インストール、実Chrome storage API、ログイン済みSPA上の会話切り替えはこのテストに含まれない。完全にDOMから消えた過去履歴の取得は実装していない。診断もページ側スクリプトの呼び出し元を記録するものではない。

## 6. 実環境で残った場合の切り分け

Followで移動し、約2秒後に「診断をコピー」を実行する。`model.originEvidence`、`scrollTop`、`writes[].requested/actual`、`samples[].geometry` を比較する。

負の座標が確認できれば、この座標系が実環境にも適用されている。要求値が反映された直後に対象が画面外へ戻る場合は、次に別のスクロール変更・DOM差し替え・高さ変化などを切り分ける。これらは診断値に基づいて判断し、原因を事前に決めない。
