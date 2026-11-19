// background.js
// フリマコピー（自作）の MV3 サービスワーカー。
// 役割は 1 つだけ: コンテンツスクリプトの代わりに画像を取得し、base64 で返す。
// v0.2.1: Mercari の CDN（static.mercdn.net）が「出品ページ等からの参照」でない取得を
// 403 で弾くため、コピー元ページ URL を Referer にして取得を試みる。
// 試行順: 1) Referer 付き 2) Referer + Cookie 付き 3) 素の fetch（他 CDN 用の保険）。
// どの試行で成功したかを attempt として返し、ページ側コンソールで分かるようにする。
"use strict";

// ArrayBuffer → base64（大きい画像でもスタック溢れしないようチャンク処理）。
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function fetchWithFallbacks(url, referrer) {
  // 画像読み込み時と同じ Accept を付ける（CDN の Vary / 判定対策）。
  const headers = { Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" };
  const attempts = [];
  if (referrer) {
    attempts.push({ headers, referrer, referrerPolicy: "unsafe-url" });
    attempts.push({ headers, referrer, referrerPolicy: "unsafe-url", credentials: "include" });
  }
  attempts.push({ headers });
  const errors = [];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const res = await fetch(url, attempts[i]);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return { res, attempt: i + 1 };
    } catch (e) {
      errors.push("attempt" + (i + 1) + ": " + String((e && e.message) || e));
    }
  }
  throw new Error(errors.join(" | ") || "fetch failed");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // リモート指令まわり（ポップアップからの手動チェック / テスト実行）。
  if (message && message.type === "FurimaRemotePollNow") {
    pollRemoteCommands("manual").then((r) => sendResponse(r || { ok: true }));
    return true;
  }
  if (message && message.type === "FurimaRemoteTest") {
    (async () => {
      if (remoteRunning) {
        sendResponse({ ok: false, error: "別の指令を実行中です" });
        return;
      }
      remoteRunning = true;
      try {
        const result = await executeRelist({
          id: "test-" + Date.now(),
          type: "relist",
          itemUrl: message.itemUrl || "",
        });
        sendResponse({ ok: result.status !== "error", result });
      } finally {
        remoteRunning = false;
      }
    })();
    return true;
  }
  // 出品ページで画像の取込データが無かったときの取り直し（filler からの依頼、v0.7.13）。
  if (message && message.type === "FurimaRecaptureImages" && message.itemUrl) {
    recaptureImages(message.itemUrl).then((r) => sendResponse(r));
    return true;
  }
  if (!message || message.type !== "FurimaCopyFetchImage" || !message.url) {
    return false;
  }
  (async () => {
    try {
      // Referer の第一候補はメッセージで渡されたコピー元 URL、なければ送信元タブの URL。
      const referrer = message.referrer || (sender.tab && sender.tab.url) || null;
      const { res, attempt } = await fetchWithFallbacks(message.url, referrer);
      const buffer = await res.arrayBuffer();
      sendResponse({
        ok: true,
        base64: arrayBufferToBase64(buffer),
        contentType: res.headers.get("content-type") || "image/jpeg",
        attempt,
      });
    } catch (e) {
      console.warn("[FurimaCopy] image fetch failed:", message.url, e);
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // 非同期で sendResponse するので true を返す
});

// ============================================================================
// リモート指令（v0.5.0、半自動・検証版）
// ----------------------------------------------------------------------------
// 仕組み: ポップアップで指定した「指令 URL」を 1 分ごとに取得し、
// { "id": "...", "type": "relist", "itemUrl": "https://jp.mercari.com/item/..." }
// という JSON が来ていたら、まだ実行していない id のものだけを実行する。
// 実行内容: 商品ページを裏タブで開いて読み取り（コピー）→ 出品ページを
// 前面タブで開いて自動入力 → 結果を chrome.storage.local の lastRemoteResult
// と remoteConfig.lastStatus に残す（ポップアップで確認できる）。
// 安全策:
//   - 出品（送信）ボタンは絶対に押さない。入力までで止まる。
//   - 対応は Mercari の再出品のみ（検証版）。他サイト URL はエラーにする。
//   - リモート実行はポップアップのスイッチが ON のときだけ有効。
//   - 同じ指令 id は二度実行しない。
// ============================================================================

const REMOTE_ALARM = "fcRemotePoll";
const REMOTE_DEFAULTS = {
  enabled: false,
  cmdUrl: "",
  lastCmdId: null,
  lastPollAt: null,
  lastStatus: "未設定",
};

let remoteRunning = false;

function remoteSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getRemoteConfig() {
  const res = await chrome.storage.local.get("remoteConfig");
  return Object.assign({}, REMOTE_DEFAULTS, res.remoteConfig || {});
}

async function setRemoteConfig(patch) {
  const cfg = Object.assign(await getRemoteConfig(), patch);
  await chrome.storage.local.set({ remoteConfig: cfg });
  return cfg;
}

// サービスワーカーが途中で眠らないよう、実行中は定期的に API を叩く。
function startKeepAlive() {
  const t = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => {});
    } catch (e) {
      /* noop */
    }
  }, 20000);
  return () => clearInterval(t);
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch (e) {
        /* noop */
      }
      resolve(ok);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t && t.status === "complete") finish(true);
      })
      .catch(() => {});
    setTimeout(() => finish(false), timeoutMs || 45000);
  });
}

// コンテンツスクリプトの読み込み完了を待ちながらメッセージを送る。
async function sendToTabWithRetry(tabId, message, tries, intervalMs) {
  let lastErr = null;
  for (let i = 0; i < (tries || 15); i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, message);
      if (res) return res;
    } catch (e) {
      lastErr = e;
    }
    await remoteSleep(intervalMs || 3000);
  }
  throw new Error(
    "ページ側スクリプトが応答しませんでした: " +
      String((lastErr && lastErr.message) || lastErr || "")
  );
}

