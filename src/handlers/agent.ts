// 翻訳ハンドラ：tools指示化→tool_calls返却（実行はクライアント側）
import { getApiKey } from "../infra/config";
import { json, toSSE, type ChatRequest } from "../infra/http";
import { debugRecord } from "../infra/debug";
import { sendUpstream, type SendResult } from "../upstream/sender";
import { forgetSession, isStaleSessionError, recordSession } from "../infra/sessionmap";
import {
  toToritsuInput,
  toChatCompletion,
  parseAssistantOutput,
  selectMessages,
  type ChatMessage,
} from "../text/translate";

/** 自前軽量system（先頭付与・独立変数） */
const DEFAULT_AGENT_IDENTITY = "You are a helpful coding assistant.";

export function agentIdentity(): string {
  const custom = (process.env.TORITSU_AGENT_SYSTEM ?? "").trim();
  return custom !== "" ? custom : DEFAULT_AGENT_IDENTITY;
}

/** 保持するクライアントsystemの上限。超過分は捨てる（機構部を守るため） */
const KEPT_SYSTEM_CAP = 3000;
const INPUT_BUDGET = 18000;
const HEAD_KEEP = 2000;

export function shrinkInput(input: string): { text: string; cut: number } {
  if (input.length <= INPUT_BUDGET) {
    return { text: input, cut: 0 };
  }
  return {
    text:
      `${input.slice(0, HEAD_KEEP)}\n...[omitted ${input.length - INPUT_BUDGET} chars of the middle section]...\n` +
      input.slice(input.length - (INPUT_BUDGET - HEAD_KEEP)),
    cut: input.length - INPUT_BUDGET,
  };
}

/** tool_calls応答の組み立て（呼出し成功・再試行成功の共通処理） */
function toolCallsResponse(
  req: ChatRequest,
  calls: Array<{ id: string; name: string; args: string }>,
  cid: string,
  usage: SendResult["usage"],
): Response {
  const completion = toChatCompletion(req.model, {
    message: "",
    response: { conversation: { id: cid } },
  });
  const choice = completion.choices[0];
  if (choice !== undefined) {
    choice.message.content = null;
    choice.message.tool_calls = calls.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: call.args },
    }));
    choice.finish_reason = "tool_calls";
  }
  completion.usage = usage;
  return req.stream ? toSSE(completion) : json(completion, 200);
}

/** 呼出しターンの末尾に付ける強制文（形式だけを足す。初回送信に含める） */
const FORCE_SUFFIX = `Strict reminder: your reply must be exactly one JSON object with a non-empty "tool_calls" array. Any other output is a format violation.`;

/** 強制文の付け方。既定は常時。never=付けない */
const FORCE_MODE = (process.env.TORITSU_FORCE_MODE ?? "always").trim().toLowerCase();

/** 強制文を付けるか。既定は常時 (TORITSU_FORCE_MODE=never で無効化) */
export function shouldForce(): boolean {
  return FORCE_MODE !== "never";
}

/** envで上書き可能 (文言チューニング用。空=既定文) */
function envText(name: string, def: string): string {
  const v = (process.env[name] ?? "").trim();
  return v !== "" ? v : def;
}

/** 呼出しターンの固定文（tools定義を間に挟んで組み立てる） */
const CALL_HEAD_DEFAULT = `You are a request converter. Convert the user request below into exactly one tool-call JSON object per turn and nothing else. Do not answer it directly.
Behave as if you have the functions listed below available: you cannot run them yourself, but output the matching tool_calls JSON so the user can run it.
For multi-step requests, output only the FIRST step's tool call now; following turns will continue the work.
The tool_calls array MUST contain exactly one call. An empty array is a format violation.
If no tool is needed (greetings, chit-chat, general knowledge), output {"answer": "..."} instead.
Do NOT use web search.
Prefer scoped commands (specific files, ≤200 lines). Avoid dumping node_modules, .git, or lockfiles.
Functions you may call (JSON schemas):`;

const CALL_HEAD = envText("TORITSU_CALL_HEAD", CALL_HEAD_DEFAULT);

