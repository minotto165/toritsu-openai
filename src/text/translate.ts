// OpenAI形式と都立AI形式の相互変換

export interface ChatMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
}

function toText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** tool結果の上限（超過は切詰め） */
const TOOL_CONTENT_CAP = 4000;

export interface TruncationStats {
  toolCuts: number;
  toolCutChars: number;
}

let truncStats: TruncationStats = { toolCuts: 0, toolCutChars: 0 };

/** 切詰め統計のリセット（toToritsuInputの先頭で呼ぶ） */
export function resetTruncationStats(): void {
  truncStats = { toolCuts: 0, toolCutChars: 0 };
}

export function getTruncationStats(): TruncationStats {
  return { ...truncStats };
}

function capToolText(s: string): string {
  if (s.length <= TOOL_CONTENT_CAP) {
    return s;
  }
  truncStats.toolCuts += 1;
  truncStats.toolCutChars += s.length - TOOL_CONTENT_CAP;
  return `${s.slice(0, TOOL_CONTENT_CAP)}\n...[truncated ${s.length - TOOL_CONTENT_CAP} chars]`;
}

/** 送信対象の選択：新規は全件、継続はsystem＋最新1件（上流が履歴保持のため） */
export function selectMessages(messages: ChatMessage[], conversationId: string): ChatMessage[] {
  if (conversationId === "") {
    return messages;
  }
  const systems = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  if (rest.length === 0) {
    return messages;
  }
  const last = rest[rest.length - 1];
  if (last === undefined) {
    return messages;
  }
  return [...systems, last];
}

/** messages[] を input 文字列1本に畳む（system文頭化・tool行化） */
export function toToritsuInput(messages: ChatMessage[], extraSystem?: string): string {
  resetTruncationStats();
  const systems = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const lines = rest.map((m) => {
    if (m.role === "tool") {
      return `tool: ${capToolText(toText(m.content))}`;
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

/** 上流エラーの表示文抽出 */
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
  /** 実測トークン数のマッピング */
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** 付加field：上流conversation.id */
  conversation_id: string;
}

/** 上流応答→chat.completion 変換 */
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
  // 不正JSON対策：制御文字をエスケープして再試行
  return (
    tryParse(sliced) ??
    tryParse(sliced.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t"))
  );
}

/** 応答テキストを tool_calls / 回答に振り分ける */
export function parseAssistantOutput(text: string): ParsedOutput {
  const obj = extractJson(text);
  if (obj !== null && typeof obj === "object") {
    const calls = (obj as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(calls) && calls.length > 0) {
      const now = Date.now();
      return {
        type: "tool_calls",
        calls: calls.map((c: unknown, i: number) => {
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
  // {"answer": ...} 形式の救済抽出
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
