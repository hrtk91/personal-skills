# personal-skills herdr の rogue 互換設定と既定モデルの更新

2026-09-30。追加依頼の「astra 制限を一旦なくす」を最終仕様として適用した。

## 結論

rogue は、下記の設定を配置して起動・取り込みの参照を herdr に切り替えれば、専用の codex-herdr 台本を使わずに継続できる。依頼文・報告・ブランチ・置き場・作者、設計下見、研究の BASE、再開と完了印を設定で引き継げる。

Codex は設計の下見・実装・レビューとも `gpt-6.1-sol / default / max` が既定。astra を拒否する処理を Codex・pi の両方から外した。明示指定のモデルを使える。実 Codex による使い捨てリポジトリの実装・別担当レビュー・コミット・印・タブ閉鎖を最終版で通した。オフライン28件も成功した。

この報告は personal-skills の herdr スキル内に置いた。rogue 本体・設定・専用スキルは編集していない。

## レビュワーに求める判断

レビュワーは、設定によって既存の rogue 運用を維持でき、既定モデルと失敗時の扱いを確認できる汎用 herdr に、専用台本から置き換えてよいかを判断する。

## 今回含めること・含めないこと

含めるのは herdr の互換設定、Codex の既定変更と astra 拒否の撤廃、これらを成立させるコピー・staging・完了判定の修正、検証と報告。含めないのは rogue 側の設定配置・台本除去・参照更新、スキルや profile の登録、無関係な未コミット変更、push・PR。rogue 側の変更は最後の一覧を Claude が行う。

## 行単位の比較を機能別に整理した表

比較元は rogue の `.claude/skills/codex-herdr/codex-herdr.sh`（167行）と `SKILL.md`（54行）、personal-skills の更新前 `07b5041` にある `skills/herdr/herdr-run.sh`・`agents/codex.sh`・`SKILL.md`。表中の行番号は更新前のファイルを指す。すべての行を突き合わせ、同じ処理のまとまりごとに差を示した。