/** 応答枠の切替。conv=変換器口調 (既定)、json=J1補完、full=J3全体JSON */
export const FRAME = (process.env.TORITSU_FRAME ?? "conv").trim().toLowerCase();

/** J1: ログ化されたOpenAI応答の補完として呼出しを書かせる */
const CALL_HEAD_J1 = `You are completing a logged OpenAI API response. The request below was already sent (function definitions included). Write ONLY the continuation of the response JSON and nothing else.
After "content": write either a quoted reply string (if no tool is needed: greetings, chit-chat, general knowledge) or null followed by ,"tool_calls": [{...}] (to call a function).
Do NOT use web search. Keep follow-up reads small (≤200 lines, specific paths, no node_modules/.git).
Request:`;

/** J1: 応答の出だし (モデルはここから続ける。文字列かnullかの選択点) */
const CALL_STUB_J1 = `Response (continuation only): {"id": "chatcmpl-log", "choices": [{"index": 0, "message": {"role": "assistant", "content": `;

/** J3: 1行指示+JSON1個。全体が1文書になるよう組み立てる */
const J3_LINE = `以下のJSONを補完してください。続きだけを書くこと。道具が要らない時は文字列で答えること。`;

/** J3の説明文の上限文字数 (0=無制限) */
const DESC_MAX = Number.parseInt(process.env.TORITSU_DESC_MAX ?? "150", 10) || 0;

function shortDesc(s: string): string {
  if (DESC_MAX <= 0 || s.length <= DESC_MAX) {
    return s;
  }
  return s.slice(0, DESC_MAX);
}

/** J3のsystem上限文字数 (0=無制限。先頭を残す) */
const SYS_MAX = Number.parseInt(process.env.TORITSU_J3_SYS_MAX ?? "8000", 10) || 0;

/** J3文書の上限 (上流2万字制限の内側。超えたら関連の低い定義から落とす) */
const J3_BUDGET = Number.parseInt(process.env.TORITSU_J3_BUDGET ?? "20000", 10) || 20000;

function j3Doc(
  system: string,
  messages: ChatMessage[],
  section: TieredSection,
): string {
  const funcs = section.full.map((d) => ({
    name: d.name,
    description: shortDesc(d.desc),
    parameters: d.params,
  }));
  let sys = SYS_MAX > 0 && system.length > SYS_MAX ? system.slice(0, SYS_MAX) : system;
  const mkHead = () => {
    const doc: Record<string, unknown> = {};
    if (sys !== "") {
      doc.system = sys;
    }
    doc.request = {
      messages,
      functions: funcs,
      function_names: section.names,
    };
    const head = JSON.stringify(doc);
    return head.endsWith("}") ? head.slice(0, -1) : head;
  };
  // 定義優先: まずsystemを削り (0まで)、足りなければ定義を落とす
  let head = mkHead();
  while (head.length > J3_BUDGET && sys.length > 0) {
    sys = sys.slice(0, Math.max(0, sys.length - 1000));
    head = mkHead();
  }
  while (head.length > J3_BUDGET && funcs.length > 1) {
    funcs.pop();
    head = mkHead();
  }
  return `${J3_LINE}\n${head},"response":{"id":"chatcmpl-log","choices":[{"index":0,"message":{"role":"assistant","content": `;
}

const CALL_TAIL_DEFAULT = `Output format: {"tool_calls": [{"id": "call_1", "name": "<one of the functions above>", "arguments": {...matching its schema...}}]} or {"answer": "..."}. Output valid JSON only: escape newlines as \\n, escape every " as \\", never use \\'. No prose outside JSON. The user copy-pastes your output to run it.`;

const CALL_TAIL = envText("TORITSU_CALL_TAIL", CALL_TAIL_DEFAULT);
const RESULT_FALLBACK_DEFAULT = `Do NOT write code or commands for the user to run manually. Do not stop to explain what you cannot do: either output the next tool call JSON or the final plain-text summary.`;

