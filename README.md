# toritsu-openai

都立AI（都立高生徒向け生成AI API）を OpenAI互換APIとして叩くためのローカルプロキシ。Bun + Hono + TypeScript。

## 前提

- 都立AIの授業用APIキーが必要です。有効期限（例：2時間）と利用回数の上限（例：文字500回）があります。期限切れ・上限到達後は使えなくなります。
- APIキーは他人に見せたり、公開したりしないでください。このリポジトリにも絶対に含めないでください。

## 使い方

```sh
bun install
TORITSU_API_KEY="ここにAPIキー" bun run src/index.ts
```

サーバーは `http://localhost:3000` で起動します（`PORT` 環境変数で変更可）。

`.env` ファイルでも設定できます（Bunが自動で読込みます）。`.env.example` をコピーしてキーを貼ってください（`.env` はgit管理外です）。

```sh
cp .env.example .env
# .env を編集して TORITSU_API_KEY にキーを貼る
bun run src/index.ts
```

### curl例

```sh
curl -s -X POST http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"toritsu-ai","messages":[{"role":"user","content":"日本語で、春の短い俳句を1つ作って。"}]}'
```

### Python（openai SDK）例

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="dummy")
res = client.chat.completions.create(
    model="toritsu-ai",
    messages=[{"role": "user", "content": "日本語で、春の短い俳句を1つ作って。"}],
)
print(res.choices[0].message.content)
```

## 会話の継続

都立AIは `conversation_id` で会話を継続します。本プロキシでは非標準のボディ field `conversation_id` で受け渡しします。

```python
first = client.chat.completions.create(
    model="toritsu-ai",
    messages=[{"role": "user", "content": "私の名前はユウタです。"}],
)
cid = first.conversation_id  # 応答の付加フィールド

second = client.chat.completions.create(
    model="toritsu-ai",
    messages=[{"role": "user", "content": "私の名前は？"}],
    extra_body={"conversation_id": cid},
)
print(second.choices[0].message.content)
```

## システムプロンプトの扱い

都立AI側にsystem枠がないため、`system` roleのメッセージは文頭にまとめて文字列に畳み込んで送ります（形式A：`system: ...` 行として先頭配置）。環境変数 `TORITSU_SYSTEM_FORMAT=b` で形式B（`【システム指示】` ヘッダー化）に切替えできます。

## 1時間ごとのキー貼り替え

都立AIのAPIキーは有効期限（例：2時間）があります。`TORITSU_KEY_FILE` で指定したファイルに新しいキーを書き込むと、サーバーが自動で検知して切替えます（再起動不要）。

```sh
# 例：~/.config/toritsu-openai/key にキーを保存
mkdir -p ~/.config/toritsu-openai
echo "新しいAPIキー" > ~/.config/toritsu-openai/key

# サーバー起動時
TORITSU_KEY_FILE=~/.config/toritsu-openai/key bun run src/index.ts
```

サーバーログにキー末尾4文字のフィンガープリントが出力されるので、どの世代で動いているか確認できます。上流から401が返ると `key may be expired, refresh KEY_FILE` のヒントがログに出ます。

## 環境変数

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `TORITSU_API_KEY` | Yes（どちらか） | 都立AIのAPIキー（直指定） |
| `TORITSU_KEY_FILE` | Yes（どちらか） | APIキーが書かれたファイルのパス（ホットリロード対応、1時間ごとの貼り替えに再起動不要） |
| `PORT` | No | 待受ポート（既定3000） |
| `TORITSU_API_URL` | No | 上流URLの上書き（テスト用） |
| `TORITSU_SYSTEM_FORMAT` | No | `a`（既定）または `b` |

## 制約

- 対応エンドポイントは `POST /v1/chat/completions`（非ストリーミング）のみです。`stream: true` は400で拒否します。
- `/v1/models`・画像生成・responses APIには対応していません。
- `usage` のトークン数は上流が返さないためゼロ埋めです。
- `model` は任意の文字列を受け付け、そのまま応答にエコーします。
