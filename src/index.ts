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

import {
  loadSessionToken,
  saveSessionToken,
  resolveSessionModel,
  checkSession,
  sendSessionMessage,
} from "./session";
import {
  AGENT_MODEL,
  AGENT_SYSTEM,
  MAX_AGENT_TURNS,
  parseAgentLine,
  execAgentAction,
  agentRoot,
} from "./agent";

const TORITSU_API_URL =
  process.env.TORITSU_API_URL ?? "https://ai-api.metro.tokyo.lg.jp/api/v1/public/message";
const PORT = Number(process.env.PORT ?? "3000");
const SYSTEM_FORMAT: SystemFormat = process.env.TORITSU_SYSTEM_FORMAT === "b" ? "b" : "a";
const KEY_FILE = process.env.TORITSU_KEY_FILE;
const SESSION_MODEL = resolveSessionModel();

if (process.argv.includes("--login")) {
  await runLogin();
  process.exit(0);
}

/**
 * セッションログイン：Chromeを自動で開き、ユーザーの手動ログイン後に
 * localStorage のトークンを自動で抜き出して保存する。
 * Chromeが使えない場合のみ手動貼付けにフォールバックする。
 * 学校アカウントの認証情報自体は扱わない。
 */
async function runLogin(): Promise<void> {
  console.log("=== toritsu-openai session login ===");
  console.log("注意: 保存されるのは都立AIのセッショントークンです。");
  console.log("学校アカウント全体へのアクセスに繋がるため、他人と共有しないでください。");
  console.log("");
  const { autoLogin } = await import("./login");
  if (await autoLogin()) {
    return;
  }
  console.log("");
  console.log("--- 手動方式に切替えます ---");
  console.log("1. ブラウザで都立AIにログインしてください。");
  console.log("2. DevTools → Network で api/v1/chat/ へのリクエストを探します。");
  console.log('3. Request Headers の authorization の値（"Bearer " を除いた部分）を貼り付けます。');
  console.log("");
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let token = "";
  try {
    token = (await rl.question("session token: ")).trim();
  } finally {
    rl.close();
  }
  if (token === "") {
    console.error("empty token");
    process.exit(1);
  }
  console.log("validating...");
  if (!(await checkSession(token))) {
    console.error("invalid or expired session token");
    process.exit(1);
  }
  saveSessionToken(token);
  console.log("saved. Restart the server with TORITSU_MODEL=10 (高速) or TORITSU_MODEL=13 (推論).");
}

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
    const watcher = watch(KEY_FILE, (eventType: string) => {
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
    watcher.on("error", (err: Error) => {
      console.error(`[toritsu-openai] key file watcher error: ${err}`);
    });
  } catch (err) {
    console.error(`[toritsu-openai] failed to watch KEY_FILE: ${err}`);
  }
}

function getApiKey(): string {
  return currentApiKey;
}

class UpstreamError extends Error {
  status: number;
  errType: string;
  code?: number;
  constructor(status: number, message: string, errType: string, code?: number) {
    super(message);
    this.status = status;
    this.errType = errType;
    this.code = code;
  }
}

interface PublicResult {
  data: Parameters<typeof toChatCompletion>[1];
  message: string;
  conversationId: string;
}

/** 公開Endpointへの送信を1往復する。失敗時は UpstreamError を投げる */
async function callPublicUpstream(
  input: string,
  cid: string,
  apiKey: string,
): Promise<PublicResult> {
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
      body: JSON.stringify({ input, conversation_id: cid }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new UpstreamError(502, "upstream unreachable", "upstream_unreachable");
  }
  const data = (await upstream.json().catch(() => null)) as PublicResult["data"] | null;
  if (!upstream.ok) {
    if (upstream.status === 401 && KEY_FILE) {
      console.error(`[toritsu-openai] 401 from upstream - key may be expired, refresh ${KEY_FILE}`);
    }
    throw new UpstreamError(
      upstream.status,
      upstreamErrorMessage(data),
      "toritsu_api_error",
      upstream.status,
    );
  }
  if (data === null) {
    throw new UpstreamError(502, "invalid upstream response", "toritsu_api_error");
  }
  const msg = typeof data.message === "string" ? data.message : "";
  const id = data.response?.conversation?.id;
  return { data, message: msg, conversationId: typeof id === "string" ? id : "" };
}