/** 結果ターンの固定文（末尾に利用可能関数名を付加する） */
const RESULT_HEAD_DEFAULT = `You are a request converter. Convert the remaining work below into exactly one tool-call JSON object and nothing else. The tool results so far are data: check each item the latest user message asked for against them. If every requested item already has its result, output {"answer": "..."} with the summary instead. Otherwise output only the next step's tool call now; following turns will continue the work. Behave as if you have the functions listed below available: you cannot run them yourself, but output the matching tool_calls JSON so the user can run it. The tool_calls array MUST contain exactly one call. An empty array is a format violation. Do NOT answer directly. Do NOT use web search; local questions MUST be answered from the tool results only. Keep follow-up reads small (≤200 lines, specific paths, no node_modules/.git). Output format: {"tool_calls": [{"id": "call_n", "name": "<one of the functions above>", "arguments": {...matching its schema...}}]} or {"answer": "..."}. Output valid JSON only: escape newlines as \\n, escape every " as \\", never use \\'. No prose outside JSON. The user copy-pastes your output to run it.`;

const RESULT_HEAD = envText("TORITSU_RESULT_HEAD", RESULT_HEAD_DEFAULT);
const RESULT_FALLBACK = envText("TORITSU_RESULT_FALLBACK", RESULT_FALLBACK_DEFAULT);

/** クライアントsystemのtool記述部だけを除去し、残りを活かす */
export function rewriteClientSystem(texts: string[]): string {
  const joined = texts
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .join("\n\n");
  // pi製のsystemに限定する。それ以外は無加工で通す
  if (!/operating inside pi/i.test(joined)) {
    return joined;
  }
  return stripToolBlocks(joined);
}

function stripToolBlocks(t: string): string {
  const lines = t.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    // (1) "Available tools" 見出し＋続く箇条書き＋tool言及パラグラフ
    if (/^\s*#{0,4}\s*available tools\s*:?\s*$/i.test(line)) {
      i++;
      while (i < lines.length && /^\s*([-*]\s+|\d+[.)]\s+)/.test(lines[i] as string)) {
        i++;
      }
      // 空行を跨いで続くtool言及パラグラフも除去する
      while (i < lines.length) {
        const l = lines[i] as string;
        if (l.trim() === "") {
          i++;
          continue;
        }
        if (/tool/i.test(l)) {
          i++;
          continue;
        }
        break;
      }
      continue;
    }
    // (2) tool定義を含む見出し＋配下のみ除去する。
    // 定義形状（- 名前: 説明）がない行動規範（例：Tool usage policy）は残す
    if (/^\s*#{1,4}\s+.*\btools?\b/i.test(line)) {
      let j = i + 1;
      let hasDef = false;
      while (
        j < lines.length &&
        ((lines[j] as string).trim() === "" ||
          /^\s*([-*]\s+|\d+[.)]\s+|>|\s)/.test(lines[j] as string))
      ) {
        if (/^\s*[-*]\s*`?[A-Za-z_][\w-]*`?\s*:/.test(lines[j] as string)) {
          hasDef = true;
        }
        j++;
      }
      if (hasDef) {
        i = j;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** tool定義の正規化形 */
export interface ToolDef {
  name: string;
  desc: string;
  params: unknown;
}

export function parseToolDef(t: unknown, i: number): ToolDef {
  const o = (t ?? {}) as { type?: unknown; function?: unknown };
  const fn = (o.function ?? {}) as {
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
  };
  return {
    name: typeof fn.name === "string" ? fn.name : `tool_${i}`,
    desc: typeof fn.description === "string" ? fn.description : "",
    params: fn.parameters !== undefined ? fn.parameters : {},
  };
}

const DESC_CAP = 120;
const MSG_BUDGET = 3000;
const TAIL_RESERVE = 600;
const EXTRA_MARGIN = 1200;

/** スキーマから冗長キーを除去（名前・型・必須・enumだけ残す） */
export function slimSchema(o: unknown): unknown {
  if (Array.isArray(o)) {
    return o.map(slimSchema);
  }
  if (o !== null && typeof o === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k === "description" || k === "examples" || k === "default" || k === "title") {
        continue;
      }
      out[k] = slimSchema(v);
    }
    return out;
  }
  return o;
}

function fullDefLine(d: ToolDef): string {
  const params = JSON.stringify(slimSchema(d.params));
  return `- ${d.name}: ${d.desc.slice(0, DESC_CAP)} (parameters: ${params})`;
}

