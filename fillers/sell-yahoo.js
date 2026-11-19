// fillers/sell-yahoo.js
// Yahoo!オークション出品ページ（https://auctions.yahoo.co.jp/jp/show/submit）に、
// ステージング中のコピーデータをフォームへ入力する。
// 従来型の長いフォーム:
//   - タイトル / 開始価格 は自動入力（希望落札価格は手動）
//   - 説明欄はリッチテキストエディタで、実体が子 iframe 内にあることがあるため、
//     トップフレームで見つからなければ各 iframe に入力を依頼する（下記 message 連携）
//   - 画像は単体 input[type=file] が複数並ぶ形式 → lib/fill.js が 1 枚ずつ配る
//   - 商品の状態はネイティブ <select> のテキスト一致を試す
//   - それ以外（カテゴリ、配送、期間など）は手動
// 送信・出品ボタンは絶対に押さない。
(() => {
  "use strict";
  const FC = window.FurimaCopy;
  const FF = window.FurimaFill;
  if (!FC || !FF) return;

  const VERSION = chrome.runtime.getManifest().version;
  console.log("[FurimaCopy] yahoo sell filler active: v" + VERSION, location.href);

  // ---- 説明文の入力 ---------------------------------------------------------------
  // Yahoo! の説明欄は RTE（リッチテキストエディタ）で、構造は実測で判明している:
  //   編集実体: #descriptionArea 内の iframe（id="rteEditorComposition*", about:blank）の body
  //   送信先:   hidden input 群（Description / Description_rte / Description_rte_work /
  //             Description_plain）。送信時にエディタ body から再同期される想定だが、
  //             保険として隠しフィールドにも同じ内容を入れておく。
  // 戻り値は入力経路のコード（false = 失敗）。パネルの注記に使う。
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function syncHiddenDescription(html, plain) {
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = v == null ? "" : v;
    };
    set("Description_rte", html);
    set("Description_rte_work", html);
    set("Description", html);
    set("Description_plain", plain);
  }

  // html が渡された場合（Yahoo!→Yahoo! で書式ごとコピーできる場合）はそれをそのまま
  // 編集領域へ入れ、隠しフィールドの plain 側にはプレーンテキスト版を同期する。
  function fillDescriptionInEditorIframe(value, html) {
    if (window !== window.top) return false;
    const frames = Array.from(document.querySelectorAll("iframe"));
    const inDescArea = frames.filter((f) => f.closest("#descriptionArea"));
    const rteLike = frames.filter((f) => /rte|editor/i.test(f.id || ""));
    const targets = inDescArea.length ? inDescArea : rteLike;
    for (const f of targets) {
      let doc = null;
      try {
        doc = f.contentDocument;
      } catch (e) {
        doc = null; // クロスオリジンで触れないフレームは対象外
      }
      if (!doc || !doc.body) continue;
      try {
        const bodyHtml = html || escapeHtml(value).replace(/\n/g, "<br>");
        doc.body.innerHTML = bodyHtml;
        doc.body.dispatchEvent(new Event("input", { bubbles: true }));
        doc.body.dispatchEvent(new Event("keyup", { bubbles: true }));
        doc.dispatchEvent(new Event("input", { bubbles: true }));
        syncHiddenDescription(bodyHtml, value);
        console.log(
          "[FurimaCopy] description -> editor iframe body",
          f.id || "(no id)",
          html ? "(html)" : "(text)"
        );
        return true;
      } catch (e) {
        console.warn("[FurimaCopy] editor iframe write failed", e);
      }
    }
    return false;
  }

  // このフレーム内で説明文の入力を試す。汎用 fillText のラベル探索は
  // 別セクションの入力欄（製品検索など）を誤爆した実績があるため使わない。
  function fillDescriptionLocal(value, html) {
    if (!value && !html) return false;
    // 0) RTE の iframe 本体（Yahoo! の実構造）。HTML はこの経路でのみ使う。
    if (fillDescriptionInEditorIframe(value, html)) return html ? "editor-iframe-html" : "editor-iframe";
    // 1) 見えている textarea（name / id が説明系のものだけ）
    if (
      FF.fillText(
        [
          'textarea[name*="description" i]',
          'textarea[name*="detail" i]',
          'textarea[id*="description" i]',
          'textarea[id*="detail" i]',
        ],
        null,
        value
      )
    ) {
      return "textarea";
    }
    // 2) contenteditable の編集欄
    if (FF.fillContentEditable(["商品の説明", "説明"], value)) return "editable";
    // 3) エディタ iframe の body 自体が編集領域の場合
    try {
      if (document.body && document.body.isContentEditable) {
        document.body.focus();
        document.body.innerText = value;
        document.body.dispatchEvent(new InputEvent("input", { bubbles: true }));
        console.log("[FurimaCopy] description -> editable body", location.href);
        return "body";
      }
    } catch (e) {
      /* 次の手段へ */
    }
    // 4) 子フレーム内に textarea が 1 つだけならそれが編集欄とみなす
    if (window !== window.top) {
      const tas = Array.from(document.querySelectorAll("textarea")).filter((t) => FF.isVisible(t));
      if (tas.length === 1) {
        FF.setNativeValue(tas[0], value);
        console.log("[FurimaCopy] description -> sole textarea in frame", location.href);
        return "frame-textarea";
      }
    }
    // 5) 隠れている backing textarea（画面には出ないため、経路を呼び出し側へ返す）
    const ta = document.querySelector(
      'textarea[name*="description" i], textarea[name*="detail" i], textarea[id*="description" i], textarea[id*="detail" i]'
    );
    if (ta) {
      FF.setNativeValue(ta, value);
      console.log("[FurimaCopy] description -> hidden textarea", ta);
      return "hidden";
    }
    return false;
  }

  // 子フレーム（エディタ等）からの入力依頼を受ける。
  window.addEventListener("message", (ev) => {
    if (!ev.data || ev.data.type !== "FC_FILL_DESC" || (!ev.data.value && !ev.data.html)) return;
    const code = fillDescriptionLocal(ev.data.value, ev.data.html);
    console.log("[FurimaCopy] frame description fill:", location.href, code);
    if (code) {
      try {
        window.parent.postMessage({ type: "FC_DESC_RESULT", ok: true }, "*");
      } catch (e) {
        /* 親へ通知できなくても入力自体は済んでいる */
      }
    }
  });

  // トップフレームから子フレームへ説明文の入力を依頼し、成否を待つ。
  function requestFrameFillDescription(value, html) {
    return new Promise((resolve) => {
      const frames = Array.from(document.querySelectorAll("iframe"));
      if (!frames.length) return resolve(false);
      let settled = false;
      const onMsg = (ev) => {
        if (ev.data && ev.data.type === "FC_DESC_RESULT" && ev.data.ok) {
          settled = true;
          window.removeEventListener("message", onMsg);
          resolve(true);
        }
      };
      window.addEventListener("message", onMsg);
      frames.forEach((f) => {
        try {
          if (f.contentWindow)
            f.contentWindow.postMessage({ type: "FC_FILL_DESC", value, html }, "*");
        } catch (e) {
          /* 到達できないフレームは無視 */
        }
      });
      setTimeout(() => {
        window.removeEventListener("message", onMsg);
        resolve(settled);
      }, 1000);
    });
  }

  // フォームの実態調査: このドキュメント内の全フィールドと iframe 一覧を出す。
  function logFormCensus() {
    try {
      const fields = Array.from(document.querySelectorAll("input, textarea, select")).map((el) => ({
        tag: el.tagName,
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "",
        id: el.id || "",
        ph: el.getAttribute("placeholder") || "",
        visible: !!(el.offsetWidth || el.offsetHeight),
      }));
      console.log("[FurimaCopy] yahoo form census:", {
        url: location.href,
        inFrame: window !== window.top,
        fieldCount: fields.length,
        fields: fields.slice(0, 40),
        iframes: Array.from(document.querySelectorAll("iframe")).map((f) => f.src || "(no src)"),
      });
    } catch (e) {
      console.warn("[FurimaCopy] census failed", e);
    }
  }

  async function handleFill() {
    logFormCensus();
    const data = await FC.load();
    if (!data) {
      FC.ui.showToast("コピー済みの商品がありません");
      return;
    }
    console.log("[FurimaCopy] yahoo fill with: v" + VERSION, data);
    const lines = [];

    // タイトル
    const titleOk = FF.fillText(
      ['input[name*="title" i]', 'input[id*="title" i]', 'input[placeholder*="タイトル"]'],
      ["タイトル", "商品名"],
      data.title
    );
    lines.push({
      label: "タイトル",
      status: titleOk ? "ok" : "fail",
      note: titleOk ? undefined : data.title ? "入力欄が見つかりませんでした" : "コピー元にタイトルがありません",
    });

    // 商品の説明: このフレームで試し、ダメなら子フレーム（エディタ）に依頼する。
    // Yahoo!→Yahoo! で説明の HTML が取れている場合は、書式ごとエディタへ入れる。
    const descHtml =
      data.source === "yahoo" && data.descriptionHtml ? data.descriptionHtml : null;
    let descText = data.description || null;
    if (!descText && descHtml) {
      const tmp = document.createElement("div");
      tmp.innerHTML = descHtml;
      descText = (tmp.textContent || "").trim() || null;
    }
    let descCode = false;
    if (descText || descHtml) {
      descCode = fillDescriptionLocal(descText, descHtml);
      if (!descCode && (await requestFrameFillDescription(descText, descHtml))) {
        descCode = descHtml ? "frame-message-html" : "frame-message";
      }
    }
    lines.push({
      label: "商品の説明",
      status: descCode ? "ok" : "fail",
      note: !descText && !descHtml
        ? "コピー元に説明がありません"
        : !descCode
          ? "入力欄が見つかりませんでした"
          : descCode === "hidden"
            ? "（画面に表示されない欄へ入力・要確認）"
            : String(descCode).includes("html")
              ? "（書式ごとコピー）"
              : undefined,
    });

    // 開始価格（コピー元の価格をそのまま入れる。希望落札価格は手動）
    const priceOk = FF.fillText(
      ['input[name*="startprice" i]', 'input[name*="price" i]', 'input[name*="start" i]', 'input[id*="price" i]'],
      ["開始価格"],
      data.price != null ? String(data.price) : null
    );
    lines.push({
      label: "開始価格",
      status: priceOk ? "ok" : "fail",
      note: priceOk ? "¥" + Number(data.price).toLocaleString("ja-JP") : data.price != null ? "入力欄が見つかりませんでした" : "コピー元に価格がありません",
    });
    lines.push({
      label: "希望落札価格",
      status: "manual",
      note: "手動で入力してください（開始価格と同じにするか空欄）",
    });

    // 画像（単体ファイル入力が複数ある前提で配布される）
    if (data.imageUrls && data.imageUrls.length) {
      const r = await FF.attachImages(data.imageUrls);
      lines.push({
        label: "画像",
        status: r.attached ? "ok" : "fail",
        note: r.attached + "枚添付" + (r.failed ? " / " + r.failed + "枚失敗" : ""),
      });
    } else {
      lines.push({ label: "画像", status: "fail", note: "コピー元に画像がありません" });
    }

    // 商品の状態（ネイティブ select をテキスト一致で試す）
    // 2026-11-17 実測: Yahoo! の状態はネイティブ select で、選択肢は
    // 未使用 / 未使用に近い / 目立った傷や汚れなし / やや傷や汚れあり /
    // 傷や汚れあり / 全体的に状態が悪い。最上位の呼び名だけが他プラットフォーム
    // と違う（Mercari 等の「新品、未使用」＝ Yahoo! の「未使用」）ため、
    // 候補に相互の表記を加えてクロスプラットフォーム複写でも選べるようにする。
    const condSel = FF.findSelect(
      ['select[name*="condition" i]', 'select[name*="state" i]', 'select[id*="condition" i]'],
      ["商品の状態", "状態"]
    );
    const condCandidates = [];
    if (data.conditionText) {
      condCandidates.push(data.conditionText);
      if (data.conditionText === "新品、未使用") condCandidates.push("未使用");
      if (data.conditionText === "未使用") condCandidates.push("新品、未使用");
    }
    const condOk = condSel && condCandidates.length
      ? FF.trySelectByText(condSel, condCandidates)
      : false;
    const condShown =
      condOk && condSel && condSel.selectedIndex >= 0
        ? condSel.options[condSel.selectedIndex].text
        : data.conditionText;
    lines.push({
      label: "商品の状態",
      status: condOk ? "ok" : "manual",
      note: condOk ? condShown : "手動" + (data.conditionText ? "（候補： " + data.conditionText + "）" : "で選択してください"),
    });

    // その他は手動。
    lines.push({
      label: "カテゴリ",
      status: "manual",
      note: "手動" + (data.categoryText ? "（候補： " + data.categoryText + "）" : "で選択してください"),
    });
    lines.push({
      label: "配送・送料",
      status: "manual",
      note: "手動" + (data.shippingText ? "（候補： " + data.shippingText + "）" : "で選択してください"),
    });

    lines.push({
      label: "送信前確認",
      status: "manual",
      note: "内容を確認してから出品してください（自動送信はしません）",
    });

    FF.showPanel("Yahoo!オークション 出品フォーム入力結果 (v" + VERSION + ")", lines);
  }

  // ボタンはトップフレームだけに置く（子フレームでは message 連携のみ）。
  if (window === window.top) {
    FF.mountFillButton(handleFill, null, "yahoo");
  }
})();
