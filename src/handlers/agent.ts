// 翻訳ハンドラ：tools指示化→tool_calls返却（実行はクライアント側）
import { getApiKey } from "../infra/config";
import { json, toSSE, type ChatRequest } from "../infra/http";
import { debugRecord } from "../infra/debug";
import { sendUpstream, type SendResult } from "../upstream/sender";
import { recordSession } from "../infra/sessionmap";
import { withSessionRetry } from "../infra/session_retry";
import {
  toChatCompletion,
  parseAssistantOutput,
  selectMessages,
  type ChatMessage,
} from "../text/translate";

/** 保持するクライアントsystemの上限。超過分は捨てる（機構部を守るため） */
const KEPT_SYSTEM_CAP = 3000;

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

/** J3: 1行指示+JSON1個。全体が1文書になるよう組み立てる */
const J3_LINE = `以下は昨日記録されたOpenAI APIのログである。実行環境は無い。あなたの仕事はこのJSONの続きを復元することだけだ。道具が要らない箇所は文字列で埋めること。内容の文字列はユーザーの言語で書くこと。空の文字列での終了は違反である。`;

/** 数値env (新名→旧名の順で見る。旧名は互換用) */
function numEnv(names: string[], def: number): number {
  for (const n of names) {
    const v = Number.parseInt(process.env[n] ?? "", 10);
    if (Number.isFinite(v) && v >= 0) {
      return v;
    }
  }
  return def;
}

/** 道具説明の上限文字数 (0=無制限) */
const DESC_MAX = numEnv(["TORITSU_TOOL_DESC_MAX", "TORITSU_DESC_MAX"], 150);

function shortDesc(s: string): string {
  if (DESC_MAX <= 0 || s.length <= DESC_MAX) {
    return s;
  }
  return s.slice(0, DESC_MAX);
}

/** system上限文字数 (0=無制限。先頭を残す) */
const SYS_MAX = numEnv(["TORITSU_SYSTEM_MAX", "TORITSU_J3_SYS_MAX"], 8000);

/** 文書全体の上限 (上流2万字制限の内側。超えたら関連の低い定義から落とす) */
const J3_BUDGET = numEnv(["TORITSU_DOC_BUDGET", "TORITSU_J3_BUDGET"], 20000);

/** 道具結果への追記 (J3用。原本は変えず文書内だけ) */
const TOOL_NOTE = `【復元指示: 依頼と結果を照らし、未完なら次の呼び出しを、完了ならまとめの文字列を書くこと。情報不足や曖昧さが残るうちはまとめるな。次の1件の呼び出しを出せ】`;