function nameOnlyLine(d: ToolDef): string {
  const p = (d.params ?? {}) as { required?: unknown; properties?: unknown };
  const req = Array.isArray(p.required)
    ? p.required.filter((v): v is string => typeof v === "string")
    : [];
  const props =
    p.properties !== null && typeof p.properties === "object"
      ? (p.properties as Record<string, unknown>)
      : {};
  const reqSchemas = req.map((n) => {
    const s = props[n] as { type?: unknown } | undefined;
    const t = s !== undefined && typeof s.type === "string" ? s.type : "string";
    return `${n}: ${t}`;
  });
  const opt = Object.keys(props).filter((k) => !req.includes(k));
  const shownOpt = opt.slice(0, 8);
  const more = opt.length > shownOpt.length ? ` +${opt.length - shownOpt.length} more` : "";
  const optPart = shownOpt.length > 0 || more !== "" ? `; optional: ${shownOpt.join(", ")}${more}` : "";
  return `- ${d.name} (args: {${reqSchemas.join(", ")}}${optPart})`;
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
}

/** 日本語の行動語→英語tool語彙の対応 (クエリが日本語でも関連付けできるよう) */
const JP_SYNONYMS: Array<[RegExp, string[]]> = [
  [/読|開/, ["read"]],
  [/書|作成|作って|作り|生成/, ["write", "create", "edit"]],
  [/実行|動か|走らせ|コマンド|叩/, ["run", "bash", "exec", "execute", "shell"]],
  [/探|検索|調べ|見つけ|サーチ/, ["search", "grep", "find", "glob"]],
  [/一覧|リスト|表示|見せ/, ["list", "glob", "ls"]],
  [/削除|消し|除去/, ["delete", "remove"]],
  [/編集|直し|修正|書き換え/, ["edit", "patch", "update"]],
  [/確認|チェック|状態|調べ/, ["get", "check", "status", "show"]],
  [/送|通知|投稿/, ["send", "post", "notify"]],
  [/要約|まとめ|概要|中身|一覧化/, ["read", "list", "glob"]],
];

/** 日本語クエリから英語tool語彙を補う */
function jpTokens(query: string): string[] {
  const out: string[] = [];
  for (const [re, words] of JP_SYNONYMS) {
    if (re.test(query)) {
      out.push(...words);
    }
  }
  return out;
}

/** 必須引数のダミー値（正解例の形だけ示す用） */
function dummyArgs(params: unknown): Record<string, unknown> {
  const p = (params ?? {}) as { required?: unknown; properties?: unknown };
  const req = Array.isArray(p.required)
    ? p.required.filter((v): v is string => typeof v === "string")
    : [];
  const props =
    p.properties !== null && typeof p.properties === "object"
      ? (p.properties as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  for (const n of req) {
    const s = props[n] as { type?: unknown } | undefined;
    const t = s !== undefined && typeof s.type === "string" ? s.type : "string";
    out[n] = t === "number" || t === "integer" ? 0 : t === "boolean" ? true : t === "array" ? [] : t === "object" ? {} : "x";
  }
  return out;
}

/** 関連首位toolの正解例1件（形だけ見せる。値はダミー） */
function formatExample(d: ToolDef): string {
  const want = d.desc !== "" ? d.desc.slice(0, 100) : `use ${d.name}`;
  const envelope = {
    tool_calls: [{ id: "call_1", name: d.name, arguments: JSON.stringify(dummyArgs(d.params)) }],
  };
  return `Example (output shape only):\nRequest: ${want}\nOutput: ${JSON.stringify(envelope)}`;
}

export interface RankContext {
  query: string;
  recent: string[];
}

/** リクエストから関連度判定材料を作る（最新文面＋直近の呼出し名） */
export function rankContext(messages: ChatMessage[]): RankContext {
  const texts = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter((s) => s !== "");
  const recent: string[] = [];
  for (const m of messages) {
    const tc = (m as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(tc)) {
      for (const c of tc) {
        const item = (c ?? {}) as { name?: unknown; function?: { name?: unknown } };
        const n = item.name ?? item.function?.name;
        if (typeof n === "string") {
          recent.push(n);
        }
      }
    }
  }
  return { query: texts.slice(-3).join("\n"), recent: recent.slice(-8) };
}

function scoreTool(d: ToolDef, qtokens: Set<string>, recent: Set<string>): number {
  let s = 0;
  if (recent.has(d.name)) {
    s += 5;
  }
  const nameParts = d.name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length >= 3);
  for (const p of nameParts) {
    if (qtokens.has(p)) {
      s += 2;
    }
  }
  // 説明文の一致は+1まで (巨大な説明文が名前一致を上回らないよう)
  const dw = new Set(tokens(d.desc));
  for (const q of qtokens) {
    if (dw.has(q)) {
      s += 1;
      break;
    }
  }
  return s;
}

