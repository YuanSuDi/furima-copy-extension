// readers/yahoo.js
// Yahoo!オークション商品ページ（https://auctions.yahoo.co.jp/jp/auction/*）から出品情報を読み取る。
// 第一候補: JSON-LD（Product）。第二候補: DOM（価格は「現在価格」の表記も拾う）。
// 最後の保険: og: メタタグ。どの項目も取れなければ null / 空配列にし、例外は投げない。
// 注意（v0.8.3）: JSON-LD の description は途中で切れた要約文のことがある（実測では約150字で
// 切断され、表組みも潰れる）。説明文はページの説明ブロックから全文を取り、DOM 側が長ければ
// そちらを優先する。あわせて説明ブロックの HTML（危険な要素を除いたもの）を descriptionHtml
// として保存し、Yahoo!→Yahoo! のコピーでは書式ごと再現できるようにする。
(() => {
  "use strict";
  const FC = window.FurimaCopy;
  if (!FC) return;

  function extractFromJsonLd() {
    for (const node of FC.dom.jsonLdList()) {
      const type = node["@type"];
      const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
      if (!isProduct) continue;
      const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      const images = node.image ? (Array.isArray(node.image) ? node.image : [node.image]) : [];
      return {
        title: typeof node.name === "string" ? node.name : null,
        description: typeof node.description === "string" ? node.description : null,
        price: offers ? FC.parsePrice(offers.price) : null,
        imageUrls: images.filter((x) => typeof x === "string"),
      };
    }
    return null;
  }

  const EXPLANATION_SELECTORS = [
    '[class*="ProductExplanation"]',
    '[class*="explanation"]',
    '[id*="description"]',
  ];

  // ページ上の「商品の説明」ブロック要素を探す。セレクタで見つからなければ
  // 「商品の説明」という見出しから親をたどる。
  function findExplanationEl() {
    for (const sel of EXPLANATION_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && (el.textContent || "").trim().length > 20) return el;
    }
    const heads = Array.from(document.querySelectorAll("h1, h2, h3, h4, dt, th, span, div, p"));
    const head = heads.find((h) => (h.textContent || "").trim() === "商品の説明");
    if (head) {
      let node = head;
      for (let i = 0; i < 3 && node; i++) {
        node = node.parentElement;
        if (node && (node.textContent || "").trim().length > 100) return node;
      }
    }
    return null;
  }

  // 説明ブロックを読みやすいプレーンテキスト化する（表は行ごとに改行、セルは空白区切り）。
  function readableText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    clone.querySelectorAll("td, th").forEach((c) => c.append(" "));
    clone
      .querySelectorAll("p, div, tr, li, table, h1, h2, h3, h4, h5, h6")
      .forEach((b) => b.append("\n"));
    const text = (clone.textContent || "")
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text || null;
  }

  // 説明ブロックの HTML を、スクリプト等の危険な要素・属性を取り除いて返す。
  function sanitizedHtml(el) {
    const clone = el.cloneNode(true);
    clone
      .querySelectorAll("script, style, iframe, object, embed, form, input, button, link, meta")
      .forEach((n) => n.remove());
    clone.querySelectorAll("*").forEach((n) => {
      Array.from(n.attributes || []).forEach((attr) => {
        if (/^on/i.test(attr.name)) n.removeAttribute(attr.name);
        if (
          (attr.name === "href" || attr.name === "src") &&
          /^\s*javascript:/i.test(attr.value || "")
        ) {
          n.removeAttribute(attr.name);
        }
      });
    });
    const html = (clone.innerHTML || "").trim();
    return html || null;
  }

  // カテゴリは値セル内のリンクを階層として拾い " > " でつなぐ。
  // textContent をそのまま取ると区切り文字が DOM に無く
  // 「コンピュータタブレットAppleiPad本体」のように潰れてしまう（実測）。
  function categoryFromDom() {
    const SKIP = ["トップ", "ホーム", "Yahoo!オークション", "すべてのカテゴリ"];
    const joinLinks = (root) => {
      const texts = Array.from(root.querySelectorAll("a"))
        .map((a) => (a.textContent || "").trim())
        .filter((t) => t && !SKIP.includes(t));
      const dedup = texts.filter((t, i) => i === 0 || t !== texts[i - 1]);
      return dedup.length ? dedup.join(" > ") : null;
    };
    // 1) 詳細表のカテゴリ行のリンク
    for (const el of document.querySelectorAll("th, dt")) {
      const labelText = (el.textContent || "").trim();
      if (!["カテゴリー", "カテゴリ"].some((l) => labelText.includes(l))) continue;
      const row = el.closest("tr");
      const cell = row ? row.querySelector("td") : el.nextElementSibling;
      if (cell) {
        const joined = joinLinks(cell);
        if (joined) return joined;
      }
    }
    // 2) パンくず（カテゴリパス）のリンク
    const crumbs = document.querySelectorAll(
      '[class*="breadcrumb" i], [id*="breadcrumb" i], [class*="categoryPath" i]'
    );
    for (const c of crumbs) {
      const joined = joinLinks(c);
      if (joined && joined.includes(">")) return joined;
    }
    return null;
  }

  function extractFromDom() {
    const explEl = findExplanationEl();
    const imgs = [];
    // ギャラリー付近の大きめの画像を優先し、取れなければ yimg の画像全体から拾う。
    const galleryImgs = document.querySelectorAll(
      '[class*="ProductImage"] img, [class*="productImage"] img, [id*="image"] img'
    );
    const pushImg = (img) => {
      const src = img.getAttribute("src") || img.getAttribute("data-src");
      if (src) imgs.push(src);
    };
    if (galleryImgs.length) {
      galleryImgs.forEach(pushImg);
    } else {
      document.querySelectorAll('img[src*="yimg.jp"]').forEach((img) => {
        // アイコン等の小さい画像を避けるため、表示サイズが取れる場合は 150px 以上だけ拾う。
        if (!img.complete || img.naturalWidth === 0 || img.naturalWidth >= 150) pushImg(img);
      });
    }
    const ogImage = FC.dom.meta("og:image");

    const priceText =
      FC.dom.text(['[class*="Price"]', '[class*="price"]']) ||
      FC.dom.specValue(["現在価格", "即決価格", "価格"]);

    return {
      title: FC.dom.text(["h1"]) || FC.dom.meta("og:title"),
      description: explEl ? readableText(explEl) : FC.dom.text(EXPLANATION_SELECTORS),
      descriptionHtml: explEl ? sanitizedHtml(explEl) : null,
      price: FC.parsePrice(priceText),
      imageUrls: imgs.length ? imgs : ogImage ? [ogImage] : [],
      conditionText: FC.dom.specValue(["商品の状態", "状態"]),
      categoryText: categoryFromDom() || FC.dom.specValue(["カテゴリー", "カテゴリ"]),
      shippingText: FC.dom.specValue(["送料", "配送", "発送"]),
    };
  }

  async function handleCopy() {
    let jsonData = null;
    try {
      jsonData = extractFromJsonLd();
    } catch (e) {
      console.warn("[FurimaCopy] JSON-LD の解析に失敗", e);
    }
    const domData = extractFromDom();
    const data = FC.mergeData(domData, jsonData);
    // JSON-LD の説明は切断された要約のことがあるため、DOM 側が長ければ DOM を正とする。
    if (
      domData.description &&
      (!data.description || domData.description.length > data.description.length)
    ) {
      data.description = domData.description;
    }
    if (domData.descriptionHtml) data.descriptionHtml = domData.descriptionHtml;
    const saved = await FC.save(
      Object.assign({}, data, { source: "yahoo", sourceUrl: location.href })
    );
    console.log("[FurimaCopy]", saved);
    // 画像データもこの場で取り込んで保存する（出品ページで CDN に再取得しないため）。
    FC.ui.showToast("コピーしました。画像を取り込み中…");
    let okCount = 0;
    try {
      const items = await FC.captureImages(
        (saved.imageUrls || []).map((u) => ({ key: u, urls: [u] })),
        saved.sourceUrl
      );
      okCount = items.filter((x) => x.base64).length;
    } catch (e) {
      console.warn("[FurimaCopy] captureImages failed", e);
    }
    FC.ui.showToast(
      "コピーしました：" + (saved.title || "（タイトル不明）") +
      "（画像" + saved.imageUrls.length + "枚 / 取込" + okCount + "枚）"
    );
  }

  FC.ui.mountButton(handleCopy);

  // リモート/取り込み用（v0.6.0）: バックグラウンドからの指示でコピーを実行する。
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== "FurimaRemoteCopy") return false;
      Promise.resolve()
        .then(() => handleCopy())
        .then(async () => {
          const d = await FC.load();
          sendResponse({
            ok: !!d,
            summary: d
              ? { title: d.title, price: d.price, imageCount: (d.imageUrls || []).length }
              : null,
          });
        })
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    });
  }
})();
