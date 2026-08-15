# <short title>

## Observation

- Source observation:
- Failure summary:
- Why it matters:

## Competing hypotheses

観測から一つの原因へ決め打ちしない。少なくとも、モデル能力、与えたcontext、taskの曖昧さ、tool/環境、skillの副作用を候補として検討する。

### H1: <hypothesis>

- Mechanism:
- Prediction if true:
- Evidence against:

### H2: <hypothesis>

- Mechanism:
- Prediction if true:
- Evidence against:

## Discriminating eval

どの仮説なら失敗が再現し、どの仮説なら再現しないかを区別できる最小の評価を書く。

- Start state:
- Task:
- Keep fixed:
- Change only:
- Expected result by hypothesis:

## Bare-model result

skillや追加指示を外した現行モデルで、対象失敗が再現するかを先に確認する。

- Model / version:
- Reasoning:
- Runs:
- Result:

## Conclusion

- Supported hypothesis:
- Rejected hypotheses:
- Remaining uncertainty:
- Next action: no change / benchmark case / skill / AGENTS.md / tool / test / lint / model routing

この段階では「skillを追加したい」ことを結論の前提にしない。失敗が再現しない、または別要因で説明できるならskillへ進まない。
