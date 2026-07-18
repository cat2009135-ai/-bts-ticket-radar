import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const TIXCRAFT_URL = "https://tixcraft.com/activity/detail/26_btskns";

const SOURCES = [
  {
    id: "2026-11-19",
    label: "11/19 高雄場",
    url: "https://www.livenation.com.tw/en/event/bts-world-tour-arirang-in-kaohsiung-kaohsiung-tickets-edp1675883",
  },
  {
    id: "2026-11-21-22",
    label: "11/21、11/22 高雄場",
    url: "https://www.livenation.com.tw/en/event/bts-world-tour-arirang-in-kaohsiung-kaohsiung-tickets-edp1675887",
  },
];

const STATE_PATH = process.env.MONITOR_STATE_PATH || ".monitor-state.json";
const HEARTBEAT_PATH = process.env.MONITOR_HEARTBEAT_PATH || ".monitor-heartbeat";
const DRY_RUN = ["1", "true", "yes"].includes(
  String(process.env.DRY_RUN || "").toLowerCase(),
);

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function fingerprint(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

function extractTicketSection(html) {
  const ticketsMatch = /<[^>]+id=["']tickets["'][^>]*>/i.exec(html);
  if (!ticketsMatch) {
    throw new Error("找不到官方頁面的 tickets 公開售票區塊");
  }

  const remainder = html.slice(ticketsMatch.index + ticketsMatch[0].length);
  const infoMatch = /<[^>]+id=["']info["'][^>]*>/i.exec(remainder);
  if (!infoMatch) {
    throw new Error("找不到官方頁面的 info 區塊，為避免誤報已停止本次檢查");
  }

  const section = remainder.slice(0, infoMatch.index);
  const text = decodeHtmlEntities(
    section
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|hr)\s*\/?>/gi, " ")
      .replace(/<\/\s*(p|div|li|section|article|h[1-6])\s*>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (
    text.length < 20 ||
    !/(tickets|正式開賣|general onsale|buy tickets)/i.test(text)
  ) {
    throw new Error("官方公開售票區塊內容異常，為避免誤報已停止本次檢查");
  }

  return text;
}

async function fetchPublicSnapshot(source) {
  const attempts = 3;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    try {
      const response = await fetch(source.url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.7",
          "Cache-Control": "no-cache",
          "User-Agent":
            "BTS-Public-Status-Monitor/1.0 (personal read-only monitor)",
        },
      });

      if ([404, 410].includes(response.status)) {
        return `PUBLIC_PAGE_HTTP_${response.status}`;
      }

      if (!response.ok) {
        const retryable =
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        if (retryable && attempt < attempts) {
          await sleep(1_200 * attempt);
          continue;
        }
        throw new Error(`官方頁面回傳 HTTP ${response.status}`);
      }

      return extractTicketSection(await response.text());
    } catch (error) {
      const isLastAttempt = attempt === attempts;
      if (isLastAttempt) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${source.label} 讀取失敗：${reason}`);
      }
      await sleep(1_200 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`${source.label} 讀取失敗`);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw new Error(`無法讀取 ${path}：${error.message}`);
  }
}

async function collectSnapshots() {
  const snapshots = [];

  for (const source of SOURCES) {
    const text = await fetchPublicSnapshot(source);
    const sourceFingerprint = fingerprint(`${source.id}\n${text}`);
    snapshots.push({
      ...source,
      fingerprint: sourceFingerprint,
      summary: text.slice(0, 1_200),
    });
    console.log(
      `已檢查 ${source.label}（${sourceFingerprint.slice(0, 12)}）`,
    );
  }

  return snapshots;
}

function buildState(snapshots, previousState) {
  const combinedFingerprint = fingerprint(
    snapshots.map(({ id, fingerprint: value }) => `${id}:${value}`).join("\n"),
  );
  const now = new Date().toISOString();

  return {
    version: 1,
    combinedFingerprint,
    initializedAt: previousState?.initializedAt || now,
    updatedAt: now,
    sources: snapshots,
  };
}

function changedLabels(previousState, nextState) {
  const previous = new Map(
    (previousState?.sources || []).map((source) => [
      source.id,
      source.fingerprint,
    ]),
  );
  return nextState.sources
    .filter((source) => previous.get(source.id) !== source.fingerprint)
    .map((source) => source.label);
}

function activationMessage() {
  return [
    "✅ BTS 釋票雷達已啟動",
    "",
    "已開始約每 5 分鐘檢查官方公開售票資訊；只有偵測到公開頁面變化時才會再通知你。",
    "",
    `拓元確認頁：${TIXCRAFT_URL}`,
    "",
    "提醒：雷達不會自動選位或購票，是否真的有票仍以拓元頁面顯示為準。",
  ].join("\n");
}

function changeMessage(labels) {
  return [
    "🚨 BTS 公開售票頁有更新",
    "",
    `場次：${labels.join("、")}`,
    "偵測到官方公開售票狀態或公告內容變動，請立即前往拓元確認：",
    TIXCRAFT_URL,
    "",
    "提醒：這不保證一定有票，最終以拓元顯示為準；雷達不會自動選位或購票。",
  ].join("\n");
}

async function sendLine(message) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] 略過 LINE 發送：${message.split("\n")[0]}`);
    return;
  }

  const token = String(process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
  const userId = String(process.env.LINE_USER_ID || "").trim();
  if (!token || !userId) {
    throw new Error(
      "尚未設定 LINE_CHANNEL_ACCESS_TOKEN 或 LINE_USER_ID GitHub Actions Secret",
    );
  }

  const retryKey = randomUUID();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Line-Retry-Key": retryKey,
        },
        body: JSON.stringify({
          to: userId,
          messages: [{ type: "text", text: message }],
        }),
      });

      if (response.ok) {
        console.log("LINE 通知已送出");
        return;
      }

      const details = (await response.text()).slice(0, 300);
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < 3) {
        await sleep(1_500 * attempt);
        continue;
      }
      throw new Error(`LINE API 回傳 HTTP ${response.status}：${details}`);
    } catch (error) {
      if (attempt === 3) {
        throw new Error(`LINE 發送失敗：${error.message}`);
      }
      await sleep(1_500 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function writeState(state) {
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function updateHeartbeat() {
  let lastHeartbeat = null;
  try {
    lastHeartbeat = (await readFile(HEARTBEAT_PATH, "utf8")).trim();
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }

  const lastTime = lastHeartbeat ? Date.parse(lastHeartbeat) : Number.NaN;
  const thirtyDays = 30 * 24 * 60 * 60 * 1_000;
  if (!Number.isFinite(lastTime) || Date.now() - lastTime >= thirtyDays) {
    await writeFile(
      HEARTBEAT_PATH,
      `${new Date().toISOString().slice(0, 10)}\n`,
      "utf8",
    );
    console.log("已更新每月監看心跳");
  }
}

async function main() {
  const previousState = await readJson(STATE_PATH);
  const snapshots = await collectSnapshots();
  const nextState = buildState(snapshots, previousState);

  if (!previousState) {
    await sendLine(activationMessage());
    await writeState(nextState);
    console.log("首次監看基準已建立");
  } else if (
    previousState.combinedFingerprint !== nextState.combinedFingerprint
  ) {
    const labels = changedLabels(previousState, nextState);
    await sendLine(changeMessage(labels.length ? labels : ["官方公開售票頁"]));
    await writeState(nextState);
    console.log("已保存新的公開售票狀態");
  } else {
    console.log("公開售票狀態沒有變化，不發送 LINE");
  }

  await updateHeartbeat();
}

main().catch((error) => {
  console.error(`監看失敗：${error.message}`);
  process.exitCode = 1;
});
