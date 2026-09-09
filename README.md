# toritsu-openai

Bun + Hono + TypeScriptで作られた、都立AIのOpenAI互換ラッパーAPI

## 前提

- 都立AIの授業用APIキーが必要です（有効期限・利用回数に上限あり）。[こちらのページ](https://ai.metro.tokyo.lg.jp/chat/public-api)で取得してください。

## クイックスタート

```sh
bun install
cp .env.example .env   # TORITSU_API_KEY にキーを貼る
bun run src/index.ts   # http://localhost:3000 で起動
```

```sh
# curl例
curl -s -X POST http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"toritsu","messages":[{"role":"user","content":"春の俳句を1つ作って。"}]}'
```

```python
# Python例（継続あり）
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3000/v1", api_key="dummy")
first = client.chat.completions.create(model="toritsu", messages=[{"role": "user", "content": "私の名前はユウタです。"}])
second = client.chat.completions.create(
    model="toritsu",
    messages=[{"role": "user", "content": "私の名前は？"}],
    extra_body={"conversation_id": first.conversation_id},
)
```

## モデル一覧

モデル名だけで振る舞いが決まります。

| model               | 動作         | 要件     |
| ------------------- | ------------ | -------- |
| `toritsu`           | 通常チャット | APIキー  |
| `toritsu-fast`      | 高速モデル   | ログイン |
| `toritsu-reasoning` | 推論モデル   | ログイン |

```sh
# ログイン（WebUIモデル用、1回だけ。Chromeが開くのでログインするだけ）
bun run src/index.ts --login
pi -p "..." --provider toritsu --model toritsu-reasoning
```

## クライアント登録

### pi agent

`~/.pi/agent/models.json` に追加します。

```json
{
  "providers": {
    "toritsu": {
      "baseUrl": "http://localhost:3000/v1",
      "api": "openai-completions",
      "apiKey": "dummy",
      "models": [{ "id": "toritsu" }, { "id": "toritsu-fast" }, { "id": "toritsu-reasoning" }]
    }
  }
}
```

```sh
pi --provider toritsu --model toritsu-reasoning
```

### opencode

`~/.config/opencode/opencode.jsonc` の `provider` に追加します。

```json
"provider": {
  "toritsu": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Toritsu AI (local)",
    "options": { "baseURL": "http://localhost:3000/v1", "apiKey": "dummy" },
    "models": {
      "toritsu": { "name": "Toritsu AI" },
      "toritsu-fast": { "name": "Toritsu Fast (session)" },
      "toritsu-reasoning": { "name": "Toritsu Reasoning (session)" }
    }
  }
}
```

## キーの貼り替え

キーは1~8時間で失効します。`TORITSU_KEY_FILE` に書いたファイルは再起動なしで切替わります。

```sh
TORITSU_KEY_FILE=~/.config/toritsu-openai/key bun run src/index.ts
```

## 環境変数

| 変数                                   | 説明                                                   |
| -------------------------------------- | ------------------------------------------------------ |
| `TORITSU_API_KEY` / `TORITSU_KEY_FILE` | APIキー（直指定かファイルかどちらか）                  |
| `TORITSU_SESSION`                      | WebUIのセッショントークン（`--login` 保存よりenv優先） |
| `PORT`                                 | 待受ポート（既定3000）                                 |
| `TORITSU_API_URL`                      | 上流URLの上書き（テスト用）                            |

## 制約

- `POST /v1/chat/completions` のみ対応。`stream: true` は疑似ストリーミングで配信。
- 上流の1回あたり上限あり（超過は400）。継続ターンは最新のみ送信します。
- `system` は文頭に畳んで送信します。
- `usage` は上流の実測値をマッピングしています。

## 制限の突破：このプロキシの技術的背景

都立AIの公開Endpointは薄い入口です（`{input, conversation_id}` のみ・余分なfieldは401・2万文字制限・ストリーミングなし・モデル選択なし）。以下を1つずつ突破しています。

- **401の罠**：`Accept-Encoding` なしのリクエストは問答無用で401になります。特定後は必須ヘッダとして送信しています。
- **会話継続**：OpenAI側に枠がないため、非標準の `conversation_id` fieldで透過＋応答にechoします。
- **system枠なし**：`system` メッセージを文頭ブロック化して畳み込みます（2形式をlive比較して採用）。
- **tools拒否**：`tools` fieldはゲートウェイに弾かれます。定義をテキスト指示に変換し、モデルの `tool_calls` JSON出力をそのまま返す「翻訳者」方式で、全モデルからtool呼び出しを使えるようにしています。
- **モデルの実行拒否**：裏側モデルは架空の道具を呼ばないと6回拒否されました。「テスト出力」「変換作業」フレーミング＋回答禁止＋矛盾するsystemの除去＋結果ターンの指示切替えで遵守させています。
- **2万文字壁**：上流が履歴を保持していることを突き止め、継続ターンは最新のみ送信します。tool結果の切詰め・自動縮小と合わせて3層防御です。
- **モデル選択**：WebUIの通信を観測してモデルID（高速10・推論13）とセッションEndpointを特定し、`--login` による自動取得と合わせて対応しました。
- **ストリーミングなし**：一括応答をチャンク分割してSSE形式で配信します。