export interface TieredSection {
  text: string;
  tier2Count: number;
  tier1Count: number;
  top: ToolDef | undefined;
  /** 関連順のフル定義 (J3用) */
  full: ToolDef[];
  /** 全tool名 (クライアント順、J3用) */
  names: string[];
}

/** フルスキーマ掲載の上限件数 (0=文字数予算のみ)。希釈対策 */
const TIER2_MAX = ((): number => {
  const v = Number((process.env.TORITSU_TIER2_MAX ?? "").trim());
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
})();

/**
 * 2層カタログを組み立てる。全toolの名前は必ず載せ、フルスキーマは
 * 関連上位から予算内で載せる（上流の文字数上限内に収めるため）
 */
export function tieredToolSection(
  tools: unknown[],
  rank: RankContext,
  tier2Budget: number,
): TieredSection {
  const defs = tools.map(parseToolDef);
  const qtokens = new Set([...tokens(rank.query), ...jpTokens(rank.query)]);
  const recent = new Set(rank.recent);
  const ranked = defs
    .map((d, i) => ({ d, i, s: scoreTool(d, qtokens, recent) }))
    .sort((a, b) => b.s - a.s || a.i - b.i);
  const fullLines: string[] = [];
  const fullDefs: ToolDef[] = [];
  const rest: ToolDef[] = [];
  let used = 0;
  for (const { d } of ranked) {
    const line = fullDefLine(d);
    if (
      used + line.length + 1 <= tier2Budget &&
      (TIER2_MAX <= 0 || fullLines.length < TIER2_MAX)
    ) {
      fullLines.push(line);
      fullDefs.push(d);
      used += line.length + 1;
    } else {
      rest.push(d);
    }
  }
  // name-only層は元のクライアント順に戻す
  const restSet = new Set(rest);
  const nameLines = defs.filter((d) => restSet.has(d)).map(nameOnlyLine);
  const head = fullLines.join("\n");
  const first = ranked.length > 0 ? (ranked[0] as { d: ToolDef }).d : undefined;
  const allNames = defs.map((d) => d.name);
  if (nameLines.length === 0) {
    return {
      text: head,
      tier2Count: fullLines.length,
      tier1Count: 0,
      top: first,
      full: fullDefs,
      names: allNames,
    };
  }
  const note = `Additional functions (compact args shown; you may call any function listed):`;
  return {
    text: `${head}\n${note}\n${nameLines.join("\n")}`,
    tier2Count: fullLines.length,
    tier1Count: nameLines.length,
    top: first,
    full: fullDefs,
    names: allNames,
  };
}

export interface PreambleBuild {
  body: string;
  tier2Count: number;
  tier1Count: number;
  top: ToolDef | undefined;
}