async function executeRelist(cmd) {
  const stopKeepAlive = startKeepAlive();
  const result = {
    id: cmd.id || null,
    type: cmd.type || null,
    itemUrl: cmd.itemUrl || null,
    startedAt: new Date().toISOString(),
    status: "running",
    steps: [],
    error: null,
  };
  const saveResult = async () => {
    await chrome.storage.local.set({ lastRemoteResult: result });
    await setRemoteConfig({
      lastStatus:
        result.status + (result.error ? ": " + result.error : ""),
    });
  };
  try {
    if (!/^https:\/\/jp\.mercari\.com\/item\/[A-Za-z0-9]+/.test(cmd.itemUrl || "")) {
      throw new Error("v0.5.0（検証版）の対象は Mercari 商品 URL のみです");
    }
    result.steps.push("商品ページを開く");
    // v0.5.1: 商品ページも前面で開く。裏タブだと Chrome のスロットリングで
    // ページ描画と画像の遅延読み込みが進まず、読み取りが止まってしまうため
    // （実測: タブをクリックして前面に出すと進み始めた）。
    const itemTab = await chrome.tabs.create({ url: cmd.itemUrl, active: true });
    try {
      await chrome.tabs.update(itemTab.id, { autoDiscardable: false });
    } catch (e) {
      /* noop */
    }
    await waitForTabComplete(itemTab.id, 45000);
    await remoteSleep(3000); // SPA の描画待ち

    result.steps.push("商品情報を読み取り中");
    await saveResult();
    const copyRes = await sendToTabWithRetry(
      itemTab.id,
      { type: "FurimaRemoteCopy" },
      20,
      3000
    );
    if (!copyRes || !copyRes.ok) {
      throw new Error("読み取り失敗: " + ((copyRes && copyRes.error) || "不明なエラー"));
    }
    result.copy = copyRes.summary || null;
    result.steps.push(
      "読み取り完了: " + ((copyRes.summary && copyRes.summary.title) || "")
    );
    try {
      await chrome.tabs.remove(itemTab.id);
    } catch (e) {
      /* noop */
    }

    result.steps.push("出品ページを開く");
    const sellTab = await chrome.tabs.create({
      url: "https://jp.mercari.com/sell/create",
      active: true,
    });
    result.sellTabId = sellTab.id;
    await waitForTabComplete(sellTab.id, 45000);
    await remoteSleep(3500);

    result.steps.push("フォームへ入力中");
    await saveResult();
    const fillRes = await sendToTabWithRetry(
      sellTab.id,
      { type: "FurimaRemoteFill" },
      20,
      3000
    );
    if (!fillRes || !fillRes.ok) {
      throw new Error("入力失敗: " + ((fillRes && fillRes.error) || "不明なエラー"));
    }
    result.fillLines = fillRes.lines || null;
    result.status = "filled";
    result.steps.push("入力完了（出品ボタンは押していません）");
  } catch (e) {
    result.status = "error";
    result.error = String((e && e.message) || e);
    result.steps.push("エラー: " + result.error);
  } finally {
    result.finishedAt = new Date().toISOString();
    await saveResult();
    stopKeepAlive();
  }
  return result;
}

// 指令 JSON の解釈。素の JSON のほか、GitHub Gist API の返却形式
// （{files: {"command.json": {content: "..."}}}) にも対応する。
function parseCommandPayload(text) {
  let obj = JSON.parse(text);
  if (obj && typeof obj === "object" && obj.files) {
    const f =
      obj.files["command.json"] || Object.values(obj.files)[0];
    if (f && f.content) obj = JSON.parse(f.content);
  }
  return obj;
}

async function pollRemoteCommands(reason) {
  const cfg = await getRemoteConfig();
  await setRemoteConfig({ lastPollAt: new Date().toISOString() });
  if (!cfg.enabled || !cfg.cmdUrl) return { skipped: true, reason: reason || "" };
  if (remoteRunning) return { busy: true };
  let cmd;
  try {
    const res = await fetch(cfg.cmdUrl, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    cmd = parseCommandPayload(await res.text());
  } catch (e) {
    await setRemoteConfig({
      lastStatus: "指令取得エラー: " + String((e && e.message) || e),
    });
    return { error: true };
  }
  if (!cmd || cmd.type !== "relist" || !cmd.id || !cmd.itemUrl) {
    return { noCommand: true };
  }
  if (cfg.lastCmdId === cmd.id) return { duplicate: true };
  await setRemoteConfig({ lastCmdId: cmd.id, lastStatus: "実行中: " + cmd.id });
  remoteRunning = true;
  try {
    await executeRelist(cmd);
  } finally {
    remoteRunning = false;
  }
  return { executed: cmd.id };
}

chrome.alarms.create(REMOTE_ALARM, { periodInMinutes: 1 });
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(REMOTE_ALARM, { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(REMOTE_ALARM, { periodInMinutes: 1 });
  pollRemoteCommands("startup");
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REMOTE_ALARM) pollRemoteCommands("alarm");
});

// ============================================================================
// 画像の再取込（v0.7.13）
// ----------------------------------------------------------------------------
// Mercari の CDN は出品ページからの直接取得を 403 で拒むため、画像は
// コピー時に商品ページで取り込んだデータ（copyImages）から貼るのが前提。
// ところが取込データは「最後にコピーした 1 件分」しか残らず、別の商品を
// コピーした後だと対象商品分が消えていて 0 枚になる。そこで filler から
// 依頼されたら、コピー元ページを裏タブで開いて読み取り直し、取込データを
// 作り直す（リモート再出品と同じ仕組みの流用）。
// ============================================================================

let recaptureRunning = false;

