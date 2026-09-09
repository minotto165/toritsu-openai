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

都立AI側にsystem枠がないため、`system` roleのメッセージは文頭に `system: ...` 行として配置して送ります（live検証で効果を確認済み）。環境変数 `TORITSU_SYSTEM_FORMAT=b` で形式B（`【システム指示】` ヘッダー化）にも切替えできます（効果は同等確認済み）。

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

## エージェントモード（`toritsu-agent` モデル）

`model` に `toritsu-agent` を指定すると、プロキシ側でコマンド実行を伴う往復ループが動きます（BASH/READ）。`pi` 等のエージェントから実ディレクトリ参照が可能です。

```sh
TORITSU_AGENT_CWD=/Users/minotto/dev/toritsu-openai bun run src/index.ts
pi -p "現在のディレクトリの内容をまとめて" --provider toritsu --model toritsu-agent
```

- 実行範囲は `TORITSU_AGENT_CWD`（既定は起動ディレクトリ）配下に限定。READの脱出・BASHはtimeout 30秒・出力8000文字cap
- 1タスクで上流呼び出しが数回発生します（クォータ消費に注意、最大5往復）
- セッションモードとの併用不可（公開Endpointを使用）。`TORITSU_MODEL=10/13` 設定時に `toritsu-agent` を使うと409エラーになります
- クライアント側の `tools` は無視されます

> ⚠️ 注意：あなたの権限でコマンドが実行されます。サーバーを外部公開した状態での使用は危険です。ローカル利用に限ってください。

## モデル選択（セッションモード・任意）

既定では授業APIキー方式（単一モデル）で動作します。WebUIと同じ推論モデル（`13`）・高速モデル（`10`）を使いたい場合は、学校セッションを使うセッションモードに切替えます。

```sh
# 1. ログイン（Chromeが自動で開くので都立AIにログインするだけ。トークンは自動取得）
bun run src/index.ts --login
# 2. モデル指定で起動
TORITSU_MODEL=13 bun run src/index.ts
```

| `TORITSU_MODEL` | 意味 |
| --- | --- |
| 未設定 | 授業キー方式（既定） |
| `10` | 高速モデル（セッション方式） |
| `13` | 推論モデル（セッション方式） |

セッションモードでは `conversation_id` にWebUIの会話ID（`hid`）が入ります。授業キー方式のIDとは互換がありません。

> ⚠️ 注意：セッショントークンは学校アカウント全体へのアクセスに繋がります。`~/.config/toritsu-openai/session`（パーミッション0600）にのみ保存し、他人と共有しないでください。ログ・報告・gitのいずれにも含めないでください。

## 環境変数

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `TORITSU_API_KEY` | Yes（どちらか） | 都立AIのAPIキー（直指定） |
| `TORITSU_KEY_FILE` | Yes（どちらか） | APIキーが書かれたファイルのパス（ホットリロード対応、1時間ごとの貼り替えに再起動不要） |
| `TORITSU_SESSION` | セッションモード用 | WebUIのセッショントークン（`--login` で保存したファイルよりenv優先） |
| `TORITSU_MODEL` | セッションモード用 | `10`=高速、`13`=推論。未設定・空・その他（例：`off`）なら授業キー方式。`.env` に値がある場合は起動時の環境変数が優先される |
| `PORT` | No | 待受ポート（既定3000） |
| `TORITSU_API_URL` | No | 上流URLの上書き（テスト用） |
| `TORITSU_SYSTEM_FORMAT` | No | `a`（既定）または `b` |

## 制約

- 対応エンドポイントは `POST /v1/chat/completions` のみです。
- `stream: true` には疑似ストリーミングで応答します（上流は一括応答のため、全文を分割してSSE形式で配信）。
- 上流の `input` は20000文字以下です。これを超えると400エラーになります。
- `/v1/models`・画像生成・responses APIには対応していません。
- `usage` のトークン数は上流の実測値をマッピングしています。
- `model` は任意の文字列を受け付け、そのまま応答にエコーします。
- 上流の裏側は Azure OpenAI 系のモデルが動いていますが、function calling等のツール利用は公開エンドポイント経由では使えません（余分なフィールドを送ると上流が拒否します）。
- `tools` 付きリクエストは実験的に受け付けます（ツール定義をテキスト指示に変換し、モデルがJSONで返せば `tool_calls` として返却）。ただし裏側モデルの指示追従の都合で高確率で直接回答になります。エージェント用途の動作保証はありません。