/** 機構＋2層カタログを予算内で組み立てる */
export function buildAgentPreamble(
  tools: unknown[],
  rank: RankContext,
  keptSystem: string,
  isResultTurn: boolean,
  j1Request = "",
  j3payload: { system: string; messages: ChatMessage[] } | null = null,
): PreambleBuild {
  const useJ1 = FRAME === "json" && !isResultTurn;
  const useJ3 = FRAME === "full" && !isResultTurn && j3payload !== null;
  const defs = tools.map(parseToolDef);
  const tier1All = defs.map(nameOnlyLine).join("\n").length;
  const head = isResultTurn ? RESULT_HEAD : useJ1 ? CALL_HEAD_J1 : CALL_HEAD;
  const tail = isResultTurn ? RESULT_FALLBACK : CALL_TAIL;
  const stub = useJ1 ? `\n${CALL_STUB_J1}` : "";
  const baseLen =
    agentIdentity().length +
    head.length +
    tail.length +
    j1Request.length +
    stub.length +
    // ※J3は文書内でsystem配分を自前管理するため前段では食わせない
    (useJ3 ? 0 : keptSystem.length) +
    EXTRA_MARGIN;
  const tier2Budget = Math.max(
    0,
    INPUT_BUDGET - baseLen - tier1All - MSG_BUDGET - TAIL_RESERVE,
  );
  const section = tieredToolSection(tools, rank, tier2Budget);
  // 呼出しターンのみ関連首位の正解例を1件添える（形の学習用）。
  // シグナルなし（英語語彙も履歴もゼロ）の時は付けない。無関係な例がノイズになるため
  // ※結果turnへの正解例はsummary破壊が実測されたため付けない
  const hasSignal = rank.recent.length > 0 || tokens(rank.query).length > 0;
  const example =
    !isResultTurn && hasSignal && section.top !== undefined
      ? `\n${formatExample(section.top)}`
      : "";
  const body = isResultTurn
    ? `${agentIdentity()}\n${RESULT_HEAD}\n${section.text}${example}\n${RESULT_FALLBACK}`
    : useJ3 && j3payload !== null
      ? j3Doc(j3payload.system, j3payload.messages, section)
      : useJ1
        ? `${agentIdentity()}\n${CALL_HEAD_J1}\n${j1Request}\n${section.text}${example}\n${CALL_STUB_J1}`
        : `${agentIdentity()}\n${CALL_HEAD}\n${section.text}${example}\n${CALL_TAIL}`;
  return { body, tier2Count: section.tier2Count, tier1Count: section.tier1Count, top: section.top };
}

/** tools定義→指示文（2層カタログ版） */
export function agentToolPreamble(
  tools: unknown[],
  rank: RankContext = { query: "", recent: [] },
  tier2Budget = 10000,
): string {
  const section = tieredToolSection(tools, rank, tier2Budget);
  return `${agentIdentity()}\n${CALL_HEAD}\n${section.text}\n${CALL_TAIL}`;
}

/** 結果ターン用指示（2層カタログ版） */
export function agentResultPreamble(
  tools: unknown[] = [],
  rank: RankContext = { query: "", recent: [] },
  tier2Budget = 10000,
): string {
  const section = tieredToolSection(tools, rank, tier2Budget);
  return `${agentIdentity()}\n${RESULT_HEAD}\n${section.text}\n${RESULT_FALLBACK}`;
}

/** 偽の成功形 (thin): 関連首位toolの呼出し1件を履歴の形で見せる。
 *  tool結果は付けない (偽の環境事実を作らないため) */
function fakeHistory(top: ToolDef | undefined): ChatMessage[] {
  if (top === undefined) {
    return [];
  }
  const want = top.desc !== "" ? top.desc.slice(0, 100) : `use ${top.name}`;
  return [
    { role: "user", content: `Request: ${want}` },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "cf1",
          type: "function",
          function: { name: top.name, arguments: JSON.stringify(dummyArgs(top.params)) },
        },
      ],
    },
  ];
}

/** 偽形を付けるか。TORITSU_FAKE_HISTORY=0 で無効 (既定は有効) */
function fakeEnabled(): boolean {
  return (process.env.TORITSU_FAKE_HISTORY ?? "1").trim() !== "0";
}

/** 呼出し再試行の上限 (TORITSU_CALL_RETRY、既定1=best-of-2)。0=無効 */
function callRetryMax(): number {
  const v = Number((process.env.TORITSU_CALL_RETRY ?? "1").trim());
  if (!Number.isFinite(v) || v < 0) {
    return 1;
  }
  return Math.min(2, Math.floor(v));
}

/** 前回が拒否テキストだった時の追い文 */
const RETRY_SUFFIX = `Your previous reply contained no tool call. Reply now with exactly one JSON object and nothing else.`;

