import { Hono } from "hono";
import { readFileSync, watch } from "node:fs";
import {
  toToritsuInput,
  toChatCompletion,
  upstreamErrorMessage,
  buildToolsInstruction,
  parseAssistantOutput,
  type ChatMessage,
  type ChatCompletion,
  type SystemFormat,
  type ToolDef,
} from "./translate";

const TORITSU_API_URL =
  process.env.TORITSU_API_URL ?? "https://ai-api.metro.tokyo.lg.jp/api/v1/public/message";
const PORT = Number(process.env.PORT ?? "3000");
const SYSTEM_FORMAT: SystemFormat = process.env.TORITSU_SYSTEM_FORMAT === "b" ? "b" : "a";
const KEY_FILE = process.env.TORITSU_KEY_FILE;

let currentApiKey = process.env.TORITSU_API_KEY ?? "";
let keyFingerprint = currentApiKey ? currentApiKey.slice(-4) : "";

if (KEY_FILE) {
  try {
    currentApiKey = readFileSync(KEY_FILE, "utf-8").trim();
    keyFingerprint = currentApiKey.slice(-4);
    console.log(`[toritsu-openai] loaded key from ${KEY_FILE} (fingerprint: ${keyFingerprint})`);
  } catch (err) {
    console.error(`[toritsu-openai] failed to read KEY_FILE: ${err}`);
  }

  try {
    const watcher = watch(KEY_FILE, (eventType) => {
      if (eventType === "change") {
        try {
          const newKey = readFileSync(KEY_FILE, "utf-8").trim();
          if (newKey && newKey !== currentApiKey) {
            currentApiKey = newKey;
            keyFingerprint = newKey.slice(-4);
            console.log(`[toritsu-openai] key reloaded (fingerprint: ${keyFingerprint})`);
          }
        } catch (err) {
          console.error(`[toritsu-openai] failed to reload key: ${err}`);
        }
      }
    });
    watcher.on("error", (err) => {
      console.error(`[toritsu-openai] key file watcher error: ${err}`);
    });
  } catch (err) {
    console.error(`[toritsu-openai] failed to watch KEY_FILE: ${err}`);
  }
}

function getApiKey(): string {
  return currentApiKey;
}

const app = new Hono();

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function invalidRequest(message: string): Response {
  return json({ error: { message, type: "invalid_request_error" } }, 400);
}

/**
 * 疑似SSE：上流は一括応答のみのため、全文をチャンク分割して
 * OpenAI形式の chat.completion.chunk ストリームとして返す。
 * tool_calls の場合は構造化deltaとして1発で流す。
 */
function toSSE(completion: ChatCompletion): Response {
  const choice = completion.choices[0];
  const base = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
  };
  let body = "";
  const toolCalls = choice?.message.tool_calls;
  if (toolCalls !== undefined && toolCalls.length > 0) {
    body += `data: ${JSON.stringify({
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: null, tool_calls: toolCalls },
          finish_reason: null,
        },
      ],
    })}\n\n`;
    body += `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })}\n\n`;
    body += "data: [DONE]\n\n";
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
  const content = choice?.message.content ?? "";
  const SIZE = 60;
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += SIZE) {
    chunks.push(content.slice(i, i + SIZE));
  }
  if (chunks.length === 0) {
    chunks.push("");
  }
  for (const text of chunks) {
    body += `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    })}\n\n`;
  }
  body += `data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`;
  body += "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

app.post("/v1/chat/completions", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    model?: unknown;
    messages?: unknown;
    stream?: unknown;
    conversation_id?: unknown;
    tools?: unknown;
    tool_choice?: unknown;
  } | null;

  if (body === null || !Array.isArray(body.messages) || body.messages.length === 0) {
    return invalidRequest("messages is required");
  }
  const stream = body.stream === true;

  // 上流は tools field を受け付けないため、テキスト指示に変換して畳み込む。
  // 実行役は持たず、tool_calls の判定だけ返してクライアントに実行させる。
  const tools = Array.isArray(body.tools) ? (body.tools as ToolDef[]) : [];
  const useTools = tools.length > 0 && body.tool_choice !== "none";

  const apiKey = getApiKey();
  if (!apiKey) {
    return json(
      { error: { message: "TORITSU_API_KEY or TORITSU_KEY_FILE is not set", type: "server_error" } },
      500,
    );
  }

  const conversationId =
    typeof body.conversation_id === "string" ? body.conversation_id : "";
  const extraSystem = useTools ? buildToolsInstruction(tools, body.tool_choice) : undefined;
  const input = toToritsuInput(body.messages as ChatMessage[], SYSTEM_FORMAT, extraSystem);

  let upstream: Response;
  try {
    upstream = await fetch(TORITSU_API_URL, {
      method: "POST",
      headers: {
        // 上流は Accept-Encoding なしのリクエストを401で拒否するため必須
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      // 上流は {input, conversation_id} 以外のトップレベル field を401で拒否するため厳密にこの2つのみ送る
      body: JSON.stringify({ input, conversation_id: conversationId }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return json(
      { error: { message: "upstream unreachable", type: "upstream_unreachable" } },
      502,
    );
  }

  const data = (await upstream.json().catch(() => null)) as Parameters<
    typeof toChatCompletion
  >[1] | null;

  if (!upstream.ok) {
    if (upstream.status === 401 && KEY_FILE) {
      console.error(`[toritsu-openai] 401 from upstream - key may be expired, refresh ${KEY_FILE}`);
    }
    return json(
      {
        error: {
          message: upstreamErrorMessage(data),
          type: "toritsu_api_error",
          code: upstream.status,
        },
      },
      upstream.status,
    );
  }
  if (data === null) {
    return json(
      { error: { message: "invalid upstream response", type: "toritsu_api_error" } },
      502,
    );
  }

  const model = typeof body.model === "string" ? body.model : "toritsu-ai";
  const completion = toChatCompletion(model, data);
  if (useTools) {
    const raw = completion.choices[0]?.message.content ?? "";
    const parsed = parseAssistantOutput(raw);
    if (parsed.type === "tool_calls") {
      const choice = completion.choices[0];
      if (choice !== undefined) {
        choice.message.content = null;
        choice.message.tool_calls = parsed.calls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.args },
        }));
        choice.finish_reason = "tool_calls";
      }
    } else if (completion.choices[0] !== undefined) {
      completion.choices[0].message.content = parsed.text;
    }
  }
  if (stream) {
    return toSSE(completion);
  }
  return c.json(completion);
});

export default {
  port: PORT,
  fetch: app.fetch,
};
