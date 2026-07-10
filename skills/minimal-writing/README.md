# Minimal Writing

文章を、読者目的・文の役割・主張の根拠・不明点・冗長さで制御するための Agent Skill。

この skill は、LLM の文章品質は文体指示よりも **情報制御** によって改善しやすい、という仮説にもとづく。

- すべての文に役割を持たせる
- 事実、推論、意見、提案、不明点を分ける
- 不明点を推測で埋めず、見える状態にする
- 読み手に見せる本文と、判断理由を分ける
- 媒体別の差分は reference として切り替える
- 文章プロセス自体を PDCA と ADR で改善する

## 構成

```text
verifiable-minimal-writing/
  SKILL.md
  README.md
  agents/openai.yaml
  references/
  adr/
  evals/
  scripts/
  assets/templates/
  examples/
```

## Codex へのローカルインストール

ユーザー単位:

```bash
mkdir -p "$HOME/.agents/skills"
unzip verifiable-minimal-writing.zip -d "$HOME/.agents/skills"
```

リポジトリ単位:

```bash
mkdir -p .agents/skills
unzip verifiable-minimal-writing.zip -d .agents/skills
```

skill が表示されない場合は Codex を再起動する。

## 呼び出し例

```text
verifiable-minimal-writing skill を使って、この文章から不要な文、重複、根拠のない主張、不明点の混入を取り除いて。
```

```text
$verifiable-minimal-writing を使って、この提案文を、読み手が採否を判断しやすい最小十分な構成にして。事実と推論を分けて。
```

```text
この公開プロフィール文を skill でレビューして。役割・成果帰属・公開範囲が強すぎないか、冗長な一般論がないか見て。
```

媒体ごとの観点は `references/document-type-techniques.md` を参照する。

## 簡易テスト

```bash
python verifiable-minimal-writing/scripts/review_text.py examples/bad-spec-note.md
```

このスクリプトは意図的にヒューリスティックである。真偽を検証するものではなく、人間または Codex が主張を注意深く確認すべき箇所を検出する。