async function recaptureImages(itemUrl) {
  if (recaptureRunning) return { ok: false, error: "再取込を実行中です" };
  recaptureRunning = true;
  const stopKeepAlive = startKeepAlive();
  try {
    const tab = await chrome.tabs.create({ url: itemUrl, active: false });
    try {
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
    } catch (e) {
      /* noop */
    }
    await waitForTabComplete(tab.id, 45000);
    await remoteSleep(2000);
    const res = await sendToTabWithRetry(
      tab.id,
      { type: "FurimaRemoteCopy" },
      20,
      3000
    );
    try {
      await chrome.tabs.remove(tab.id);
    } catch (e) {
      /* noop */
    }
    if (!res || !res.ok) {
      return { ok: false, error: "読み取り失敗: " + ((res && res.error) || "不明") };
    }
    const stored = await chrome.storage.local.get("copyImages");
    const imgs = stored.copyImages;
    const captured =
      imgs && Array.isArray(imgs.items)
        ? imgs.items.filter((x) => x && x.base64).length
        : 0;
    return { ok: true, captured, sourceUrl: imgs ? imgs.sourceUrl : null };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    stopKeepAlive();
    recaptureRunning = false;
  }
}

// ============================================================================
// 出品管理プログラム連携（v0.9.0）
// ----------------------------------------------------------------------------
// ユーザーの PC で動く出品管理プログラム（selling-goods-manager）が
// localhost に立てる小さな HTTP サーバと通信し、「自動出品タスク」を実行する。
//   1. 1 分ごとに pending タスクを問い合わせる（設定 ON のときだけ）
//   2. タスクを claim する。type="relist" のタスクは参照商品ページを
//      開いて通常のコピーで staging し、それ以外（従来型）は商品データと
//      画像（プログラムから直接取得）を copyData / copyImages に staging する
//   3. 出品ページを開いて自動入力させ、タスクが autoSubmit のときだけ
//      filler 側が「出品する」まで押し、lastSubmitReport に結果を残す
//   4. 結果（成否・出品 URL・手動項目）をプログラムへ返す
// 自動出品（送信）を行うのは管理プログラムから来たタスクだけ。
// 通常のコピー＆入力と Gist リモート再出品は従来どおり入力止まり。
// 対応プラットフォームは v1 では Mercari のみ（他は pending のまま残す）。
// ============================================================================

const MANAGER_ALARM = "fcManagerPoll";
const TODO_SCAN_ALARM = "fcMercariTodoScan";
const MANAGER_DEFAULTS = {
  enabled: false,
  baseUrl: "http://127.0.0.1:17341",
  token: "",
  todoScanEnabled: false,
  todoScanInterval: 5,
  todoScanUnit: "minutes",
  lastPollAt: null,
  lastStatus: "未設定",
  lastSaleScanAt: null,
  lastSaleScanStatus: "未スキャン",
};
const MANAGER_SELL_URLS = {
  mercari: "https://jp.mercari.com/sell/create",
};
let managerRunning = false;
let soldScanRunning = false;

async function getManagerConfig() {
  const res = await chrome.storage.local.get("managerConfig");
  return Object.assign({}, MANAGER_DEFAULTS, res.managerConfig || {});
}

async function setManagerConfig(patch) {
  const cfg = Object.assign(await getManagerConfig(), patch);
  await chrome.storage.local.set({ managerConfig: cfg });
  return cfg;
}

async function managerFetch(cfg, path, init) {
  const base = String(cfg.baseUrl || "").replace(/\/$/, "");
  const res = await fetch(
    base + path,
    Object.assign({}, init || {}, {
      headers: Object.assign(
        { "x-fc-token": cfg.token || "" },
        (init && init.headers) || {}
      ),
    })
  );
  if (!res.ok) throw new Error("manager HTTP " + res.status);
  return res.json();
}

async function scanMercariSoldTodos(cfg, force) {
  if (!cfg.todoScanEnabled && !force) return { ok: true, skipped: true };
  if (soldScanRunning) return { ok: false, error: "Todo 扫描正在进行中" };
  soldScanRunning = true;
  const stopKeepAlive = startKeepAlive();
  let todosTab = null;
  let cards = [];
  let matched = 0;
  let unmatched = 0;
  try {
    todosTab = await chrome.tabs.create({ url: "https://jp.mercari.com/todos", active: false });
    await waitForTabComplete(todosTab.id, 45000);
    await remoteSleep(3000);
    const scan = await sendToTabWithRetry(
      todosTab.id,
      { type: "FurimaScanSoldTodos" },
      10,
      2000
    );
    cards = scan && scan.cards ? scan.cards : [];

    for (const card of cards) {
      let itemId = card.itemId;
      let listingUrl = itemId ? "https://jp.mercari.com/item/" + itemId : null;

      if (!itemId && /^https:\/\/jp\.mercari\.com\/transactions?\//.test(card.url)) {
        const detailTab = await chrome.tabs.create({ url: card.url, active: false });
        try {
          await waitForTabComplete(detailTab.id, 45000);
          await remoteSleep(2500);
          const detail = await sendToTabWithRetry(
            detailTab.id,
            { type: "FurimaScanSoldTodos" },
            10,
            2000
          );
          if (detail && detail.detail) {
            itemId = detail.detail.itemId;
            listingUrl = detail.detail.url;
          }
        } finally {
          try {
            await chrome.tabs.remove(detailTab.id);
          } catch (e) {}
        }
      }

      if (!itemId) {
        unmatched += 1;
        continue;
      }
      const report = await managerFetch(cfg, "/api/sales/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId,
          listingUrl,
          statusText: card.text,
          at: new Date().toISOString(),
        }),
      });
      if (report && report.matched) matched += 1;
      else unmatched += 1;
    }
    await setManagerConfig({
      lastSaleScanAt: new Date().toISOString(),
      lastSaleScanStatus:
        "発送待ち " + cards.length + "件 / 在庫連携 " + matched +
        "件 / 商品未一致 " + unmatched + "件",
    });
    return { ok: true };
  } catch (e) {
    console.warn("[FurimaCopy] sold todos scan failed", e);
    await setManagerConfig({
      lastSaleScanAt: new Date().toISOString(),
      lastSaleScanStatus: "スキャン失敗: " + String((e && e.message) || e),
    });
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    if (todosTab) {
      try {
        await chrome.tabs.remove(todosTab.id);
      } catch (e) {}
    }
    soldScanRunning = false;
    stopKeepAlive();
  }
}