| 対象・元の行 | rogue 専用版 | 更新前の汎用 herdr | 今回の対応・設定 |
| --- | --- | --- | --- |
| 設定・本体（専用11–17／汎用13–28） | 本体と各種パスを固定。環境変数で一部変更 | Git ルートを本体にし、`.herdr.env` を読む | 後者を維持。`REPO` と `HERDR_CONF` も利用可能 |
| 置き場（専用13／汎用18） | CODEX_WORK。既定の名前は rogue-codex | HERDR_WORK → CODEX_WORK。既定の名前は herdr-リポジトリ名 | `WORK_NAME` を追加。rogue は rogue-codex を選び、既存 CODEX_WORK の指定も継続可能 |
| 依頼・各報告の名前（専用3、133、145–153／汎用28） | codex-rogue-名 と design/report/review の接尾辞 | 接頭辞なしの 名 | `TASK_PREFIX` を追加し、四つの文書に同じ接頭辞を付ける |
| 共通文書（専用32、133、145–150／汎用22–25、39、54、127） | codex-evidence、codex-design-first、AGENTS、CLAUDE を要求 | RULES、CONTEXT_FILES、CHECKLIST | `RULES` と `CONTEXT_FILES` に同じ文書を指定。現在の未コミット版も写しにコピー |
| 設計下見の手順（専用133と専用 SKILL 15／汎用128） | codex-design-first の30行以内・三つの結論 | 10行程度・続行または STOP をプロンプトに固定 | `DESIGN_RULES` を追加。指定文書の手順・結論を優先し、汎用の結論指定と衝突させない |
| STOP（専用136–139／汎用131–134） | 行頭の 結論: STOP でレビューを止める | 同じ | 正規表現を維持。stopped を書き、タブを残す |
| 本体の未コミット変更（専用35–37／汎用49–50） | 常に事前コミット | COMMIT_DIRTY 指定時だけ事前コミット | 明示の `COMMIT_DIRTY=1` で専用版と同じ。汎用の既定はしない。0 は無効 |
| 事前コミット作者（同上） | Claude の架空アドレス | 同じ | `DIRTY_COMMIT_NAME`・`DIRTY_COMMIT_EMAIL` で両方を選択可能 |
| worktree とブランチ（専用38／汎用52） | codex/名。-B で同名をリセット | herdr/名。-B | `BRANCH_PREFIX` を追加。新規作成は -b に変更し、既存同名を上書きしない。続きは RESUME |
| BASE（専用29–32／汎用44–46） | 前の写しを丸ごとコピー。自動コミットしない | 同じ | BASE を維持。Git はローカル clone で独立させ、内容はコピー。元が worktree でも元の index を共有しない |
| BASE の文書更新（専用32／汎用54） | 依頼・evidence・AGENTS・CLAUDE を更新 | 指定文書を更新 | DESIGN_RULES も含めて指定文書を更新。読み取り専用のコピーも更新可能 |
| 在庫（専用40–41／汎用55） | 通常起動で portraits をコピー。BASE は前の在庫を保持 | EXTRA_DIRS を通常起動・BASE の両方でコピー | `EXTRA_DIRS` と `BASE_REFRESH_EXTRA_DIRS`。0 は前の在庫、1 は本体から更新。更新時のディレクトリ二重化も修正 |
| EXTRA（専用43／汎用56–57） | 単体ファイルを読み取り専用でコピー | 同じ | 継続。BASE で既存の読み取り専用コピーを更新可能。追加ファイルを自動でパッチ・コミットから除外 |
| パッチ（専用67／汎用80） | PNG と saves を固定除外 | PATCH_EXCLUDE。どちらも git add -A | `PATCH_EXCLUDE` を維持し、staging とコミットにも適用。ignored な参照資料で失敗しないようファイルを列挙して staging |
| タブ・二つのペイン（専用48–57／汎用62–69） | 実装左・レビュー右 | 同じ | 維持。作成は --no-focus。CODEX_HOME を指定した場合は両ペインへ渡す |
| RESUME=1（専用59–65／汎用72–78） | ログから同じタブ・ペインを読み、既存担当を待つ | 同じ | 維持。同名担当が別のペインにいたら触らず失敗として報告 |
| RESUME=newtab（専用127–128／汎用121–122） | 写しを保持してタブだけ再作成 | 同じ | 維持。再開する写し・ログの不足をエラーにする |
| SKIP_IMPL（専用131–135／汎用126–130） | 実装を飛ばしてレビュー | 同じ | `SKIP_IMPL=1` で維持。BASE を再開する場合は BASE も再指定 |
| エージェント種類（専用87–104／汎用27、87–98） | Codex 二人 | codex/pi、実装・レビューを独立指定 | IMPL_AGENT・REV_AGENT と部品分割を維持 |
| モデル・tier・effort（専用17、96–98／汎用 Codex 部品2–18） | luna / priority / max、旧名 MODEL/TIER/EFFORT | 同じ既定。CODEX_* と CODEX_REV_* もある | sol 6.1 / default / max。レビュー専用 → 実装指定 → 旧名 → 既定の優先順を維持 |
| astra（専用 SKILL 24／汎用 Codex 部品4、18） | 起動可能。説明は重い設計向け | 設計以外の起動を拒否 | 追加依頼に従い拒否を撤廃。設計・実装・レビューを sol 6.1 に一本化し、astra は明示指定なら使える |
| 起動権限・準備（専用96–102／汎用 Codex 部品19–25） | danger-full-access、never、写しの trust、入力欄を待つ | 同じ | 権限指定を維持。CLI 0.159.2 が求める元の Git ルートも trust 引数へ追加。herdr の interactive_ready で準備確認 |
| 目標の受信（専用73–85／汎用 Codex 部品28–40） | /goal。送信後に更新されたセッション記録と印のパスを確認 | 同じ | 同じ仕組み。CODEX_HOME に対応し、同じ thread_goal_updated イベントに今回の印があることを JSON として確認 |
| 待機・再送（専用103–122／汎用99–117） | working を待って応答完了を待つ。20秒の猶予。印なしなら最大3回 | 同じ | 維持。観測タイムアウト・取得失敗だけで終了扱いしない。担当の消失は成功した agent list で確認 |
| done 印（専用88–89、92–93、110、117／汎用88–95、105、112） | done-impl/ rev を最後に作らせ、確認後に削除 | 同じ | 命名・消費の仕組みを維持。done/idle 状態だけでは完了扱いしない |
| blocked（専用115–116／汎用110–111） | 応答せず、パッチと blocked を残し、終了2 | 同じ | 維持。確認画面を自動で承認しない |
| レビュー依頼と観点（専用143–156／汎用138–150） | 写しの外に長い指示。画素直書き・共通規則・実テスト・ブラウザを確認 | 汎用の重複・規則・テスト確認と CHECKLIST | 命名設定を適用。rogue 固有の画素・ブラウザ・証拠・GPU 禁止は既存 RULES と AGENTS を両担当に読ませる |
| 最終コミット（専用157–160／汎用152–155） | 作者 Codex。BASE はしない | 作者小文字の agent。BASE はしない | `COMMIT_NAME`・`COMMIT_EMAIL`。既定 Codex/Pi、BASE はしない。コミット失敗時は reviewed を書かない |
| reviewed の中身と片付け（専用134、138、154、161–163／汎用129、133、150、156–158） | reviewed/stopped/failed/blocked。成功でタブ閉鎖 | 同じ。ただしコミット失敗の検出なし | 四つの値を維持。レビュー・必要なコミット・タブ閉鎖が成功した後に reviewed を書く |
| 台本の付け替え（専用 SKILL 43／汎用 SKILL の困ったとき） | pkill で台本を止め RESUME | 同じ | 今回の PID だけを対象にする説明へ変更。他の Codex・台本・タブには触らない |

