#!/bin/bash
# デイリーノートのパスを出力する
# 引数: yesterday で昨日のパスを取得

if [ "$1" = "yesterday" ]; then
  date -v-1d "+$HOME/obsidian-vault/デイリーノート/%Y/%m/%Y-%m-%d.md"
else
  date "+$HOME/obsidian-vault/デイリーノート/%Y/%m/%Y-%m-%d.md"
fi
