// 会話対応表: 履歴フィンガープリント → 上流cid
// TORITSU_SESSION_REUSE=1 の時のみ動作。ステートレスなクライアント
// (pi/opencode) が毎回全文を送ってきても、前方一致で「同じ会話の続き」と
// 判定できたらcidを補完し、selectMessages の継続パス (system+最新1件) に乗せる。
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SESSION_MAX, SESSION_REUSE, SESSION_STORE, SESSION_TTL_MS } from "./config";
import { UpstreamError } from "./http";
import type { ChatMessage } from "../text/translate";

interface SessionEntry {
  cid: string;
  chain: string[];
  updatedAt: number;
}

export interface SessionScope {
  keyId: string;
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
}

/** 名前空間 (キーID×モデル×toolsHash) → エントリ列 */
const buckets = new Map<string, SessionEntry[]>();
let storeLoaded = false;

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** キー順ソート済みJSON (ハッシュ安定化用) */
function stable(v: unknown): string {
  if (v === null || v === undefined) {
    return "null";
  }
  if (typeof v !== "object") {
    return JSON.stringify(v) ?? "null";
  }
  if (Array.isArray(v)) {
    return `[${v.map(stable).join(",")}]`;
  }
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return s;
  }
}

/** 1メッセージの正規化。tool_call id は出現順に #0,#1… へ置換する。
 *  assistant turn が tool結果より先に現れるため同一会話内では参照関係が保たれ、
 *  prefix比較では同一prefixに同一番号が付くので一致する */
function normOne(m: ChatMessage, canon: (id: string) => string): unknown {
  const out: Record<string, unknown> = {
    role: m.role,
    content: m.content ?? null,
  };
  if (m.tool_calls !== undefined) {
    const arr = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    out.tool_calls = arr.map((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      const fn = (o.function ?? {}) as Record<string, unknown>;
      const rawArgs = o.arguments ?? fn.arguments ?? {};
      return {
        name: o.name ?? fn.name ?? "",
        arguments: typeof rawArgs === "string" ? tryJson(rawArgs) : rawArgs,
        id: typeof o.id === "string" ? canon(o.id) : "",
      };
    });
  }
  if (m.tool_call_id !== undefined) {
    out.tool_call_id =
      typeof m.tool_call_id === "string" ? canon(m.tool_call_id) : m.tool_call_id;
  }
  if (m.name !== undefined) {
    out.name = m.name;
  }
  return out;
}

/** prefixハッシュ列: chain[i] = sha(chain[i-1] + msg[i]) */
function buildChain(messages: ChatMessage[]): string[] {
  const idMap = new Map<string, string>();
  let n = 0;
  const canon = (id: string): string => {
    const hit = idMap.get(id);
    if (hit !== undefined) {
      return hit;
    }
    const v = `#${n++}`;
    idMap.set(id, v);
    return v;
  };
  const chain: string[] = [];
  let prev = "";
  for (const m of messages) {
    prev = sha(`${prev}\n${stable(normOne(m, canon))}`);
    chain.push(prev);
  }
  return chain;
}

function bucketKey(s: SessionScope): string {
  return `${s.keyId}\n${s.model}\n${sha(stable(s.tools))}`;
}

interface StoredEntry {
  ns: string;
  cid: string;
  chain: string[];
  updatedAt: number;
}

function loadStore(): void {
  if (storeLoaded || SESSION_STORE === "") {
    return;
  }
  storeLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(SESSION_STORE, "utf-8")) as unknown;
    if (!Array.isArray(raw)) {
      return;
    }
    for (const item of raw) {
      const o = (item ?? {}) as Record<string, unknown>;
      if (typeof o.ns !== "string" || typeof o.cid !== "string" || !Array.isArray(o.chain)) {
        continue;
      }
      const list = buckets.get(o.ns) ?? [];
      list.push({
        cid: o.cid,
        chain: o.chain.filter((h): h is string => typeof h === "string"),
        updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : 0,
      });
      buckets.set(o.ns, list);
    }
  } catch {
    // なければ空で開始
  }
}

