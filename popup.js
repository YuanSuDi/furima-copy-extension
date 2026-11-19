// popup.js
// ポップアップ: 現在ステージング中のコピーデータを表示する。
// lib/store.js の FurimaCopy.load() / clear() を使う。
(() => {
  "use strict";

  const SOURCE_LABELS = {
    mercari: "メルカリ",
    rakuma: "ラクマ",
    paypay: "PayPayフリマ",
    yahoo: "Yahoo!オークション",
  };

  async function render() {
    const emptyEl = document.getElementById("empty");
    const itemEl = document.getElementById("item");
    const data = await window.FurimaCopy.load();

    if (!data) {
      emptyEl.hidden = false;
      itemEl.hidden = true;
      return;
    }

    emptyEl.hidden = true;
    itemEl.hidden = false;

    document.getElementById("source").textContent =
      SOURCE_LABELS[data.source] || data.source || "不明";
    document.getElementById("title").textContent = data.title || "（タイトル不明）";
    document.getElementById("price").textContent =
      data.price != null ? "¥" + Number(data.price).toLocaleString("ja-JP") : "価格不明";

    const thumb = document.getElementById("thumb");
    thumb.referrerPolicy = "no-referrer";
    if (data.imageUrls && data.imageUrls.length) {
      thumb.src = data.imageUrls[0];
      thumb.hidden = false;
      // 取り込み済みの画像データがあればそちらを優先表示する
      // （拡張ページから CDN の URL は防盗链で読めないため、v0.6.1）。
      try {
        const stored = await chrome.storage.local.get("copyImages");
        const imgs = stored.copyImages;
        const first =
          imgs && Array.isArray(imgs.items)
            ? imgs.items.find((x) => x && x.base64)
            : null;
        if (first) {
          thumb.src =
            "data:" + (first.mime || "image/jpeg") + ";base64," + first.base64;
        }
      } catch (e) {
        /* URL のまま表示を試みる */
      }
    } else {
      thumb.hidden = true;
    }

    const imageCount = data.imageUrls ? data.imageUrls.length : 0;
    const when = data.copiedAt ? new Date(data.copiedAt).toLocaleString("ja-JP") : "";
    document.getElementById("meta").textContent =
      "画像 " + imageCount + " 枚" + (when ? " ・ コピー日時: " + when : "");
  }

  document.getElementById("clear").addEventListener("click", async () => {
    await window.FurimaCopy.clear();
    render();
  });

  // ---- リモート指令（v0.5.0） ---------------------------------------------
  const remoteEls = {
    enabled: document.getElementById("remoteEnabled"),
    cmdUrl: document.getElementById("remoteCmdUrl"),
    status: document.getElementById("remoteStatus"),
    testUrl: document.getElementById("remoteTestUrl"),
  };

  async function renderRemote() {
    const res = await chrome.storage.local.get(["remoteConfig", "lastRemoteResult"]);
    const cfg = res.remoteConfig || {};
    remoteEls.enabled.checked = !!cfg.enabled;
    if (document.activeElement !== remoteEls.cmdUrl) {
      remoteEls.cmdUrl.value = cfg.cmdUrl || "";
    }
    const lines = [];
    lines.push("状態: " + (cfg.lastStatus || "未設定"));
    if (cfg.lastPollAt) {
      lines.push("最終チェック: " + new Date(cfg.lastPollAt).toLocaleString("ja-JP"));
    }
    const r = res.lastRemoteResult;
    if (r) {
      lines.push(
        "最終指令: " + (r.id || "") + " / " + r.status +
        (r.copy ? " / " + (r.copy.title || "") + "（画像" + r.copy.imageCount + "枚）" : "") +
        (r.error ? " / " + r.error : "")
      );
    }
    remoteEls.status.textContent = lines.join("\n");
  }

  document.getElementById("remoteSave").addEventListener("click", async () => {
    const res = await chrome.storage.local.get("remoteConfig");
    const cfg = Object.assign({}, res.remoteConfig || {}, {
      enabled: remoteEls.enabled.checked,
      cmdUrl: remoteEls.cmdUrl.value.trim(),
    });
    await chrome.storage.local.set({ remoteConfig: cfg });
    renderRemote();
  });

  document.getElementById("remotePollNow").addEventListener("click", () => {
    remoteEls.status.textContent = "チェック中…";
    chrome.runtime.sendMessage({ type: "FurimaRemotePollNow" }, () => {
      setTimeout(renderRemote, 800);
    });
  });

  document.getElementById("remoteTest").addEventListener("click", () => {
    const url = remoteEls.testUrl.value.trim();
    if (!url) {
      remoteEls.status.textContent = "テスト用 URL を入力してください";
      return;
    }
    remoteEls.status.textContent = "テスト実行中…（商品ページ→出品ページの順に開きます）";
    chrome.runtime.sendMessage({ type: "FurimaRemoteTest", itemUrl: url }, () => {
      setTimeout(renderRemote, 800);
    });
  });

  // ---- 出品管理プログラム連携（v0.9.0） -----------------------------------
  const mgrEls = {
    enabled: document.getElementById("mgrEnabled"),
    baseUrl: document.getElementById("mgrBaseUrl"),
    token: document.getElementById("mgrToken"),
    status: document.getElementById("mgrStatus"),
  };

  async function renderManager() {
    const res = await chrome.storage.local.get("managerConfig");
    const cfg = res.managerConfig || {};
    mgrEls.enabled.checked = !!cfg.enabled;
    if (document.activeElement !== mgrEls.baseUrl) {
      mgrEls.baseUrl.value = cfg.baseUrl || "http://127.0.0.1:17341";
    }
    if (document.activeElement !== mgrEls.token) {
      mgrEls.token.value = cfg.token || "";
    }
    const lines = [];
    lines.push("状態: " + (cfg.lastStatus || "未設定"));
    lines.push("卖出监测: " + (cfg.lastSaleScanStatus || "未扫描"));
    if (cfg.lastSaleScanAt) {
      lines.push("卖出监测时间: " + new Date(cfg.lastSaleScanAt).toLocaleString("zh-CN"));
    }
    if (cfg.lastPollAt) {
      lines.push("最終チェック: " + new Date(cfg.lastPollAt).toLocaleString("ja-JP"));
    }
    mgrEls.status.textContent = lines.join("\n");
  }

  document.getElementById("mgrSave").addEventListener("click", async () => {
    const res = await chrome.storage.local.get("managerConfig");
    const cfg = Object.assign({}, res.managerConfig || {}, {
      enabled: mgrEls.enabled.checked,
      baseUrl: mgrEls.baseUrl.value.trim() || "http://127.0.0.1:17341",
      token: mgrEls.token.value.trim(),
    });
    await chrome.storage.local.set({ managerConfig: cfg });
    renderManager();
  });

  document.getElementById("mgrPollNow").addEventListener("click", () => {
    mgrEls.status.textContent = "チェック中…";
    chrome.runtime.sendMessage({ type: "FurimaManagerPollNow" }, () => {
      setTimeout(renderManager, 1200);
    });
  });

  render();
  renderRemote();
  renderManager();
})();
