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

| model               | 動作             | 要件     |
| ------------------- | ---------------- | -------- |
| `toritsu`           | 通常チャット     | APIキー  |
| `toritsu-fast`      | 高速モデル       | ログイン |
| `toritsu-reasoning` | 推論モデル       | ログイン |
| `toritsu-agent`     | `toritsu` の別名 | APIキー  |

```sh
# ログイン（WebUIモデル用、1回だけ。Chromeが開くのでログインするだけ）
bun run src/index.ts --login
pi -p "..." --provider toritsu --model toritsu-reasoning
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
