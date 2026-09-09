// OpenAI messages[] <-> Toritsu AI input 変換

export interface ChatMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
}

/** systemブロックの畳み込み形式。a: system行のまま先頭配置 / b: 【システム指示】ヘッダー化 */
export type SystemFormat = "a" | "b";

export interface ToolDef {
  type?: unknown;
  function?: {
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
  };
}

/**
 * tools定義を上流に渡すための指示文を組み立てる。
 * 上流は tools field を受け付けないため、テキスト指示に変換する。
 */
export function buildToolsInstruction(tools: ToolDef[], toolChoice: unknown): string {
  const lines = tools.map((t) => {
    const fn = t.function ?? {};
    const name = typeof fn.name === "string" ? fn.name : "unknown";
    const desc = typeof fn.description === "string" ? fn.description : "";
    const params = fn.parameters !== undefined ? JSON.stringify(fn.parameters) : "{}";
    return `- ${name}: ${desc} (parameters: ${params})`;
  });
  let extra = "";
  if (toolChoice === "required") {
    extra = "必ずいずれかのツールを使うこと。";
  } else if (
    toolChoice !== null &&
    typeof toolChoice === "object" &&
    (toolChoice as { type?: unknown }).type === "function"
  ) {
    const fn = (toolChoice as { function?: { name?: unknown } }).function;
    const name = fn !== undefined && typeof fn.name === "string" ? fn.name : null;
    if (name !== null) {
      extra = `必ずツール ${name} を使うこと。`;
    }
  }
  return [
    "【利用可能なツール】",
    ...lines,
    "",
    "あなたはJSON出力ゲートウェイとして振る舞え。自然文の応答は禁止であり、出力は1個のJSONオブジェクトのみとする。",
    "手順: 要求の達成にツールが必要ならtool_callsを、不要または全ツール実行済みならanswerを出力せよ。",
    "ツールを使う場合の出力例:",
    '{"tool_calls": [{"id": "call_1", "name": "read_memo", "arguments": {"memo_id": "memo-001"}}]}',
    "最終回答の場合の出力例:",
    '{"answer": "メモの内容は○○です"}',
    "ツールはこのテキスト経由で実際に実行されるため「利用できない」と述べてはならない。argumentsはparametersに適合させよ。",
    extra,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export type ParsedOutput =
  | { type: "tool_calls"; calls: Array<{ id: string; name: string; args: string }> }
  | { type: "answer"; text: string };

function tryParse(s: string): unknown | null {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

function extractJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced !== null ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  const sliced = candidate.slice(start, end + 1);
  // モデルが文字列内に生の改行等を混ぜた不正JSONを返すことがあるため、
  // 厳密パース失敗時は制御文字をエスケープして再試行する
  return (
    tryParse(sliced) ??
    tryParse(sliced.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t"))
  );
}

/**
 * モデルのテキスト応答を tool_calls / 最終回答に振り分ける。
 */
export function parseAssistantOutput(text: string): ParsedOutput {
  const obj = extractJson(text);
  if (obj !== null && typeof obj === "object") {
    const calls = (obj as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(calls) && calls.length > 0) {
      const now = Date.now();
      return {
        type: "tool_calls",
        calls: calls.map((c, i) => {
          const item = (c ?? {}) as { id?: unknown; name?: unknown; arguments?: unknown };
          const args = item.arguments;
          return {
            id: typeof item.id === "string" ? item.id : `call_${now}_${i}`,
            name: typeof item.name === "string" ? item.name : "unknown",
            args: typeof args === "string" ? args : JSON.stringify(args ?? {}),
          };
        }),
      };
    }
    const answer = (obj as { answer?: unknown }).answer;
    if (typeof answer === "string") {
      return { type: "answer", text: answer };
    }
  }
  // 不正JSON救済：{"answer": "..."} の形だけ寛容に抜き出す
  // （コード回答内の生改行・エスケープ漏れの " に対応）
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("```")) {
    const m = text.match(/"answer"\s*:\s*"([\s\S]*)"\s*\}\s*(```\s*)?$/);
    if (m !== null && m[1] !== undefined) {
      const unescaped = m[1]
        .replace(/\\"/g, '"')
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t");
      return { type: "answer", text: unescaped };
    }
  }
  return { type: "answer", text };
}

function toText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/**
 * OpenAI messages[] を都立AIの input 文字列1本に畳む。
 * system role は全て抽出して文頭ブロック化し、残りを "role: content" 行で連結する。
 * role:tool のメッセージはツール実行結果として "tool: ..." 行にする。
 * assistant の tool_calls は文脈維持のためJSON行として残す。
 * extraSystem があれば system ブロックに追記する（tools指示文用）。
 */
export function toToritsuInput(
  messages: ChatMessage[],
  format: SystemFormat = "a",
  extraSystem?: string,
): string {
  const systems = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const lines = rest.map((m) => {
    if (m.role === "tool") {
      return `tool: ${toText(m.content)}`;
    }
    if (m.role === "assistant" && m.tool_calls !== undefined) {
      const head = `assistant: ${toText(m.content)}`;
      return `${head}\nassistant tool_calls: ${JSON.stringify(m.tool_calls)}`;
    }
    return `${m.role}: ${toText(m.content)}`;
  });
  const sysTexts = systems.map((m) => toText(m.content));
  if (extraSystem !== undefined && extraSystem !== "") {
    sysTexts.push(extraSystem);
  }
  if (sysTexts.length === 0) {
    return lines.join("\n");
  }
  if (format === "b") {
    return `【システム指示】\n${sysTexts.join("\n")}\n\n【会話】\n${lines.join("\n")}`;
  }
  const sysLines = sysTexts.map((t) => `system: ${t}`);
  return [...sysLines, ...lines].join("\n");
}

export interface ToritsuResponse {
  message?: unknown;
  response?: {
    conversation?: {
      id?: unknown;
    };
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      total_tokens?: unknown;
    };
  };
  error?: unknown;
  /** バリデーションエラー時の形状 {errors:{field:[msg]}} */
  errors?: Record<string, unknown>;
}

/** 上流エラー応答から表示用メッセージを抜き出す */
export function upstreamErrorMessage(data: ToritsuResponse | null): string {
  if (data === null || typeof data !== "object") {
    return "upstream error";
  }
  if (typeof data.message === "string" && data.message.length > 0) {
    return data.message;
  }
  if (typeof data.error === "string" && data.error.length > 0) {
    return data.error;
  }
  if (data.errors !== undefined && data.errors !== null && typeof data.errors === "object") {
    for (const v of Object.values(data.errors)) {
      const items = Array.isArray(v) ? v : [v];
      for (const item of items) {
        if (typeof item === "string" && item.length > 0) {
          return item;
        }
      }
    }
  }
  return "upstream error";
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason: "stop" | "tool_calls";
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  /** 上流がトークン数を返すため実測値をマッピング（欠落時のみゼロ） */
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** 非標準の付加フィールド：上流の conversation.id をそのまま返す */
  conversation_id: string;
}

/** 都立AIの応答を OpenAI chat.completion 形式に変換する */
export function toChatCompletion(model: string, data: ToritsuResponse): ChatCompletion {
  const conversationId = data.response?.conversation?.id;
  const upstreamUsage = data.response?.usage;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const now = Date.now();
  return {
    id: `chatcmpl-toritsu-${now}`,
    object: "chat.completion",
    created: Math.floor(now / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: toText(data.message ?? "") },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: num(upstreamUsage?.input_tokens),
      completion_tokens: num(upstreamUsage?.output_tokens),
      total_tokens: num(upstreamUsage?.total_tokens),
    },
    conversation_id: typeof conversationId === "string" ? conversationId : "",
  };
}
