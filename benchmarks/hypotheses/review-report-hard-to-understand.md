# レビュー結果が読者の判断を助けなかった原因

## Observation

- Source observation: `benchmarks/observations/review-report-hard-to-understand.md`
- Failure summary: 内容は正しかったが、重要度の違いと問題同士の関係が見えず、内部用語が多いため、読者が何から直すか判断しにくかった。
- Why it matters: 正しい指摘でも理解と行動につながらなければ、レビュー結果として十分に機能しない。

## Competing hypotheses

### H1: 発見した単位をそのまま報告した

- Mechanism: reviewerが見つけた6件を、読者が一度に判断できる2〜3個の問題へまとめ直さず、そのまま列挙した。
- Prediction if true: 文字数と専門用語をほぼ変えなくても、結論、重要な問題、各問題の理由と修正を近くに置くだけで理解しやすくなる。
- Evidence against: 構造だけを変えても改善せず、用語を平易にした場合だけ改善するなら、主因は別にある。

### H2: 読者が知っている言葉を多く見積もった

- Mechanism: agentが内部で使う分類語を、読者も同じ意味で理解できる前提で説明なしに使った。
- Prediction if true: 構造と文字数を保ったまま、行動判断に不要な内部用語を普通の言葉へ置き換え、必要な専門用語だけ短く説明すると改善する。
- Evidence against: 用語を変えなくても構造変更だけで十分に改善するなら、語彙は主因ではない。

### H3: 短くすることを優先しすぎた

- Mechanism: 簡潔さを重視する過程で、問題と理由をつなぐ説明や、指摘同士の関係を省いた。
- Prediction if true: 構造と用語を保ったまま必要な接続説明だけを戻すと改善する。単純にさらに短くすると悪化する。
- Evidence against: 元の文字数を保った構造変更だけで改善するなら、短さそのものは主因ではない。

### H4: Reviewの出力形式が列挙を促した

- Mechanism: `review`は重大度順の指摘一覧を要求するが、関連する指摘をまとめ、各問題の理由と修正を一緒に示す手順を要求していない。
- Prediction if true: 同じmodelでも、通常のレビュー形式より、意思決定向けの形式を指定した条件で改善する。
- Evidence against: 出力形式を変えても同じ列挙になるなら、形式だけでは説明できない。

### H5: Subagent結果を人間向けに翻訳しなかった

- Mechanism: subagentが返した分類と用語を、main agentが読者向けにまとめ直さず転記した。
- Prediction if true: 単一agentの報告より、subagent結果を統合する条件で失敗が増える。統合前に読者向けの再構成を要求すると改善する。
- Evidence against: 単一agentでも同じ程度に内部用語を列挙するなら、handoffだけが原因ではない。

### H6: Model固有の文章傾向

- Mechanism: 特定modelまたはreasoning設定が、多くの概念を短い専門語へ置き換え、情報を同じ重さで圧縮する傾向を持つ。
- Prediction if true: 入力、出力形式、skill、文章量を固定しmodelだけを変えたとき、理解しやすさが変わる。
- Evidence against: model差より構造や用語の変更で結果が変わるなら、model routingだけでは解決しない。

## Discriminating eval

- Start state: 元の読みにくいレビュー、同じ意味を保った書き直し、対象となった指摘の原文を匿名化して固定する。
- Task: レビュー結果を、読者が修正順を判断できる報告へまとめる。
- Keep fixed: 内容、model、reasoning、tool権限、最大文字数。
- Change only:
  1. 構造だけを「結論→重要な問題→各問題の理由と修正」へ変える。
  2. 構造を戻し、内部用語だけを平易な言葉へ変える。
  3. 構造と用語を固定し、接続説明の量だけを変える。
  4. 内容を固定し、review出力形式だけを変える。
  5. 同じ形式で単一agent／subagent統合を比べる。
  6. 最後にmodelだけを変える。
- Measure: 読者が「最重要の問題」「その理由」「最初に直すこと」を正しく答えられるか、回答までの時間、不要な用語の説明を求めた回数。読みやすさの好みだけで決めない。

## Bare-model result

- Model / version: 未実施
- Reasoning: 一つの実運用観測と書き直し例はあるが、構造、用語、長さが同時に変わっているため、どれが効いたか分からない。
- Runs: 0
- Result: 未実施

## Conclusion

- Supported hypothesis: 現観測はH1、H2、H4に強く整合し、H3とH5にも整合する。
- Rejected hypotheses: なし。
- Remaining uncertainty: review以外の文書でも再現するか、subagent統合の影響、model差。
- Next action: 匿名化した入力と複数の書き直しを作り、まず構造だけ、次に用語だけを変えた比較を行う。再現性を確認してから`review`、`minimal-writing`、共通AGENTSのどこへ対策を置くか決める。
