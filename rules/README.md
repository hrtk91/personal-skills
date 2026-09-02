# 常時ルール

`harnessctl`のprofileから`~/.codex/AGENTS.override.md`へ導入し、`~/.codex/AGENTS.md`を土台として常時読み込ませる行動ルールを管理します。rulesはエージェントへの指示であり、機械的な検査や強制はhooksが担当します。

1つのrules resourceは`rules/<name>/AGENTS.md`として配置します。`<name>`には日本語を含むディレクトリ名を使えます。skillやhookとの対応はrules側に書かず、profileからそれぞれを独立して選択します。

例えば、`rules/日本語名のルール/AGENTS.md`のように配置します。