async function pollManagerTasks(why) {
  const cfg = await getManagerConfig();
  if (!cfg.enabled || managerRunning) return;
  let data;
  try {
    data = await managerFetch(cfg, "/api/tasks?status=pending");
    await setManagerConfig({ lastPollAt: new Date().toISOString() });
  } catch (e) {
    await setManagerConfig({
      lastStatus: "接続できません（プログラム未起動？）",
    });
    return;
  }
  const task = (data.tasks || []).find((t) => t.platform === "mercari");
  if (!task) {
    await setManagerConfig({ lastStatus: "待機中（タスクなし） " + (why || "") });
    return;
  }
  managerRunning = true;
  try {
    await executeManagerTask(cfg, task);
  } catch (e) {
    console.warn("[FurimaCopy] manager task failed", e);
  } finally {
    managerRunning = false;
  }
}

async function executeManagerTask(cfg, task) {
  const stopKeepAlive = startKeepAlive();
  const startedAt = Date.now();
  const base = String(cfg.baseUrl || "").replace(/\/$/, "");
  const postResult = async (ok, listingUrl, message) => {
    try {
      await managerFetch(cfg, "/api/tasks/" + encodeURIComponent(task.id) + "/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: !!ok,
          listingUrl: listingUrl || null,
          message: message || null,
        }),
      });
    } catch (e) {
      console.warn("[FurimaCopy] manager result post failed", e);
    }
    await setManagerConfig({
      lastStatus:
        (ok ? "完了: " : "失敗: ") + (message || task.title || task.id),
    });
  };
  try {
    await managerFetch(cfg, "/api/tasks/" + encodeURIComponent(task.id) + "/claim", {
      method: "POST",
    });

    let expectedSourceItemId = null;
    if (task.type === "relist") {
      // ---- 再出品タスク: 参照商品ページを開き、通常のコピーで staging ----
      // タイトル・説明・価格・画像はすべて参照商品からコピーする
      // （管理プログラムのローカル画像は使わない）。
      if (
        !/^https:\/\/jp\.mercari\.com\/item\/[A-Za-z0-9]+/.test(
          task.itemUrl || ""
        )
      ) {
        throw new Error("参照商品の URL が不正です: " + (task.itemUrl || ""));
      }
      const itemTab = await chrome.tabs.create({
        url: task.itemUrl,
        active: true,
      });
      try {
        await chrome.tabs.update(itemTab.id, { autoDiscardable: false });
      } catch (e) {
        /* noop */
      }
      await waitForTabComplete(itemTab.id, 45000);
      await remoteSleep(3000); // SPA の描画待ち
      const copyRes = await sendToTabWithRetry(
        itemTab.id,
        { type: "FurimaRemoteCopy" },
        20,
        3000
      );
      if (!copyRes || !copyRes.ok) {
        throw new Error(
          "参照商品の読み取り失敗: " +
            ((copyRes && copyRes.error) || "不明なエラー")
        );
      }
      const expectedSourceId =
        String(task.itemUrl || "").match(/\/item\/(m[A-Za-z0-9]+)/) || [];
      expectedSourceItemId = expectedSourceId[1] || null;
      const copiedSourceId =
        copyRes.summary &&
        String(copyRes.summary.sourceUrl || "").match(/\/item\/(m[A-Za-z0-9]+)/);
      const sourceMismatch =
        !expectedSourceId[1] ||
        !copiedSourceId ||
        copiedSourceId[1] !== expectedSourceId[1];
      try {
        await chrome.tabs.remove(itemTab.id);
      } catch (e) {
        /* noop */
      }
      if (sourceMismatch) {
        throw new Error(
          "参照商品 ID が一致しません（指定: " +
            (expectedSourceId[1] || "不明") +
            "、読み取り: " +
            ((copiedSourceId && copiedSourceId[1]) || "不明") +
            "）。出品を中止しました。"
        );
      }
      // 管理プログラムの商品番号を管理Noとして付け、タスク由来である
      // ことを copyData に印す（filler の表示と送信ガードが参照する）。
      const st = await chrome.storage.local.get("copyData");
      const cd = st.copyData || {};
      cd.inventoryCode = task.product_no || null;
      cd.managerTask = {
        id: task.id,
        autoSubmit: !!task.autoSubmit,
        sourceItemId: expectedSourceItemId,
        productNo: task.product_no || null,
      };
      await chrome.storage.local.set({ copyData: cd });
    } else {
    // ---- staging: copyData / copyImages を通常のコピーと同じ形で作る ----
    const sourceUrl = "manager://task/" + task.id;
    const imageUrls = (task.images || []).map(
      (p) => base + "/api/image?path=" + encodeURIComponent(p)
    );
    await chrome.storage.local.set({
      copyData: {
        source: task.platform,
        sourceUrl,
        title: task.title || null,
        description: task.description || null,
        price: task.price != null ? task.price : null,
        imageUrls,
        conditionText: task.conditionText || null,
        categoryText: task.categoryText || null,
        shippingText: task.shippingText || null,
        inventoryCode: task.product_no || null,
        managerTask: {
          id: task.id,
          autoSubmit: !!task.autoSubmit,
          sourceItemId: null,
          productNo: task.product_no || null,
        },
        copiedAt: new Date().toISOString(),
      },
    });
    const items = [];
    for (const u of imageUrls) {
      try {
        const r = await fetch(u, {
          headers: { "x-fc-token": cfg.token || "" },
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const buf = await r.arrayBuffer();
        items.push({
          key: u,
          base64: arrayBufferToBase64(buf),
          type: r.headers.get("content-type") || "image/jpeg",
          via: "manager",
          capturedUrl: u,
        });
      } catch (e) {
        items.push({ key: u, base64: null, type: null, via: null, capturedUrl: null });
      }
    }
    await chrome.storage.local.set({
      copyImages: { sourceUrl, at: new Date().toISOString(), items },
    });
    }

    // ---- 出品ページを開いて自動入力（タスク指定時は出品まで） ----
    const managerFillRequest = {
      managerTaskId: task.id,
      autoSubmit: !!task.autoSubmit,
      productNo: task.product_no || null,
      sourceItemId: expectedSourceItemId,
    };
    if (task.platform !== "mercari") {
      await chrome.storage.local.set({
        autoFillRequest: {
          target: task.platform,
          at: Date.now(),
          status: "ready",
          ...managerFillRequest,
        },
      });
    }
    const tab = await chrome.tabs.create({
      url: MANAGER_SELL_URLS[task.platform],
      active: true,
    });
    try {
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
    } catch (e) {
      /* noop */
    }
    if (task.platform === "mercari") {
      const loaded = await waitForTabComplete(tab.id, 45000);
      if (!loaded) throw new Error("Mercari 出品ページの読み込みがタイムアウトしました");
      const fillRes = await sendToTabWithRetry(
        tab.id,
        { type: "FurimaManagerAutoFill", request: managerFillRequest },
        15,
        1000
      );
      if (!fillRes || !fillRes.ok) {
        throw new Error(
          "Mercari 出品ページの自動入力を開始できませんでした: " +
            ((fillRes && fillRes.error) || "不明なエラー")
        );
      }
    }

    // ---- 結果待ち: 入力レポート →（autoSubmit 時）送信レポート ----
    const deadline = Date.now() + 4 * 60 * 1000;
    let fillReport = null;
    let submitReport = null;
    while (Date.now() < deadline) {
      await remoteSleep(2000);
      const st = await chrome.storage.local.get([
        "lastFillReport",
        "lastSubmitReport",
      ]);
      if (
        st.lastFillReport &&
        st.lastFillReport.at > startedAt &&
        (task.platform !== "mercari" || st.lastFillReport.taskId === task.id)
      ) {
        fillReport = st.lastFillReport;
      }
      if (
        st.lastSubmitReport &&
        st.lastSubmitReport.at > startedAt &&
        st.lastSubmitReport.taskId === task.id
      ) {
        submitReport = st.lastSubmitReport;
        break;
      }
      if (fillReport && !task.autoSubmit) break;
    }

    const manualSummary = fillReport
      ? (fillReport.lines || [])
          .filter((l) => l.status !== "ok" && !(l.label || "").includes("送信前確認"))
          .map((l) => l.label + (l.note ? ": " + l.note : ""))
          .join(" / ")
      : "";

    if (task.autoSubmit) {
      if (!submitReport) {
        await postResult(false, null, "出品結果を確認できませんでした（タイムアウト）");
        return;
      }
      await postResult(
        !!submitReport.ok,
        submitReport.listingUrl || null,
        [
          submitReport.message || (submitReport.ok ? "出品しました" : "出品失敗"),
          manualSummary ? "要確認: " + manualSummary : "",
        ]
          .filter(Boolean)
          .join(" ")
      );
      return;
    }
    if (!fillReport) {
      await postResult(false, null, "入力結果を確認できませんでした（タイムアウト）");
      return;
    }
    await postResult(
      true,
      null,
      "入力完了（自動出品 OFF）" + (manualSummary ? " 手動項目: " + manualSummary : "")
    );
  } catch (e) {
    await postResult(false, null, String((e && e.message) || e));
  } finally {
    stopKeepAlive();
  }
}

chrome.alarms.create(MANAGER_ALARM, { periodInMinutes: 1 });
function todoScanPeriodInMinutes(config) {
  const interval = Number(config.todoScanInterval);
  const unit = config.todoScanUnit;
  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error("Todo 扫描间隔必须是正整数");
  }
  if (unit === "minutes" && interval <= 1440) return interval;
  if (unit === "hours" && interval <= 24) return interval * 60;
  throw new Error("Todo 扫描间隔无效：分钟最多 1440，小时最多 24");
}