/** 古いメッセージから削る（最新リクエストと直近結果を守る） */
export function trimMessages(
  messages: ChatMessage[],
  budget: number,
): { messages: ChatMessage[]; dropped: number } {
  const sizes = messages.map((m) => {
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return m.role.length + c.length + 32;
  });
  let used = 0;
  let keepFrom = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const s = sizes[i] as number;
    if (used + s > budget && keepFrom < messages.length) {
      break;
    }
    used += s;
    keepFrom = i;
  }
  const dropped = keepFrom;
  if (dropped === 0) {
    return { messages, dropped: 0 };
  }
  const marker: ChatMessage = {
    role: "user",
    content: `...[${dropped} older messages omitted]...`,
  };
  return { messages: [marker, ...messages.slice(keepFrom)], dropped };
}

/** J1用リクエストJSON (6000字cap)。送った履歴の見せ玉 */
function j1RequestEcho(messages: ChatMessage[]): string {
  const s = JSON.stringify(messages);
  return s.length > 6000 ? `${s.slice(0, 6000)}\n...[truncated]` : s;
}

/** [...] 対応の角括弧抜き出し */
function extractBracketArray(text: string, from: number): string | null {
  const open = text.indexOf("[", from);
  if (open < 0) {
    return null;
  }
  let depth = 0;
  let inStr = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") {
        i++;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) {
        return text.slice(open, i + 1);
      }
    }
  }
  return null;
}

/** J1補完の解釈: 文字列なら回答、tool_calls配列が見えたら呼出し。不明名は落とす */
function parseJ1Continuation(
  text: string,
  valid: Set<string>,
): ReturnType<typeof parseAssistantOutput> {
  const t = text.trimStart();
  const strM = t.match(/^"(?:[^"\\]|\\.)*"/);
  if (strM !== null) {
    try {
      return { type: "answer", text: JSON.parse(strM[0]) as string };
    } catch {
      // fallthrough
    }
  }
  const rest = t
    .replace(/^null\s*,?/, "")
    .replace(/^[\s,]*"tool_calls"\s*:\s*\[/, "");
  // 候補: 全体ラップ + 入れ子の各 tool_calls 配列 (殻ごと反復への対処)
  const spans: string[] = [`{"tool_calls": [${rest}`];
  let idx = 0;
  for (;;) {
    const k = t.indexOf('"tool_calls"', idx);
    if (k < 0) {
      break;
    }
    const arr = extractBracketArray(t, k);
    if (arr !== null) {
      spans.push(`{"tool_calls": ${arr}}`);
    }
    idx = k + 1;
  }
  for (const s of spans) {
    const parsed = parseAssistantOutput(s);
    if (parsed.type === "tool_calls") {
      const known = parsed.calls.filter((c) => valid.has(c.name));
      if (known.length > 0) {
        return { type: "tool_calls", calls: known };
      }
    }
  }
  return { type: "answer", text: text.trim() };
}

/**
 * エージェントチャット：tools定義をテキスト指示に変換し、モデルが出した
 * tool_calls JSON をそのまま返す。呼出しが出なければ直接回答として返す。
 */