比較元の SHA-256:

- 専用 codex-herdr.sh: `4584c8a5ca2eff49795e1b986cfee32b54d039067581af5620bb31ba8fee43e9`
- 専用 SKILL.md: `2d21b6b8cc9be24148b67ae7a70f587635fc186817adfb54bf227b45f09614ed`

## 変更ファイル

- `skills/herdr/herdr-run.sh`: 互換設定、BASE とコピー、対象だけの staging、失敗・再開・タブの扱い。
- `skills/herdr/agents/codex.sh`: 既定モデル、astra 拒否の撤廃、設定優先順、起動 trust、CODEX_HOME と目標イベント確認。
- `skills/herdr/agents/pi.sh`: astra 拒否だけを撤廃。pi の既定モデル・provider・thinking は変更していない。
- `skills/herdr/SKILL.md`: 既定、制限の撤廃、汎用設定例、再開・失敗・取り込みの説明。
- `skills/herdr/tests/test_herdr.py`: 実 Git とダミー herdr による契約の検証。モデルや外部サービスを呼ばない。
- この報告。検証用リポジトリ・セッション・生ログはコミットしない。

## rogue 用 .herdr.env 案の全文

Claude が rogue に配置する案。既存の Codex 用依頼文、ブランチ、置き場名、作者、BASE の在庫を継続する。

```bash
# 起動時に渡された設定を優先する。
HANDOFF=${HANDOFF:-handoff}
TASK_PREFIX=${TASK_PREFIX:-codex-rogue-}
BRANCH_PREFIX=${BRANCH_PREFIX:-codex}
WORK_NAME=${WORK_NAME:-rogue-codex}

RULES=${RULES-"handoff/codex-evidence.md handoff/codex-design-first.md"}
DESIGN_RULES=${DESIGN_RULES:-handoff/codex-design-first.md}
CONTEXT_FILES=${CONTEXT_FILES-"CLAUDE.md AGENTS.md"}
CHECKLIST=${CHECKLIST-handoff/review-checklist.md}

EXTRA_DIRS=${EXTRA_DIRS:-saves/portraits}
BASE_REFRESH_EXTRA_DIRS=${BASE_REFRESH_EXTRA_DIRS:-0}
PATCH_EXCLUDE=${PATCH_EXCLUDE-":!*.png :!saves"}

# 旧台本と同じ事前コミット。全変更が対象なので起動前に対象を確認する。
# 本体の未コミット変更を写しに入れない場合は COMMIT_DIRTY=0 で起動する。
COMMIT_DIRTY=${COMMIT_DIRTY:-1}
COMMIT_NAME=${COMMIT_NAME:-Codex}
COMMIT_EMAIL=${COMMIT_EMAIL:-codex@noreply.invalid}
DIRTY_COMMIT_NAME=${DIRTY_COMMIT_NAME:-Claude}
DIRTY_COMMIT_EMAIL=${DIRTY_COMMIT_EMAIL:-claude@noreply.invalid}

IMPL_AGENT=${IMPL_AGENT:-codex}
REV_AGENT=${REV_AGENT:-$IMPL_AGENT}
CODEX_MODEL=${CODEX_MODEL:-${MODEL:-gpt-6.1-sol}}
CODEX_TIER=${CODEX_TIER:-${TIER:-default}}
CODEX_EFFORT=${CODEX_EFFORT:-${EFFORT:-max}}
# CODEX_REV_MODEL / CODEX_REV_TIER / CODEX_REV_EFFORT は未指定なら実装設定を継承。
# astra を使う場合も CODEX_MODEL または CODEX_REV_MODEL で明示指定できる。
# HERDR_WORK、旧 CODEX_WORK、EXTRA、BASE、RESUME、SKIP_IMPL は起動時の指定をそのまま使う。
```