async function updateTodoScanAlarm(config) {
  if (!config.todoScanEnabled) {
    await chrome.alarms.clear(TODO_SCAN_ALARM);
    return;
  }
  chrome.alarms.create(TODO_SCAN_ALARM, {
    periodInMinutes: todoScanPeriodInMinutes(config),
  });
}

function restoreTodoScanAlarm() {
  getManagerConfig()
    .then(updateTodoScanAlarm)
    .catch((error) => console.error("[FurimaCopy] failed to restore Todo scan schedule", error));
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(MANAGER_ALARM, { periodInMinutes: 1 });
  restoreTodoScanAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(MANAGER_ALARM, { periodInMinutes: 1 });
  restoreTodoScanAlarm();
  pollManagerTasks("startup");
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MANAGER_ALARM) pollManagerTasks("alarm");
  if (alarm.name === TODO_SCAN_ALARM) {
    getManagerConfig()
      .then((config) => scanMercariSoldTodos(config))
      .catch((error) => console.error("[FurimaCopy] scheduled Todo scan failed", error));
  }
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "FurimaManagerSaveConfig") {
    (async () => {
      const interval = Number(msg.todoScanInterval);
      const unit = msg.todoScanUnit;
      const todoScanEnabled = !!msg.todoScanEnabled;
      todoScanPeriodInMinutes({
        todoScanInterval: interval,
        todoScanUnit: unit,
      });
      const config = await setManagerConfig({
        enabled: !!msg.enabled,
        baseUrl: String(msg.baseUrl || "").trim() || "http://127.0.0.1:17341",
        token: String(msg.token || "").trim(),
        todoScanEnabled,
        todoScanInterval: interval,
        todoScanUnit: unit,
      });
      await updateTodoScanAlarm(config);
      sendResponse({ ok: true });
    })().catch((error) => {
      sendResponse({ ok: false, error: String((error && error.message) || error) });
    });
    return true;
  }
  if (msg && msg.type === "FurimaTodoScanNow") {
    getManagerConfig()
      .then((config) => scanMercariSoldTodos(config, true))
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: String((error && error.message) || error),
      }));
    return true;
  }
  if (msg && msg.type === "FurimaManagerPollNow") {
    pollManagerTasks("manual").then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// Yahoo! オークション「落札者なし」一覧を全ページ確認し、順番に再出品する。
const YAHOO_RELIST_STATE_KEY = "yahooRelistState";
const YAHOO_RELIST_MAX_ITEMS = 1000;
let yahooRelistRun = null;

function isYahooClosedNoWinnerUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://auctions.yahoo.co.jp" &&
      url.pathname === "/my/closed" &&
      url.searchParams.get("hasWinner") === "0"
    );
  } catch (e) {
    return false;
  }
}

