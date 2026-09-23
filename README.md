# toritsu-openai

Tool Callingやその他の機能を追加した、都立AIのOpenAI互換ラッパーAPI

Bun + Hono + TypeScriptで作成

## クイックスタート

```sh
bun install
cp .env.example .env   # TORITSU_API_KEY にキーを貼る
bun run src/index.ts   # http://localhost:3000 で起動
```

```sh
# 動作確認
curl -s -X POST http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"toritsu","messages":[{"role":"user","content":"春の俳句を1つ作って。"}]}'
```

## コマンド

| 用途     | コマンド                            |
| -------- | ----------------------------------- |
| 初期設定 | `bun install && cp .env.example .env` |
| 起動     | `bun run src/index.ts`（http://localhost:3000） |
| ログイン | `bun run src/index.ts --login`      |

## モデル

（fastとreasoningはログインが面倒だが、API制限は完全に突破できる）

| model               | 動作         | 要件     |
| ------------------- | ------------ | -------- |
| `toritsu`           | 通常チャット | APIキー  |
| `toritsu-fast`      | 高速モデル   | ログイン |
| `toritsu-reasoning` | 推論モデル   | ログイン |

`.env` に `TORITSU_MS_EMAIL` / `TORITSU_MS_PASSWORD` を設定しておくと
`--login` 時のMSサインインを自動入力します（失敗時は手動ログイン待ちに切替）。

## クライアント登録

`apiKey` は `"dummy"` でよい（無認証素通しのため）。

### pi agent

`~/.pi/agent/models.json` に追加します。

```json
{
  "providers": {
    "toritsu": {
      "baseUrl": "http://localhost:3000/v1",
      "api": "openai-completions",
      "apiKey": "dummy",
      "models": [
        { "id": "toritsu" },
        { "id": "toritsu-fast" },
        { "id": "toritsu-reasoning" }
      ]
    }
  }
}
```

### opencode

`~/.config/opencode/opencode.jsonc` の `provider` に追加します。

```json
"provider": {
  "toritsu": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Toritsu AI",
    "options": { "baseURL": "http://localhost:3000/v1", "apiKey": "dummy" },
    "models": {
      "toritsu": { "name": "Toritsu AI" },
      "toritsu-fast": { "name": "Toritsu Fast" },
      "toritsu-reasoning": { "name": "Toritsu Reasoning" }
    }
  }
}
```

### Python

```python
# 継続あり
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3000/v1", api_key="dummy")
first = client.chat.completions.create(model="toritsu", messages=[{"role": "user", "content": "私の名前はユウタです。"}])
second = client.chat.completions.create(
    model="toritsu",
    messages=[{"role": "user", "content": "私の名前は？"}],
    extra_body={"conversation_id": first.conversation_id},
)
```

## 環境変数

| 変数                                       | 既定                                       | 説明                                                                                        |
| ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `TORITSU_API_KEY` / `TORITSU_KEY_FILE`     | —                                          | APIキー（直指定かファイルかどちらか。キーは1~8時間で失効、`KEY_FILE` は再起動なしで切替え） |
| `TORITSU_SESSION`                          | —                                          | WebUIのセッショントークン（`--login` 保存よりenv優先）                                      |
| `TORITSU_MS_EMAIL` / `TORITSU_MS_PASSWORD` | —                                          | `--login` 時のMS自動入力（未設定なら手動ログイン）                                          |
| `TORITSU_AGENT_SYSTEM`                     | `You are a helpful coding assistant.`      | agent翻訳時の自前system上書き                                                               |
| `PORT`                                     | `3000`                                     | 待受ポート（bindは127.0.0.1固定）                                                           |
| `TORITSU_PROXY_KEY_FILE`                   | `~/.config/toritsu-openai/proxy_keys.json` | プロキシキー保存先（0600）。有効キー0件＝無認証素通し                                       |
| `TORITSU_DEBUG`                            | `off`                                      | `1`: サイズ内訳をログ出力、`full`: 生ログ保存                                               |
| `TORITSU_DEBUG_FILE`                       | `~/.config/toritsu-openai/debug.log`       | 生ログ保存先                                                                                |
| `TORITSU_DEBUG_STDOUT`                     | —                                          | `1` で生ログを標準出力にも同時表示                                                          |

## エラー応答

| 状態                        | 意味                    | 対処                                               |
| --------------------------- | ----------------------- | -------------------------------------------------- |
| `400 invalid_request_error` | `messages` 不正等       | リクエスト形状を見直す                             |
| `400`（上流）               | 上流の1回あたり上限超過 | 入力を縮小する（継続ターンは最新のみ送信されます） |
| `401 Authentication failed` | 上流キー失効（1~8時間） | キーを取り直して `TORITSU_KEY_FILE` を更新する     |
| `401 invalid_api_key`       | プロキシキー不一致      | 発行したキーで `Authorization: Bearer` を送る      |
| `401 session expired`       | WebUIセッション失効     | `bun run src/index.ts --login` で取り直す          |
| `502`                       | 上流到達不可・応答不正  | 時間を置いて再試行する                             |

## 制約

- `POST /v1/chat/completions` のみ対応。`stream: true` は疑似ストリーミングで配信。
- `POST /v1/chat/completions` のみ保護対象（プロキシキー制時）。`GET /v1/models` は公開のまま。
- 継続ターンは最新のみ送信（上流が履歴保持）。
- `system` は文頭に畳んで送信。`usage` は上流実測値のマッピング。
- 公開運用時は `TORITSU_DEBUG` を `off` にすること。

## 中央運用（公開する場合のみ。個人利用では不要）

プロキシキーが1件もなければ無認証で素通しします。公開する場合のみ以下で発行してください。
サーバーは `127.0.0.1` のみで待受けます（Tunnel等は `http://localhost:3000` に向ける）。

```sh
bun run src/index.ts --issue-key --name pi-agent   # 発行（サーバーは起動しない）
bun run src/index.ts --list-keys                   # 一覧
bun run src/index.ts --revoke-key <idまたはキーprefix>  # 失効
```

クライアント側は発行したキーを `apiKey` に設定します。発行・失効はファイルのmtime監視で
無再起動反映されます。

## 技術的背景

都立AIの公開エンドポイントはゴミ（`{input, conversation_id}` のみ・余分なfieldは401・2万文字制限・ストリーミングなし・モデル選択なし）。

- **会話継続**：非標準の `conversation_id` を活用
- **システムプロンプトの枠なし**：`system` メッセージを文頭に挿入して送信
- **toolsなし**：`tools` はゲートウェイに弾かれるので、定義をテキスト指示に変換し、モデルに `tool_calls` JSON出力をそのまま返させ、本物のtool callに戻すことで使えるように
- **モデルの実行拒否**：モデルは、東京都側のシステムプロンプト注入によって、架空のtoolを呼ばないと頑なに拒否する→「テスト出力」「変換作業」フレーミング＋回答禁止＋矛盾するsystemの除去＋結果ターンの指示切替えで遵守させる
- **2万文字制限**：上流の履歴保持に頼り、継続ターンは最新のみ送信する。tool結果の切詰めと自動縮小も行う
- **モデル選択**：WebUIの通信を観測してモデルID（高速10・推論13）とエンドポイントを特定し、`--login` によるログインに対応
- **ストリーミングなし**：一括応答を分割してSSE形式で配信

## ライセンス

MIT License（[LICENSE](LICENSE) 参照）
