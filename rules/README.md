# 常時ルール

`harnessctl`のprofileから`~/.codex/AGENTS.md`へ導入し、常時読み込ませる行動ルールを管理します。rulesはエージェントへの指示であり、機械的な検査や強制はhooksが担当します。

1つのrules resourceは`rules/<name>/AGENTS.md`として配置します。skillやhookとの対応はrules側に書かず、profileからそれぞれを独立して選択します。