function saveStore(): void {
  if (SESSION_STORE === "") {
    return;
  }
  try {
    const all: StoredEntry[] = [];
    for (const [ns, list] of buckets) {
      for (const e of list) {
        all.push({ ns, cid: e.cid, chain: e.chain, updatedAt: e.updatedAt });
      }
    }
    mkdirSync(dirname(SESSION_STORE), { recursive: true, mode: 0o700 });
    writeFileSync(SESSION_STORE, `${JSON.stringify(all)}\n`, { mode: 0o600 });
  } catch {
    // ignore
  }
}

/** 履歴の続きに一致するcidを探す。なければnull */
export function resolveSession(s: SessionScope): string | null {
  if (!SESSION_REUSE || s.messages.length === 0) {
    return null;
  }
  loadStore();
  const now = Date.now();
  const key = bucketKey(s);
  const bucket = buckets.get(key) ?? [];
  const chain = buildChain(s.messages);
  const alive: SessionEntry[] = [];
  let best: SessionEntry | null = null;
  for (const e of bucket) {
    if (now - e.updatedAt > SESSION_TTL_MS) {
      continue; // 期限切れは破棄
    }
    alive.push(e);
    if (e.chain.length >= chain.length) {
      continue; // 新規メッセージが1件以上必要
    }
    let ok = true;
    for (let i = 0; i < e.chain.length; i++) {
      if (e.chain[i] !== chain[i]) {
        ok = false;
        break;
      }
    }
    if (ok && (best === null || e.chain.length > best.chain.length)) {
      best = e;
    }
  }
  if (alive.length !== bucket.length) {
    buckets.set(key, alive);
    saveStore();
  }
  if (best === null) {
    return null;
  }
  best.updatedAt = now;
  saveStore();
  return best.cid;
}

/** 応答cidと今回履歴を対応付けて保存・更新 */
export function recordSession(s: SessionScope, cid: string): void {
  if (!SESSION_REUSE || cid === "" || s.messages.length === 0) {
    return;
  }
  loadStore();
  const now = Date.now();
  const key = bucketKey(s);
  const chain = buildChain(s.messages);
  const entry: SessionEntry = { cid, chain, updatedAt: now };
  const bucket = (buckets.get(key) ?? []).filter((e) => e.cid !== cid);
  // 上限超過は古い方から淘汰 (他名前空間と合算)
  let others = 0;
  for (const [k, list] of buckets) {
    if (k !== key) {
      others += list.length;
    }
  }
  const room = Math.max(0, SESSION_MAX - others - 1);
  bucket.sort((a, b) => b.updatedAt - a.updatedAt);
  bucket.length = Math.min(bucket.length, room);
  bucket.unshift(entry);
  buckets.set(key, bucket);
  saveStore();
}

/** staleなcidを対応表から消す (フォールバック再送時に使用) */
export function forgetSession(cid: string): void {
  if (!SESSION_REUSE || cid === "") {
    return;
  }
  loadStore();
  let changed = false;
  for (const [key, list] of buckets) {
    const kept = list.filter((e) => e.cid !== cid);
    if (kept.length !== list.length) {
      buckets.set(key, kept);
      changed = true;
    }
  }
  if (changed) {
    saveStore();
  }
}

/** 上流の message.content 上限超過 (422)。セッション蓄積が原因のため新規セッションで再送 */
export function isContentLimitError(err: unknown): boolean {
  return (
    err instanceof UpstreamError && err.status === 422 && /message\.content/.test(err.message)
  );
}

/** cid指定で上流が失効を返したか (フォールバック再送の判定用) */
export function isStaleSessionError(err: unknown): boolean {
  if (!(err instanceof UpstreamError)) {
    return false;
  }
  if (err.status === 401 || err.status === 404) {
    return true;
  }
  // 上流セッション蓄積で message.content が上限超過 (422)。捨てて全文再送で復帰
  return err.status === 422 && /message\.content/.test(err.message);
}