async function scanYahooClosedPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const currentUrl = new URL(location.href);
      if (
        currentUrl.origin !== "https://auctions.yahoo.co.jp" ||
        currentUrl.pathname !== "/my/closed" ||
        currentUrl.searchParams.get("hasWinner") !== "0"
      ) {
        return { ok: false, error: "対象ページが「落札者なし」ではありません" };
      }
      const list = document.getElementById("itm") || document;
      const items = [];
      const seen = new Set();
      for (const link of list.querySelectorAll('a[href*="/sell/jp/show/resubmit"]')) {
        let url;
        try {
          url = new URL(link.href, location.href);
        } catch (e) {
          return { ok: false, error: "再出品リンクの URL を解析できませんでした" };
        }
        const id = url.searchParams.get("aID") || "";
        if (
          url.origin !== "https://auctions.yahoo.co.jp" ||
          url.pathname !== "/sell/jp/show/resubmit"
        ) {
          return { ok: false, error: "商品一覧に想定外の再出品リンクが含まれています" };
        }
        if (!/^[A-Za-z0-9]+$/.test(id)) {
          return { ok: false, error: "再出品リンクに有効な商品 ID がありません" };
        }
        if (seen.has(id)) continue;
        seen.add(id);
        const row = link.closest("tr, [role='row'], li") || link.parentElement;
        items.push({
          id,
          title: (row && row.textContent ? row.textContent : link.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120),
        });
      }

      const links = Array.from(document.querySelectorAll("a[href]"));
      const isClosedListPageLink = (link) => {
        try {
          const url = new URL(link.href, location.href);
          return (
            url.origin === currentUrl.origin &&
            url.pathname === currentUrl.pathname &&
            url.searchParams.get("hasWinner") === "0" &&
            url.href !== currentUrl.href
          );
        } catch (e) {
          return false;
        }
      };
      const findPageLink = (pattern) => links.find((link) => {
        if (!isClosedListPageLink(link)) return false;
        const label = [
          link.innerText,
          link.getAttribute("aria-label"),
          link.getAttribute("title"),
        ]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        return pattern.test(label);
      });
      const findRelPageLink = (rel) =>
        links.find(
          (link) =>
            isClosedListPageLink(link) && link.rel.split(/\s+/).includes(rel)
        );
      const parsePageUrl = (link) => {
        if (!link) return null;
        const parsedNext = new URL(link.href, location.href);
        if (
          parsedNext.origin === currentUrl.origin &&
          parsedNext.pathname === currentUrl.pathname &&
          parsedNext.searchParams.get("hasWinner") === "0" &&
          parsedNext.href !== currentUrl.href
        ) {
          return parsedNext.href;
        }
        return null;
      };
      const nextUrl = parsePageUrl(
        findRelPageLink("next") ||
          findPageLink(/^(次へ|次のページ|次ページ|次の\d+件|›|»|>)(?:\s|[（(]|$)/)
      );
      const previousUrl = parsePageUrl(
        findRelPageLink("prev") ||
          findPageLink(/^(前へ|前のページ|前ページ|前の\d+件|‹|«|<)(?:\s|[（(]|$)/)
      );
      return { ok: true, items, nextUrl, previousUrl };
    },
  });
  const scan = results[0] && results[0].result;
  if (!scan || !scan.ok) {
    throw new Error((scan && scan.error) || "商品一覧を読み取れませんでした");
  }
  return scan;
}

