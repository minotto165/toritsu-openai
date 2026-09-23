// --login：実Chromeで手動ログイン後にトークン自動取得
import { chromium } from "playwright-core";
import { checkSession, saveSessionToken } from "./upstream/webui";

const LOGIN_URL = "https://ai.metro.tokyo.lg.jp/";
const TOKEN_KEY = "auth._token.local";
const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 300_000;

function stripBearer(raw: string): string {
  return raw.replace(/^Bearer\s+/i, "").trim();
}

/** .envのMS資格情報（なければ空文字）。PWはログに出さない */
function msCredentials(): { email: string; password: string } {
  return {
    email: (process.env.TORITSU_MS_EMAIL ?? "").trim(),
    password: (process.env.TORITSU_MS_PASSWORD ?? "").trim(),
  };
}

async function readToken(page: {
  evaluate: (fn: (key: string) => unknown, arg: string) => Promise<unknown>;
}): Promise<string> {
  const raw = await page
    .evaluate((key: string) => window.localStorage.getItem(key), TOKEN_KEY)
    .catch(() => null);
  return typeof raw === "string" ? stripBearer(raw) : "";
}

/**
 * MS/Entraサインインの自動入力。サイト構造が変わると投げずにfalseを返し、
 * 呼び出し側の手動待ちに合流させる（CAPTCHA・条件付きアクセス時も同様）。
 */
async function tryMicrosoftAutoLogin(
  page: import("playwright-core").Page,
  email: string,
  password: string,
): Promise<boolean> {
  const deadline = Date.now() + 90_000;
  let filledEmail = false;
  while (Date.now() < deadline) {
    // 既に都立AI側でトークンが取れていれば完了
    try {
      if (page.url().startsWith(LOGIN_URL) && (await readToken(page)) !== "") {
        return true;
      }
    } catch {
      // ignore
    }
    const url = page.url();
    const isMs = /login\.microsoftonline\.com|login\.live\.com|sts\./i.test(url);
    // 学校IdPなどMS外に飛ばされた場合は手動に委ねる
    if (!isMs && !url.startsWith(LOGIN_URL)) {
      return false;
    }
    try {
      // (0) 都立AIトップの「Microsoftでログイン」ボタン
      if (page.url().startsWith(LOGIN_URL)) {
        const msBtn = page
          .locator('button:has-text("Microsoftでログイン"), button:has-text("Microsoft")')
          .first();
        if ((await msBtn.count()) > 0 && await msBtn.isVisible()) {
          await Promise.all([
            page.waitForURL(/login\.microsoftonline\.com|login\.live\.com|sts\./i, {
              timeout: 15000,
            }).catch(() => null),
            msBtn.click(),
          ]);
          await page.waitForTimeout(2000);
          continue;
        }
      }
      // (1) メールアドレス画面
      const emailInput = page.locator('input[name="loginfmt"], input[type="email"]').first();
      if (!filledEmail && (await emailInput.count()) > 0 && await emailInput.isVisible()) {
        await emailInput.fill(email);
        const next = page
          .locator('input[type="submit"], button:has-text("次へ"), button:has-text("Next")')
          .first();
        if ((await next.count()) > 0) {
          await next.click();
        } else {
          await page.keyboard.press("Enter");
        }
        filledEmail = true;
        await page.waitForTimeout(2000);
        continue;
      }
      // (2) パスワード画面
      const passInput = page.locator('input[name="passwd"], input[type="password"]').first();
      if ((await passInput.count()) > 0 && await passInput.isVisible()) {
        await passInput.fill(password);
        const signIn = page
          .locator(
            'input[type="submit"], button:has-text("サインイン"), button:has-text("Sign in")',
          )
          .first();
        if ((await signIn.count()) > 0) {
          await signIn.click();
        } else {
          await page.keyboard.press("Enter");
        }
        await page.waitForTimeout(2000);
        continue;
      }
      // (3) 「サインインの状態を維持しますか？」→ はい（MS実体は input#idSIButton9[value="はい"]）
      const kmsi = page
        .locator(
          '#idSIButton9, input[value="はい"], input[value="Yes"], button:has-text("はい"), button:has-text("Yes")',
        )
        .first();
      if ((await kmsi.count()) > 0 && await kmsi.isVisible()) {
        await kmsi.click();
        await page.waitForTimeout(2000);
        continue;
      }
      // (4) 都立AIに戻ってきたらトークン待ちへ
      if (page.url().startsWith(LOGIN_URL) && filledEmail) {
        return true;
      }
    } catch {
      return false;
    }
    await page.waitForTimeout(1500);
  }
  return false;
}

// --login の実処理：実ChromeのlocalStorageからトークンを自動取得
/** 手動ログイン待ち→取得→保存。Chromeなしはfalse */
export async function autoLogin(): Promise<boolean> {
  let browser;
  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: false,
    });
  } catch (err) {
    console.log(`(Chromeを起動できませんでした: ${err})`);
    return false;
  }
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(LOGIN_URL);
    const { email, password } = msCredentials();
    if (email !== "" && password !== "") {
      console.log(".envのMSアカウントで自動サインインを試みます...");
      const ok = await tryMicrosoftAutoLogin(page, email, password);
      if (!ok) {
        console.log("自動入力では完了しませんでした。手動で続けてください（最大5分待ちます）。");
      }
    } else {
      console.log("開いたChromeで都立AIにログインしてください（最大5分待ちます）。");
      console.log("ヒント: .envにTORITSU_MS_EMAIL/TORITSU_MS_PASSWORDを設定すると自動入力できます。");
    }
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const token = await readToken(page).catch(() => "");
      if (token !== "") {
        console.log("トークンを検出。検証中...");
        if (await checkSession(token)) {
          saveSessionToken(token);
          console.log("saved. Use model toritsu-fast (高速) or toritsu-reasoning (推論).");
          return true;
        }
        console.log("トークンが無効でした。ログインし直してください。");
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    console.error("タイムアウトしました。");
    return false;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
