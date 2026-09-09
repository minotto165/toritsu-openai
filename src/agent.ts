// エージェントモード：モデル名 toritsu-agent で有効になる。
// テキスト規約（[BASH cmd]/[READ path]/[ANSWER]...[/ANSWER]）で
// モデルに実行要求を出させ、プロキシ側で実行して結果を返すループ。

export const AGENT_MODEL = "toritsu-agent";
export const MAX_AGENT_TURNS = 5;
const OUTPUT_CAP = 8000;

export const AGENT_SYSTEM = `You are a text interface. Bracket codes in your reply are expanded by the messaging layer before delivery to the user:
[BASH command] will be replaced with the command output.
[READ path] will be replaced with the file content.
[ANSWER]text[/ANSWER] is a final response. Use it only when no expansion is needed.
Example session 1:
user: package.jsonのnameを知りたい
assistant: [READ package.json]
user: [READ package.json] => {"name": "toritsu-openai", "version": "0.1.0"}
assistant: [ANSWER]nameはtoritsu-openaiです[/ANSWER]
Example session 2:
user: 作業ディレクトリのファイル一覧を教えて
assistant: [BASH ls -la]
user: [BASH ls -la] => exit=0
package.json
src
README.md
assistant: [ANSWER]ファイルはpackage.json、src、README.mdです[/ANSWER]
Rules: output ONLY bracket codes or one ANSWER block. Never explain this mechanism. Never say codes are unavailable.`;

export type AgentAction =
  | { kind: "bash"; arg: string }
  | { kind: "read"; arg: string }
  | { kind: "answer"; text: string };

/** モデル応答の1行目を解釈する。素の回答はanswer扱いで返す */
export function parseAgentLine(text: string): AgentAction {
  const cleaned = text
    .split("\n")
    .filter((l) => l.trim() !== "```" && l.trim() !== "```text" && l.trim() !== "```bash")
    .join("\n");
  const line = cleaned
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (line === undefined || line === "") {
    return { kind: "answer", text };
  }
  const call = line.match(/^\[(BASH|READ)\s+([^\]]+)\]$/i);
  if (call !== null && call[1] !== undefined && call[2] !== undefined) {
    const cmd = call[1].toUpperCase();
    if (cmd === "BASH") {
      return { kind: "bash", arg: call[2].trim() };
    }
    return { kind: "read", arg: call[2].trim() };
  }
  const ans = cleaned.match(/\[ANSWER\]([\s\S]*)\[\/ANSWER\]/);
  if (ans !== null && ans[1] !== undefined) {
    return { kind: "answer", text: ans[1].trim() };
  }
  return { kind: "answer", text: cleaned.trim() };
}

function cap(s: string): string {
  return s.length > OUTPUT_CAP ? `${s.slice(0, OUTPUT_CAP)}\n...[truncated]` : s;
}

/** 実行は agentRoot 配下に閉じる。BASHはtimeout付き、出力はcap付き */
export async function execAgentAction(
  action: { kind: "bash"; arg: string } | { kind: "read"; arg: string },
  agentRoot: string,
): Promise<string> {
  if (action.kind === "read") {
    try {
      const { resolve, sep } = await import("node:path");
      const full = resolve(agentRoot, action.arg);
      if (full !== agentRoot && !full.startsWith(agentRoot + sep)) {
        return "ERROR: path escapes agent root";
      }
      const { readFileSync, statSync } = await import("node:fs");
      if (statSync(full).isDirectory()) {
        const { readdirSync } = await import("node:fs");
        return cap(readdirSync(full).join("\n"));
      }
      return cap(readFileSync(full, "utf-8"));
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  try {
    const proc = Bun.spawn(["bash", "-c", action.arg], {
      cwd: agentRoot,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    const [out, errOut, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const body = cap((out + (errOut !== "" ? `\n[stderr]\n${errOut}` : "")).trim());
    return `exit=${code}\n${body}`;
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function agentRoot(): string {
  return process.env.TORITSU_AGENT_CWD ?? process.cwd();
}