async function scanYahooClosedTab(tabId) {
  const sourceTab = await chrome.tabs.get(tabId);
  if (!isYahooClosedNoWinnerUrl(sourceTab.url || "")) {
    throw new Error("「落札者なし」（hasWinner=0）の出品終了分ページを開いてください");
  }
  const scanTab = await chrome.tabs.create({ url: sourceTab.url, active: false });
  const items = [];
  const seenItems = new Set();
  const seenPages = new Set();
  const pagesBackToFirst = [];
  const addItems = (page) => {
    for (const item of page.items) {
      if (seenItems.has(item.id)) continue;
      seenItems.add(item.id);
      items.push(item);
      if (items.length > YAHOO_RELIST_MAX_ITEMS) {
        throw new Error("対象が多すぎます。表示件数を減らしてから実行してください");
      }
    }
  };
  try {
    if (!(await waitForTabComplete(scanTab.id, 45000))) {
      throw new Error("商品一覧ページの読み込みがタイムアウトしました");
    }

    const backwardPages = new Set();
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const currentTab = await chrome.tabs.get(scanTab.id);
      const currentUrl = currentTab.url || "";
      if (backwardPages.has(currentUrl)) {
        throw new Error("商品一覧の前ページ移動でループを検出しました");
      }
      backwardPages.add(currentUrl);
      const page = await scanYahooClosedPage(scanTab.id);
      pagesBackToFirst.push(page);
      if (!page.previousUrl) break;
      await chrome.tabs.update(scanTab.id, { url: page.previousUrl });
      if (!(await waitForTabComplete(scanTab.id, 45000))) {
        throw new Error("前の商品一覧ページの読み込みがタイムアウトしました");
      }
      await remoteSleep(500);
      if (pageNumber === 99) {
        throw new Error("商品一覧のページ数が上限を超えました");
      }
    }
    backwardPages.forEach((url) => seenPages.add(url));

    for (let index = pagesBackToFirst.length - 1; index >= 0; index--) {
      addItems(pagesBackToFirst[index]);
    }

    let nextUrl = pagesBackToFirst[0] && pagesBackToFirst[0].nextUrl;
    for (let pageNumber = 0; nextUrl; pageNumber++) {
      if (pageNumber >= 100 || seenPages.size >= 100) {
        throw new Error("商品一覧のページ数が上限を超えました");
      }
      await chrome.tabs.update(scanTab.id, { url: nextUrl });
      if (!(await waitForTabComplete(scanTab.id, 45000))) {
        throw new Error("次の商品一覧ページの読み込みがタイムアウトしました");
      }
      await remoteSleep(700);
      const currentTab = await chrome.tabs.get(scanTab.id);
      const currentUrl = currentTab.url || "";
      if (seenPages.has(currentUrl)) {
        throw new Error("商品一覧のページ移動でループを検出しました");
      }
      seenPages.add(currentUrl);

      const page = await scanYahooClosedPage(scanTab.id);
      addItems(page);
      nextUrl = page.nextUrl;
    }
    return items;
  } finally {
    try {
      await chrome.tabs.remove(scanTab.id);
    } catch (e) {
      /* Scan tab may already be closed. */
    }
  }
}

async function setYahooRelistState(state) {
  const saved = Object.assign({}, state, { updatedAt: new Date().toISOString() });
  await chrome.storage.local.set({ [YAHOO_RELIST_STATE_KEY]: saved });
  return saved;
}

function sameYahooRelistIds(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

async function inspectAndAdvanceYahooRelist(
  tabId,
  expectedId,
  reviewClicks,
  finalSubmitAlreadyClicked
) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [expectedId, reviewClicks, finalSubmitAlreadyClicked],
    func: (itemId, priorReviewClicks, didFinalSubmit) => {
      const url = new URL(location.href);
      if (url.origin !== "https://auctions.yahoo.co.jp") {
        return { status: "error", error: "Yahoo! オークション以外のページへ移動しました" };
      }
      const isPreviewPage = url.pathname === "/sell/jp/show/preview";
      const visibleText = (el) => {
        if (!el || !el.getClientRects().length) return "";
        const text =
          el.tagName === "INPUT"
            ? el.value || el.getAttribute("aria-label") || ""
            : el.innerText || el.getAttribute("aria-label") || el.value || "";
        return String(text)
          .replace(/\s+/g, " ")
          .trim();
      };
      const notices = Array.from(
        document.querySelectorAll('h1, h2, [role="alert"], [role="status"], [class*="success"], [class*="complete"]')
      ).map(visibleText).filter(Boolean);
      if (
        notices.some((text) =>
          /再出品が完了しました|再出品しました|出品が完了しました|出品しました|出品完了/.test(text)
        )
      ) {
        return { status: "success" };
      }
      if (!url.pathname.startsWith("/sell/jp/show/")) {
        return {
          status: "error",
          error: "再出品後の完了を確認できないページへ移動しました: " + url.pathname,
        };
      }
      const pageItemId = url.searchParams.get("aID");
      if (pageItemId && pageItemId !== itemId) {
        return { status: "error", error: "再出品ページの商品 ID が一致しません" };
      }
      if (didFinalSubmit) return { status: "pending" };

      const finalLabels = new Set([
        "出品する",
        "再出品する",
        "この内容で再出品する",
        "この内容で出品する",
        "出品を確定する",
        "上記のガイドライン、規約、情報提供等に同意して出品する",
        "上記のガイドライン、規約、情報提供等に同意して 出品する",
      ]);
      const reviewLabels = new Set([
        "確認する",
        "入力内容を確認する",
        "確認画面へ",
        "出品する",
        "再出品する",
      ]);
      const scope =
        document.querySelector("main") ||
        document.querySelector('[role="main"]') ||
        document.body;
      if (!scope) {
        return { status: "pending" };
      }
      const controls = Array.from(
        scope.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')
      ).filter((el) => {
        const style = getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
      });
      const matches = controls
        .map((el) => ({ el, label: visibleText(el) }))
        .filter(({ label }) =>
          isPreviewPage ? finalLabels.has(label) : reviewLabels.has(label)
        );
      const previousClick =
        window.__fcYahooRelistClickedFor === itemId
          ? window.__fcYahooRelistClickedKind
          : null;
      if (previousClick === "submit") return { status: "pending" };
      if (
        previousClick === "review" &&
        !matches.some(({ label }) => isPreviewPage && finalLabels.has(label))
      ) {
        return { status: "pending" };
      }
      if (matches.length !== 1) {
        return {
          status: "error",
          error: matches.length
            ? "出品操作ボタンを一意に特定できませんでした"
            : "安全に押せる再出品ボタンが見つかりませんでした（可见操作：" +
              controls.map(({ label }) => label).filter(Boolean).slice(0, 8).join(" / ") +
              "）",
        };
      }
      const match = matches[0];
      const kind = isPreviewPage ? "submit" : "review";
      if (kind === "review" && priorReviewClicks >= 3) {
        return { status: "error", error: "確認ページが多すぎるため停止しました" };
      }
      window.__fcYahooRelistClickedFor = itemId;
      window.__fcYahooRelistClickedKind = kind;
      match.el.click();
      return { status: "clicked", kind, label: match.label };
    },
  });
  return results[0] && results[0].result;
}