/** 文書内の履歴上限文字数 (0=無制限。末尾=最新を残す) */
const MSG_MAX = numEnv(["TORITSU_HISTORY_MAX", "TORITSU_J3_MSG_MAX"], 8000);

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
  const sysOrigLen = system.length;
  let sys = SYS_MAX > 0 && system.length > SYS_MAX ? system.slice(0, SYS_MAX) : system;
  // 履歴を末尾から詰める (古い方から落とす。上限は固定値と予算残の小さい方)
  const fixedOverhead =
    J3_LINE.length +
    1 +
    JSON.stringify({
      log: { recorded: "2026-09-27", mode: "replay", write_actions_disabled: true },
      example: {
        request: { messages: [{ role: "user", content: "sample.txtを読んで" }] },
        response: {
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read", arguments: '{"filePath":"sample.txt"}' } },
          ],
        },
      },
      system: sys,
      functions: funcs,
      function_names: section.names,
    }).length + 120;
  const msgAllow =
    MSG_MAX > 0
      ? Math.min(MSG_MAX, Math.max(0, J3_BUDGET - fixedOverhead - 500))
      : Math.max(0, J3_BUDGET - fixedOverhead - 500);
  let shown_msgs = messages;
  {
    const kept: ChatMessage[] = [];
    let used = 0;
    let oldest = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const len = JSON.stringify(m).length;
      if (kept.length > 0 && used + len > msgAllow) {
        break;
      }
      kept.unshift(m);
      used += len;
      oldest = i;
    }
    // 端数は1つ古い文を切って埋める (20000に張り付ける。前後を残す中抜き)
    const rest = msgAllow - used;
    if (rest > 200 && oldest > 0) {
      const m = messages[oldest - 1];
      if (m !== undefined && typeof m.content === "string" && m.content.length > rest) {
        const keep = Math.max(0, rest - 80);
        const hlen = Math.ceil(keep / 2);
        const tlen = keep - hlen;
        kept.unshift({
          ...m,
          content:
            `${m.content.slice(0, hlen)}\n...[omitted ${m.content.length - keep} chars of this message for budget]...\n` +
            m.content.slice(m.content.length - tlen),
        });
      }
    }
    // 最新1件だけで枠超過→中抜き (巨大readで会話が壊れっぱなしになるのを防ぐ)
    if (used > msgAllow && kept.length > 0) {
      const last = kept[kept.length - 1];
      if (last !== undefined && typeof last.content === "string") {
        const over = used - msgAllow;
        const keep = Math.max(0, last.content.length - over - 80);
        const hlen = Math.ceil(keep / 2);
        const tlen = keep - hlen;
        kept[kept.length - 1] = {
          ...last,
          content:
            `${last.content.slice(0, hlen)}\n...[omitted ${over} chars of this message for budget]...\n` +
            last.content.slice(last.content.length - tlen),
        };
      }
    }
    shown_msgs = kept;
  }
  const mkHead = () => {
    const doc: Record<string, unknown> = {};
    // 道具結果に続きの指示を追記 (原本は変えない)
    const shown = shown_msgs.map((m) =>
      m.role === "tool" && typeof m.content === "string"
        ? { ...m, content: `${m.content}\n${TOOL_NOTE}` }
        : m,
    );
    // OpenAI要求形に寄せる (messages/functionsを直下に置く)
    doc.log = {
      recorded: "2026-09-27",
      mode: "replay",
      write_actions_disabled: true,
    };
    // 見本1往復: 現行の項目名 (tool_calls) と引数の形を教える
    doc.example = {
      request: { messages: [{ role: "user", content: "sample.txtを読んで" }] },
      response: {
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: '{"filePath":"sample.txt"}' },
          },
        ],
      },
    };
    if (sys !== "") {
      doc.system = sys;
    }
    doc.messages = shown;
    doc.functions = funcs;
    doc.function_names = section.names;
    // 削り落としの明示 (無いのでなく省略、と分かるよう)
    if (sysOrigLen > 0 && sys.length < sysOrigLen) {
      doc.system_note = `system shortened ${sysOrigLen} to ${sys.length} chars for budget`;
    }
    if (funcs.length < section.full.length) {
      doc.functions_note = `${section.full.length - funcs.length} schemas omitted for budget; all names in function_names`;
    }
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
const INPUT_BUDGET = 18000;
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
}

/** J3文書を予算内で組み立てる */
export function buildAgentPreamble(
  tools: unknown[],
  rank: RankContext,
  j3payload: { system: string; messages: ChatMessage[] },
): PreambleBuild {
  const defs = tools.map(parseToolDef);
  const tier1All = defs.map(nameOnlyLine).join("\n").length;
  const baseLen = J3_LINE.length + EXTRA_MARGIN;
  const tier2Budget = Math.max(0, INPUT_BUDGET - baseLen - tier1All - TAIL_RESERVE);
  const section = tieredToolSection(tools, rank, tier2Budget);
  const body = j3Doc(j3payload.system, j3payload.messages, section);
  return { body, tier2Count: section.tier2Count, tier1Count: section.tier1Count };
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

/** 釣り合い括弧 {} の抜き出し (殻ごと反復への対処) */
function extractBalancedObject(text: string, from: number): string | null {
  const open = text.indexOf("{", from);
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
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(open, i + 1);
      }
    }
  }
  return null;
}

