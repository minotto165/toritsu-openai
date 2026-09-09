import { Hono } from "hono";
import { PORT } from "./config";
import { invalidRequest, toErrorJson, UpstreamError, type ChatRequest } from "./http";
import { handlePublicChat } from "./public";
import { handleSessionChat, SESSION_MODELS } from "./session";
import { handleAgentChat, AGENT_MODEL } from "./agent";
import { checkSession, saveSessionToken } from "./session";
import type { ChatMessage } from "./translate";

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
  console.log("saved. Use model toritsu-fast (高速) or toritsu-reasoning (推論).");
}

const app = new Hono();

/**
 * モデル名で振分ける薄いルーター。各モデルは必ず有効な行き先を持つ。
 * - toritsu-agent → エージェントループ（公開Endpoint）
 * - toritsu-fast / toritsu-reasoning → セッションEndpoint（要ログイン）
 * - それ以外 → 通常チャット（公開Endpoint）
 */
app.post("/v1/chat/completions", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    model?: unknown;
    messages?: unknown;
    stream?: unknown;
    conversation_id?: unknown;
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

  try {
    if (model === AGENT_MODEL) {
      return await handleAgentChat(req);
    }
    const sessionModel = SESSION_MODELS[model as keyof typeof SESSION_MODELS];
    if (sessionModel !== undefined) {
      return await handleSessionChat(req, sessionModel);
    }
    return await handlePublicChat(req);
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