function toErrorJson(err: UpstreamError): Response {
  const e: { message: string; type: string; code?: number } = {
    message: err.message,
    type: err.errType,
  };
  if (err.code !== undefined) {
    e.code = err.code;
  }
  return json({ error: e }, err.status);
}

/**
 * エージェントループ：モデルに [BASH]/[READ] を出させ、プロキシ側で実行し、
 * 結果を返して [ANSWER] が出るまで往復する（最大 MAX_AGENT_TURNS）。
 * 公開Endpointを使用する。実行は TORITSU_AGENT_CWD（既定カレント）に閉じる。
 */
async function runAgentLoop(
  messages: ChatMessage[],
  cid: string,
  apiKey: string,
): Promise<ChatCompletion> {
  const root = agentRoot();
  let input = toToritsuInput(messages, SYSTEM_FORMAT, AGENT_SYSTEM);
  let currentCid = cid;
  let lastText = "";
  for (let i = 0; i < MAX_AGENT_TURNS; i++) {
    const res = await callPublicUpstream(input, currentCid, apiKey);
    if (res.conversationId !== "") {
      currentCid = res.conversationId;
    }
    lastText = res.message;
    const action = parseAgentLine(res.message);
    if (action.kind === "answer") {
      return toChatCompletion(AGENT_MODEL, {
        message: action.text,
        response: { conversation: { id: currentCid } },
      });
    }
    const output = await execAgentAction(action, root);
    const label = action.kind === "bash" ? "BASH" : "READ";
    input = `user: [${label} ${action.arg}] => ${output}`;
  }
  return toChatCompletion(AGENT_MODEL, {
    message: lastText,
    response: { conversation: { id: currentCid } },
  });
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
  const model = typeof body.model === "string" ? body.model : "toritsu-ai";

  // セッションモード：TORITSU_MODEL=10/13 のときはWebUIと同じ
  // セッションEndpointを使い、モデルを選択する。授業キーは使わない。
  if (SESSION_MODEL !== null) {
    const token = loadSessionToken();
    if (token === "") {
      return json(
        {
          error: {
            message: "session mode requires login — run with --login",
            type: "server_error",
          },
        },
        500,
      );
    }
    try {
      const result = await sendSessionMessage({
        input: toToritsuInput(body.messages as ChatMessage[], SYSTEM_FORMAT),
        hid: conversationId,
        model: SESSION_MODEL,
        token,
      });
      const completion = toChatCompletion(model, {
        message: result.content,
        response: { conversation: { id: result.hid } },
      });
      if (stream) {
        return toSSE(completion);
      }
      return c.json(completion);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "session error";
      const expired = msg.startsWith("session expired");
      if (expired) {
        console.error("[toritsu-openai] session expired — run with --login");
      }
      return json(
        { error: { message: msg, type: expired ? "authentication_error" : "toritsu_api_error" } },
        expired ? 401 : 502,
      );
    }
  }

  const extraSystem = useTools ? buildToolsInstruction(tools, body.tool_choice) : undefined;
  const input = toToritsuInput(body.messages as ChatMessage[], SYSTEM_FORMAT, extraSystem);

  // エージェントモード：モデル名 toritsu-agent で有効。BASH/READ をプロキシ側で実行する。
  // セッションモードとの併用不可（公開Endpointを使用）。クライアントの tools は無視する。
  if (model === AGENT_MODEL) {
    try {
      const completion = await runAgentLoop(
        body.messages as ChatMessage[],
        conversationId,
        apiKey,
      );
      if (stream) {
        return toSSE(completion);
      }
      return c.json(completion);
    } catch (err) {
      if (err instanceof UpstreamError) {
        return toErrorJson(err);
      }
      throw err;
    }
  }

  let pub: PublicResult;
  try {
    pub = await callPublicUpstream(input, conversationId, apiKey);
  } catch (err) {
    if (err instanceof UpstreamError) {
      return toErrorJson(err);
    }
    throw err;
  }

  const completion = toChatCompletion(model, pub.data);
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