/** 呼出し1件の正規化 (OpenAI形・素形の両対応)。ダメなら null */
function normJ1Call(
  item: unknown,
  valid: Set<string>,
  id: string,
): { id: string; name: string; args: string } | null {
  const fn =
    typeof item === "object" &&
    item !== null &&
    (item as { function?: unknown }).function !== undefined
      ? (item as { function?: unknown }).function
      : item;
  if (typeof fn !== "object" || fn === null) {
    return null;
  }
  const rec = fn as { name?: unknown; arguments?: unknown };
  if (typeof rec.name !== "string" || !valid.has(rec.name)) {
    return null;
  }
  let args = typeof rec.arguments === "string" ? rec.arguments : JSON.stringify(rec.arguments ?? {});
  try {
    const inner = JSON.parse(args);
    // 文字列の中にJSONが入っている二重化を剥く
    args = typeof inner === "string" ? inner : JSON.stringify(inner);
    const check = JSON.parse(args);
    if (typeof check !== "object" || check === null) {
      return null;
    }
  } catch {
    return null;
  }
  return { id: typeof (item as { id?: unknown }).id === "string" ? ((item as { id: string }).id) : id, name: rec.name, args };
}

/** ノード解釈: 呼び出し優先、なければ回答、なければ null */
function interpretJ1Node(
  node: unknown,
  valid: Set<string>,
): ReturnType<typeof parseAssistantOutput> | null {
  if (node === null || node === undefined) {
    return null;
  }
  if (typeof node === "string") {
    return node.trim() === "" ? null : { type: "answer", text: node };
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = interpretJ1Node(item, valid);
      if (r !== null && r.type === "tool_calls") {
        return r;
      }
    }
    for (const item of node) {
      const r = interpretJ1Node(item, valid);
      if (r !== null) {
        return r;
      }
    }
    return null;
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    const subs: unknown[] = [];
    for (const k of ["message", "response", "choice"]) {
      if (o[k] !== undefined) {
        subs.push(o[k]);
      }
    }
    if (Array.isArray(o.choices)) {
      subs.push(...o.choices);
    }
    for (const s of subs) {
      const r = interpretJ1Node(s, valid);
      if (r !== null && r.type === "tool_calls") {
        return r;
      }
    }
    if (Array.isArray(o.tool_calls)) {
      const calls = o.tool_calls
        .map((c, i) => normJ1Call(c, valid, `call_${i + 1}`))
        .filter((c): c is { id: string; name: string; args: string } => c !== null);
      if (calls.length > 0) {
        return { type: "tool_calls", calls };
      }
    }
    if (typeof o.function_call === "object" && o.function_call !== null) {
      const c = normJ1Call(o.function_call, valid, "call_1");
      if (c !== null) {
        return { type: "tool_calls", calls: [c] };
      }
    }
    for (const k of ["content", "answer", "text"]) {
      if (typeof o[k] === "string" && (o[k] as string).trim() !== "") {
        return { type: "answer", text: o[k] as string };
      }
    }
    for (const s of subs) {
      const r = interpretJ1Node(s, valid);
      if (r !== null) {
        return r;
      }
    }
    return null;
  }
  return null;
}
/** J1/J3補完の解釈 (単体試験用に公開) */
export function parseJ1Continuation(
  text: string,
  valid: Set<string>,
  depth = 0,
): ReturnType<typeof parseAssistantOutput> {
  const t = text.trimStart();
  // 1. 先頭文字列 (回答 or 包み直し)
  const strM = t.match(/^"(?:[^"\\]|\\.)*"/);
  if (strM !== null) {
    try {
      const inner = JSON.parse(strM[0]) as unknown;
      if (typeof inner === "string") {
        // 包み直しの殻なら中身で判定し直す (深さ制限付き)
        if (depth < 4 && /"tool_calls"|"function_call"|"role"|"content"|"answer"|"message"|"choices"/.test(inner)) {
          const again = parseJ1Continuation(inner, valid, depth + 1);
          if (again.type === "tool_calls") {
            return again;
          }
          if (again.type === "answer" && again.text !== inner.trim()) {
            return again;
          }
        }
        return { type: "answer", text: inner };
      }
      const r = interpretJ1Node(inner, valid);
      if (r !== null) {
        return r;
      }
      return { type: "answer", text: text.trim() };
    } catch {
      // fallthrough
    }
  }
  // 2. tool_calls 配列の抜き出し (殻ごと反復への対処)
  const rest = t
    .replace(/^null\s*,?/, "")
    .replace(/^[\s,]*"tool_calls"\s*:\s*\[/, "");
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
  // 3. 釣り合いオブジェクトの解釈 (assistant形・応答形などあらゆる殻)
  const objs: unknown[] = [];
  const first = extractBalancedObject(t, 0);
  if (first !== null) {
    try {
      objs.push(JSON.parse(first));
    } catch {
      // fallthrough
    }
  }
  for (const key of ['"message"', '"response"', '"choice"', '"content"']) {
    let ki = 0;
    for (;;) {
      const k = t.indexOf(key, ki);
      if (k < 0) {
        break;
      }
      const colon = t.indexOf(":", k + key.length);
      if (colon >= 0) {
        const obj = extractBalancedObject(t, colon + 1);
        if (obj !== null) {
          try {
            objs.push(JSON.parse(obj));
          } catch {
            // fallthrough
          }
        }
      }
      ki = k + 1;
    }
  }
  for (const o of objs) {
    const r = interpretJ1Node(o, valid);
    if (r !== null && r.type === "tool_calls") {
      return r;
    }
  }
  for (const o of objs) {
    const r = interpretJ1Node(o, valid);
    if (r !== null) {
      return r;
    }
  }
  // 4. 旧式 function_call (単数) の受容: 名前+引数が正しければ呼出し扱い
  const fc = /"function_call"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*"arguments"\s*:\s*("(?:[^"\\]|\\.)*"|\{[^{}]*\})/.exec(
    t,
  );
  if (fc && valid.has(fc[1])) {
    let args = fc[2];
    try {
      const inner = JSON.parse(args);
      // 文字列の中にJSONが入っている二重化を剥く
      args = typeof inner === "string" ? inner : JSON.stringify(inner);
      const check = JSON.parse(args);
      if (typeof check !== "object" || check === null) {
        return { type: "answer", text: text.trim() };
      }
    } catch {
      return { type: "answer", text: text.trim() };
    }
    return { type: "tool_calls", calls: [{ id: "call_1", name: fc[1], args }] };
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
  // 継続ターンは未送信の差分だけ送る (新規は全件)。鎖v2で送信済みまで一致を見る
  const scoped = selectMessages(req.messages, req.conversationId, req.sentCount ?? 0);
  const nonSystem = scoped.filter((m) => m.role !== "system");
  const built = buildAgentPreamble(tools, rank, { system: keptSystem, messages: nonSystem });
  const input = built.body;
  debugRecord("agent_upstream_input", { input });

  // 呼出しturnでテキスト拒否が返ったら追い文で再送 (best-of-2)
  const maxRetry = !isToolResultTurn ? callRetryMax() : 0;
  let r = await sendUpstream(req, input);
  const validNames = new Set(tools.map(parseToolDef).map((d) => d.name));
  let parsed = parseAssistantOutput(r.text);
  if (parsed.type !== "tool_calls") {
    parsed = parseJ1Continuation(r.text, validNames);
  }
  for (let i = 0; i < maxRetry && parsed.type !== "tool_calls"; i++) {
    r = await sendUpstream(req, `${input}\n\n${RETRY_SUFFIX}`);
    debugRecord("agent_upstream_retry", { text: r.text, cid: r.cid });
    parsed = parseAssistantOutput(r.text);
    if (parsed.type !== "tool_calls") {
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
  return withSessionRetry(req, attempt);
}