依頼名が `sample` なら、依頼 `handoff/codex-rogue-sample.md`、設計 `-design.md`、実装報告 `-report.md`、レビュー報告 `-review.md`、ブランチ `codex/sample`。置き場は HERDR_WORK → CODEX_WORK → ユーザーキャッシュ内の WORK_NAME の優先順。既定の置き場名は旧版と同じ rogue-codex。既存の別名の codex ブランチや、既定設定を使うプロジェクトの herdr ブランチは上書きしない。

既存の同名ブランチ・写しを作り直す処理は廃止した。続きはログと写しを保持して RESUME を使う。BASE の続きなら BASE も再指定する。

## 検証結果

モデル確認は `codex debug models --bundled` を使用した。モデル一覧の外部更新をせず、CLI に含まれるカタログを確認した。表示した出力:

```text
codex-cli 0.159.2
{"slug": "gpt-6.1-sol", "supported_reasoning_levels": ["low", "medium", "high", "xhigh", "max", "ultra"]}
```

シェル各ファイルの `bash -n`、スキルの quick_validate、差分整合性、設定案の構文と展開後の値を確認した。出力:

```text
PASS bash -n skills/herdr/herdr-run.sh
PASS bash -n skills/herdr/agents/codex.sh
PASS bash -n skills/herdr/agents/pi.sh
PASS report .herdr.env syntax and resolved defaults
SKIP shellcheck: not installed; no download performed
Skill is valid!
PASS git diff --check -- skills/herdr
```

オフライン検証のコマンド:

```bash
python3 -m unittest discover -s skills/herdr/tests -v
```

最終出力:

```text

----------------------------------------------------------------------
Ran 28 tests in 79.594s

OK
```

実 Codex は専用ヘッドレス herdr、独立した CODEX_HOME、使い捨ての Git リポジトリで動かした。ユーザーの既存の herdr サーバーやタブを操作していない。Codex の起動には検証用の --no-daemon を加え、設定・セッションを検証側に隔離した。GPU・画像音声生成・学習・モデルダウンロード・8781 は使っていない。外部モデルの呼び出しは、依頼された Codex 通し確認だけである。

最終版は sol-final で実行し、台本は終了コード0だった。検証用リポジトリで実行したコマンドの形は以下。変数はそれぞれ検証用の置き場とスキルを指す。

```bash
CODEX_HOME="$VALIDATION_ROOT/codex-home" HERDR_SOCKET_PATH="$VALIDATION_ROOT/xdg/herdr/herdr.sock" HERDR_WORKSPACE_ID=w1 bash "$HERDR_SKILL_DIR/herdr-run.sh" sol-final < /dev/null
```

進捗ログの対象行をそのまま抜粋:

```text
2026-09-30 12:39:37 impl-sol-final: Codex 設定 model=gpt-6.1-sol service_tier=default effort=max
2026-09-30 12:39:46 impl-sol-final: 目標の記録を確認した
2026-09-30 12:44:44 impl-sol-final: 終わった
2026-09-30 12:44:44 rev-sol-final: Codex 設定 model=gpt-6.1-sol service_tier=default effort=max
2026-09-30 12:44:51 rev-sol-final: 目標の記録を確認した
2026-09-30 12:49:17 rev-sol-final: 終わった
2026-09-30 12:49:17 ブランチ codex/sol-final にコミットした（作者 Codex <codex@noreply.invalid>）
2026-09-30 12:49:17 レビューまで終わった
```

レビュー担当が再実行した `python3 -m unittest -v` の出力:

```text
test_alice (test_greeting.GreetingTest.test_alice) ... ok
test_bob (test_greeting.GreetingTest.test_bob) ... ok

----------------------------------------------------------------------
Ran 2 tests in 0.000s

OK
```

印・Git・成果物・セッション・タブを、現在のファイルと実 herdr API から検査した出力:

```text
PASS reviewed-sol-final = reviewed
PASS implementation: Hello, Alice! / Hello, Bob!
PASS test_greeting.py unchanged
PASS design / implementation report / review report exist
PASS completion markers consumed
PASS branch = codex/sol-final
PASS author = Codex <codex@noreply.invalid>
PASS existing codex/existing branch preserved
PASS portraits source preserved
PASS reference / saves / PNG excluded from commit
PASS EXTRA reference is read-only
PASS review task outside worktree
PASS own task tab w1:t4 closed; bootstrap tab remains
PASS isolated server agent list empty
PASS real turn contexts all model gpt-6.1-sol / effort max
PASS both real goal events recorded
PASS both roles launched with service_tier=default
```

`service_tier=default` は両起動の明示引数と進捗ログで確認し、モデルと念入りさは実際の turn_context でも確認した。最初の成功確認 sol-smoke-2 ではレビュー担当が報告の差分検証を HEAD 基準へ訂正した。最終の sol-final でもレビュー担当が元の差分と実テストを独立に確認し、報告を整えた。実装・レビューの両方で最終の目標記録が確認され、完了印は台本に消費された。

検証専用サーバーを終了し、コピーした一時認証情報を除去した。無関係な変更は初期の状態と内容のハッシュで照合した。出力:

```text
PASS isolated Herdr server stopped; socket removed
PASS temporary credentials removed
PASS unrelated status and content unchanged: 38 entries
```

既存の Claude 側 herdr スキルのリンクが、今回修正した personal-skills 側のスキルを指すことも読み取りで確認した。登録・profile 変更はしていない。


## 検証中に見つけ、直した問題

- 最初の実起動は Git worktree の trust 指定だけでは足りず、元の Git ルートの信頼画面で止まった。元のルートも起動引数に指定し、herdr の入力準備状態を使うよう変更した。ユーザーの設定ファイルは編集していない。
- ignored な EXTRA や除外ディレクトリを git add の pathspec に直接渡すと staging が失敗した。Git で対象ファイルを列挙し、パッチとコミットに同じ除外を適用した。
- BASE の在庫更新テストで、既存ディレクトリへの cp が同名ディレクトリを内側に作ることを確認した。内容を既存ディレクトリへコピーする形に直した。読み取り専用 EXTRA の更新も検証した。
- 実装担当の最初の /goal の受信を確認できず、既定の再送が一度働いた。その後はセッションの目標記録と実装完了を確認できた。これを初回送信成功とは扱っていない。
- pi のオフライン追加検証では、ダミーが Codex 専用の送信時刻ファイルを要求して失敗した。ダミーを修正し、pi の通常プロンプトと明示 astra 指定を検証した。実 pi は呼び出していない。

## Claude が rogue 側で行うこと

1. この報告の .herdr.env 案を配置する。COMMIT_DIRTY=1 は全変更を先にコミットする点を起動前に確認する。
2. 専用 `.claude/skills/codex-herdr/` を除去する。今回の作業では除去していない。
3. CLAUDE.md のコミット・起動説明にある codex-herdr 参照を herdr へ替える。ブランチは設定に従う codex/名 を維持できる。
4. 起動コマンドの台本参照を、既存の herdr スキルの herdr-run.sh へ替える。CODEX_WORK、BASE、EXTRA、RESUME、SKIP_IMPL の既存の指定は引き継げる。
5. 専用版 SKILL にだけある起動・片付け・許可条件の説明は、汎用 SKILL と既存の RULES/AGENTS を参照する形へ整理する。codex-evidence と codex-design-first は残す。
6. 見張りの印は reviewed-名 のままにし、中身の四つの値を確認する。レビュー報告の名前は codex-rogue-名-review.md を継続する。
7. すでに動いている専用台本・Codex タブは止めず、その依頼が終わってから次の依頼を汎用版へ切り替える。完了した今回のタブだけを片付ける。

## 未確認・残る制約

- 本物の rogue での実行、画面・ブラウザ・GPU 非表示の検査は行っていない。既存の規則文書を両担当へ渡す経路と、ダミーでの通し確認が対象。
- 実 astra・実 pi の推論は未実行。明示したモデルを拒否せず起動引数へ渡すことはオフラインで確認した。
- 実画面の blocked、STOP、各種障害時の操作は模擬検証。正常系のタブ作成・二担当・片付けは実 herdr で確認した。
- shellcheck は未インストールだったため未実行。ダウンロードはしていない。
- 文書・追加ファイルの一覧は空白区切り。エージェント名は正規化後の先頭24文字なので、同時に動かす依頼のその部分を重ねない。
- rogue 側の移行と取り込みは Claude の作業。personal-skills では新規ブランチに今回の変更だけを Codex 作者でコミットし、push・PR は作らない。