async function processYahooRelistItem(tabId, item) {
  const url =
    "https://auctions.yahoo.co.jp/sell/jp/show/resubmit?aID=" +
    encodeURIComponent(item.id);
  await chrome.tabs.update(tabId, { url, active: true });
  if (!(await waitForTabComplete(tabId, 45000))) {
    throw new Error("再出品フォームの読み込みがタイムアウトしました");
  }
  await remoteSleep(1800);

  let finalSubmitClicked = false;
  let reviewClicks = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    const page = await inspectAndAdvanceYahooRelist(
      tabId,
      item.id,
      reviewClicks,
      finalSubmitClicked
    );
    if (!page) throw new Error("再出品ページから応答がありませんでした");
    if (page.status === "success") return { success: true };
    if (page.status === "error") throw new Error(page.error || "再出品ページを確認できませんでした");
    if (page.status === "clicked") {
      if (page.kind === "submit") finalSubmitClicked = true;
      else reviewClicks++;
      await waitForTabComplete(tabId, 30000);
      await remoteSleep(1200);
      continue;
    }
    await remoteSleep(1200);
  }
  throw new Error(
    finalSubmitClicked
      ? "送信後の完了表示を確認できませんでした。重複送信を避けるため処理を停止しました"
      : "再出品の完了を確認できず、処理を停止しました"
  );
}

async function runYahooRelist(tabId, requestedIds, run) {
  const stopKeepAlive = startKeepAlive();
  let workTabId = null;
  let keepWorkTab = false;
  let items = [];
  let completed = 0;
  try {
    items = await scanYahooClosedTab(tabId);
    const liveIds = items.map((item) => item.id);
    if (!sameYahooRelistIds(liveIds, requestedIds)) {
      throw new Error("確認後に対象ページの商品が変わりました。もう一度対象を確認してください");
    }
    if (!items.length) throw new Error("現在ページに再出品できる商品がありません");

    await setYahooRelistState({
      status: "running",
      total: items.length,
      completed: 0,
      currentId: null,
      message: "開始準備中",
    });
    const workTab = await chrome.tabs.create({ active: true });
    workTabId = workTab.id;

    for (let index = 0; index < items.length; index++) {
      if (run.stopRequested) break;
      const item = items[index];
      run.currentId = item.id;
      await setYahooRelistState({
        status: "running",
        total: items.length,
        completed,
        currentId: item.id,
        message: "処理中 " + (index + 1) + "/" + items.length + "：" + item.title,
      });
      await processYahooRelistItem(workTabId, item);
      completed++;
      run.currentId = null;
      await setYahooRelistState({
        status: "running",
        total: items.length,
        completed,
        currentId: item.id,
        message: "再出品を確認しました " + completed + "/" + items.length,
      });
    }

    const stopped = run.stopRequested || completed < items.length;
    await setYahooRelistState({
      status: stopped ? "stopped" : "completed",
      total: items.length,
      completed,
      currentId: run.currentId || null,
      message: stopped
        ? "停止しました（再出品済み " + completed + "/" + items.length + " 件）"
        : "現在ページの未落札商品をすべて再出品しました",
    });
  } catch (e) {
    keepWorkTab = !!workTabId;
    await setYahooRelistState({
      status: "error",
      total: items.length,
      completed,
      currentId: run.currentId || null,
      message: String((e && e.message) || e),
    });
  } finally {
    if (workTabId && !keepWorkTab) {
      try {
        await chrome.tabs.remove(workTabId);
      } catch (e) {
        /* Tab may already be closed. */
      }
    }
    if (yahooRelistRun === run) yahooRelistRun = null;
    stopKeepAlive();
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("FurimaYahooRelist")) {
    return false;
  }

  if (msg.type === "FurimaYahooRelistPreview") {
    const tabId = sender.tab && sender.tab.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, error: "Yahoo! オークションのタブから実行してください" });
      return false;
    }
    scanYahooClosedTab(tabId)
      .then((items) => sendResponse({ ok: true, items }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === "FurimaYahooRelistStart") {
    if (yahooRelistRun) {
      sendResponse({ ok: false, error: "Yahoo! 再出品を実行中です" });
      return false;
    }
    if (!Array.isArray(msg.ids) || !msg.ids.length) {
      sendResponse({ ok: false, error: "再出品対象がありません" });
      return false;
    }
    const tabId = sender.tab && sender.tab.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, error: "Yahoo! オークションの対象ページから実行してください" });
      return false;
    }
    const run = { stopRequested: false };
    yahooRelistRun = run;
    runYahooRelist(tabId, msg.ids, run).catch(async (e) => {
      await setYahooRelistState({
        status: "error",
        total: msg.ids.length,
        completed: 0,
        currentId: null,
        message: String((e && e.message) || e),
      });
      if (yahooRelistRun === run) yahooRelistRun = null;
    });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "FurimaYahooRelistStop") {
    if (!yahooRelistRun) {
      sendResponse({ ok: false, error: "実行中の Yahoo! 再出品はありません" });
      return false;
    }
    yahooRelistRun.stopRequested = true;
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