export async function handleAgentChat(
  req: ChatRequest,
  tools: unknown[],
): Promise<Response> {
  const attempt = async (): Promise<Response> => {
  // 末尾roleで判定：tool結果直後だけ回答許可、それ以外は呼出し強要に戻す
  const lastMsg = req.messages.length > 0 ? req.messages[req.messages.length - 1] : undefined;
  const isToolResultTurn = lastMsg !== undefined && lastMsg.role === "tool";
  // クライアントsystemはtool記述部だけ除去して活かす。
  // 巨大systemは機構部を守るため先頭3000文字に切る
  // TORITSU_KEEP_SYSTEM=0 で除去して機構部だけにする (チューニング用)
  const keepSystem = (process.env.TORITSU_KEEP_SYSTEM ?? "1").trim() !== "0";
  const keptRaw = keepSystem
    ? rewriteClientSystem(
        req.messages
          .filter((m) => m.role === "system")
          .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))),
      )
    : "";
  const keptSystem =
    keptRaw.length > KEPT_SYSTEM_CAP ? `${keptRaw.slice(0, KEPT_SYSTEM_CAP)}\n...[system truncated]` : keptRaw;
  const rank = rankContext(req.messages.filter((m) => m.role !== "system"));
  const useJ1 = FRAME === "json" && !isToolResultTurn;
  const useJ3 = FRAME === "full" && !isToolResultTurn;
  const useJson = useJ1 || useJ3;
  const nonSystem = req.messages.filter((m) => m.role !== "system");
  const built = buildAgentPreamble(
    tools,
    rank,
    keptSystem,
    isToolResultTurn,
    useJ1 ? j1RequestEcho(nonSystem) : "",
    useJ3 ? { system: keptSystem, messages: nonSystem } : null,
  );
  // 機構部を先に置く（2層カタログは予算内で収まる設計）
  // ※J3は全体が1文書なのでsystem追記なし
  const preamble = useJ3 ? built.body : `${built.body}${keptSystem !== "" ? `\n${keptSystem}` : ""}`;
  // 偽の成功形は呼出しturnに付ける (結果turnには付けない。要約破壊の実測があるため)
  // ※J3は枠自体が指示を持つため強制文なし
  const force = useJ3 ? "" : shouldForce() ? `\n\n${FORCE_SUFFIX}` : "";
  const fake = fakeEnabled() && !isToolResultTurn ? fakeHistory(built.top) : [];
  // 継続ターンは最新1件のみ送る（上流が履歴を保持しているため）
  const selected = selectMessages(
    [...fake, ...req.messages.filter((m) => m.role !== "system")],
    req.conversationId,
  );
  // 新規ターン（全履歴再送）は古い方から削り、最新リクエストとカタログを守る
  const { messages } = trimMessages(selected, MSG_BUDGET);
  const shrunk = shrinkInput(toToritsuInput(messages, preamble));
  // ※J3は文書単体で完結させる (履歴行・system追記なし。予算内収め済みなので切り詰めなし)
  const input = useJ3 ? preamble : shrunk.text;
  debugRecord("agent_upstream_input", { input });

  // 強制文は呼出しturnに付ける (TORITSU_FORCE_MODE=never で無効化可)
  // 呼出しturnでテキスト拒否が返ったら追い文で再送 (best-of-2)
  const maxRetry = !isToolResultTurn ? callRetryMax() : 0;
  let r = await sendUpstream(req, `${input}${force}`);
  debugRecord("agent_upstream_output", { text: r.text, cid: r.cid });
  const validNames = new Set(tools.map(parseToolDef).map((d) => d.name));
  let parsed = parseAssistantOutput(r.text);
  if (useJson && parsed.type !== "tool_calls") {
    parsed = parseJ1Continuation(r.text, validNames);
  }
  for (let i = 0; i < maxRetry && parsed.type !== "tool_calls"; i++) {
    r = await sendUpstream(req, `${input}${force}\n\n${RETRY_SUFFIX}`);
    debugRecord("agent_upstream_retry", { text: r.text, cid: r.cid });
    parsed = parseAssistantOutput(r.text);
    if (useJson && parsed.type !== "tool_calls") {
      parsed = parseJ1Continuation(r.text, validNames);
    }
  }
  debugRecord("agent_upstream_output", { text: r.text, cid: r.cid });
  recordSession(
    { keyId: req.keyId, model: req.model, messages: req.messages, tools },
    r.cid,
  );
  if (parsed.type === "tool_calls") {
    return toolCallsResponse(req, parsed.calls, r.cid, r.usage);
  }
  const completion = toChatCompletion(req.model, {
    message: parsed.text,
    response: { conversation: { id: r.cid } },
  });
  completion.usage = r.usage;
  return req.stream ? toSSE(completion) : json(completion, 200);
  };
  try {
    return await attempt();
  } catch (err) {
    // 対応表のcidが失効していたら捨てて全文で再送1回
    if (req.resolvedSession === true && isStaleSessionError(err)) {
      forgetSession(req.conversationId);
      req.conversationId = "";
      req.resolvedSession = false;
      return await attempt();
    }
    throw err;
  }
}
