# 作業チャンネル

`channel/bin/channel` と Pi 拡張は `AGENT_CHANNEL`（JSONL の保存先）と `AGENT_CHANNEL_NAME`（送信者名）を使います。`AGENT_CHANNEL` が無い場合は `~/.cache/agent-channel/channel.jsonl` を使います。必要ならコマンドの `--log` と `--from` で上書きできます。拡張で `AGENT_CHANNEL_NAME` が無い場合、記録を伴う道具呼び出しはエラーになります。宛先の既定は、依頼元 Claude Code の親プロセスから検出した `claude-<PID>`（未検出なら `claude`）です。MCP は自分宛てと `*` の行だけを届け、汎用 `claude` 宛ては除外します。Pi の finish/post/stopped は `AGENT_CHANNEL_SUPERVISOR` 宛て（未設定なら `claude`）です。

Pi では `pi -e channel/pi/extension.ts` で読み込みます。担当別の包みを生成する場合は、拡張から `createChannelExtension({ log, name, supervisor })` を import して呼び出してください。既定 export は拡張の呼び出し時に環境変数を読み、設定付きの関数を呼ぶ薄い入口です。herdr は `AGENT_CHANNEL_SUPERVISOR` または `channel supervisor` の出力を包みに記録します。

Claude Code では `channel/mcp/server.ts` を MCP サーバーとして登録します。`.mcp.json` などに次を設定してください（`<絶対パス>` は実際の配置先に置き換えます）。

```json
{"mcpServers":{"agent-channel":{"command":"node","args":["<絶対パス>/channel/mcp/server.ts"]}}}
```

試験公開中の自作チャンネルを有効にするには、画面ありの起動で次を使います。`-p` ではこのフラグは効きません。

```sh
claude --dangerously-load-development-channels server:agent-channel
```

MCP サーバーの依存導入と検査は `npm install --prefix channel/mcp @modelcontextprotocol/sdk` および `node --test channel/engine/test/*.test.ts channel/pi/test/*.test.ts channel/mcp/test/*.test.ts` で行います。

```sh
channel/bin/channel post [--to claude] '進捗'
channel/bin/channel finish --summary '完了' --fact '主張::確認方法'
channel/bin/channel say --to impl-1 '確認してください'
channel/bin/channel wait --kind finish --from impl-1 --timeout 30
channel/bin/channel tail --follow
channel/bin/channel last-id
```

ログは追記専用の JSONL です。`--after <id>` は ID の文字順ではなく、ログ内でその ID の行より後ろにある行を対象にします。指定 ID がログに見つからない場合は、取りこぼしを避けるためログの先頭から対象にします。`wait` の時間切れは終了コード 124、引数不足などは 2 です。検査は `node --test channel/engine/test/*.test.ts` で実行します。
