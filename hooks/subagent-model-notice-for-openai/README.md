# subagent-model-notice-for-openai

OpenAI Codex専用の `PreToolUse` hook packageです。`spawn_agent`、`Agent`、`collaboration.spawn_agent` の起動時に、指定されたモデルと推論レベルを確認する `additionalContext` をモデルへ渡します。

`gpt-5.6-terra`、`gpt-5.6-sol`、`gpt-5.6`、`gpt-6-astra`、`gpt-5.5`、`gpt-5.4`系は注意対象です。組み込み `agent_type` で、指定モデルまたは親の継承候補が `gpt-5.6-luna`（全推論レベル）か `gpt-5.3-codex-spark` の場合は通知しません。未知モデルはランクを断定せず、確認を促します。

modelを省略した組み込み `agent_type`（`default`、`worker`、`explorer`、省略）では、hook payloadの親 `model` を「親のモデル（継承候補）」として表示します。custom `agent_type`はモデルを上書きする可能性があるため、明示モデルがあっても実効モデルを確定しません。agent_type名だけでLunaの例外を適用しません。

注意は `hookSpecificOutput.additionalContext` だけで、pending callを止めず、モデルの再選択も保証しません。拒否や入力変更は行いません。

モデル・推論レベルの実効値を設定ファイルから解決する処理は持ちません。subagentの既定値やcustom agent設定による上書きは、注意を受け取った主担当が確認します。出力形式は[OpenAI公式のHooks仕様](https://learn.chatgpt.com/docs/hooks#pretooluse)に従います。

利用するprofileでこのpackageを選択し、harnessctlで適用します。stdin/stdoutの出力と一時環境での導入はテストで確認できます。実アプリでの発火・信頼状態は別途確認してください。
