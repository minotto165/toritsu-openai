// エントリポイント：薄いルーター＋--login
import { Hono } from "hono";
import { PORT } from "./infra/config";
import { invalidRequest, toErrorJson, UpstreamError, type ChatRequest } from "./infra/http";
import { handleChat } from "./handlers/chat";
import { handleAgentChat } from "./handlers/agent";
import { checkSession, saveSessionToken } from "./upstream/webui";
import { debugRecord } from "./infra/debug";
import type { ChatMessage } from "./text/translate";

if (process.argv.includes("--login")) {
  await runLogin();
  process.exit(0);
}

// エントリポイント：薄いルーター＋--login
/** --login：実Chromeで手動ログイン後にトークンを自動取得（学校認証情報は扱わない） */
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
  console.log("saved. Use model toritsu-fast (高速) or toritsu-reasoning (推論).");
}

const app = new Hono();

/** tools付きは翻訳、なければ通常チャット（送信先はsenderが決定） */
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
  const model = typeof body.model === "string" && body.model !== "" ? body.model : "toritsu";
  const req: ChatRequest = {
    model,
    messages: body.messages as ChatMessage[],
    stream: body.stream === true,
    conversationId: typeof body.conversation_id === "string" ? body.conversation_id : "",
  };
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  debugRecord("client_request", {
    model,
    stream: req.stream,
    conversationId: req.conversationId,
    messages: req.messages,
    tools,
    tool_choice: body.tool_choice ?? null,
  });

  try {
    if (tools.length > 0 && body.tool_choice !== "none") {
      return await handleAgentChat(req, tools);
    }
    return await handleChat(req);
  } catch (err) {
    if (err instanceof UpstreamError) {
      return toErrorJson(err);
    }
    throw err;
  }
});

export default {
  port: PORT,
  fetch: app.fetch,
};
