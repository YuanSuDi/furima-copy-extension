// readers/paypay.js
// PayPayフリマ（Yahoo!フリマ）商品ページから出品情報を読み取る。
// v0.1.2: 画像の取得元を「この商品自身のデータ」に限定した。
//   ページ全体の __NEXT_DATA__ にはおすすめ商品など他商品の画像が100枚以上混ざっているため、
//   全走査は絶対にしない。URL の商品IDと一致する item ノードだけを読む。
//   取得順: 1) __NEXT_DATA__ の item ノード 2) JSON-LD（Product） 3) DOM（画像は og:image のみ）
(() => {
  "use strict";
  const FC = window.FurimaCopy;
  if (!FC) return;

  console.log("[FurimaCopy] paypay reader active:", location.href);

  function itemIdFromUrl() {
    const m = location.pathname.match(/\/item\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  // __NEXT_DATA__ の JSON テキストから、この商品のノードだけを探す。
  // 既知パスを先に試し、なければ「id が商品IDと一致し images を持つオブジェクト」を再帰探索する。
  // 既知パスのノードは、id が現在の URL の商品IDと一致する場合だけ採用する。
  // SPA の画面遷移では __NEXT_DATA__ が初回表示の商品のまま残るため、照合しないと
  // 「表示は新しい商品なのに最初に開いた商品がコピーされる」事故になる（v0.8.11、実測）。
  function itemNodeFromJsonText(text) {
    if (!text) return null;
    let root;
    try {
      root = JSON.parse(text);
    } catch (e) {
      return null;
    }
    const itemId = itemIdFromUrl();
    const known =
      root && root.props && root.props.initialState &&
      root.props.initialState.itemsState && root.props.initialState.itemsState.items &&
      root.props.initialState.itemsState.items.item;
    if (known && typeof known === "object") {
      if (!itemId || known.id == null || String(known.id) === itemId) return known;
    }
    if (!itemId) return null;
    let found = null;
    const walk = (v, depth) => {
      if (found || !v || depth > 10) return;
      if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
      if (typeof v === "object") {
        if (String(v.id) === itemId && Array.isArray(v.images)) { found = v; return; }
        Object.values(v).forEach((x) => walk(x, depth + 1));
      }
    };
    walk(root, 0);
    return found;
  }

  function findItemNode() {
    const el = document.getElementById("__NEXT_DATA__");
    if (!el || !el.textContent) return null;
    return itemNodeFromJsonText(el.textContent);
  }

  // SPA 遷移でページ内データが古い場合の保険：現在の URL の HTML を取り直し、
  // その中の __NEXT_DATA__ から現在の商品ノードを読む（v0.8.11）。
  async function fetchFreshItemNode() {
    try {
      const res = await fetch(location.href, { credentials: "same-origin" });
      if (!res.ok) return null;
      const html = await res.text();
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) return null;
      return itemNodeFromJsonText(m[1]);
    } catch (e) {
      console.warn("[FurimaCopy] paypay refetch failed", e);
      return null;
    }
  }

  function fromItemNode(node) {
    if (!node) return null;
    const imageUrls = [];
    (Array.isArray(node.images) ? node.images : []).forEach((im) => {
      const u = typeof im === "string" ? im : im && typeof im.url === "string" ? im.url : null;
      if (u && !imageUrls.includes(u)) imageUrls.push(u);
    });
    const cat = Array.isArray(node.categoryList)
      ? node.categoryList.map((c) => c && c.name).filter(Boolean).join(" > ")
      : null;
    return {
      title: typeof node.title === "string" ? node.title : null,
      description: typeof node.description === "string" ? node.description : null,
      price: FC.parsePrice(node.price),
      imageUrls,
      conditionText: node.condition && typeof node.condition.text === "string" ? node.condition.text : null,
      categoryText: cat || null,
      shippingText: node.deliveryMethod && typeof node.deliveryMethod.name === "string" ? node.deliveryMethod.name : null,
    };
  }

  function fromJsonLd() {
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

  // DOM は最後の保険。画像は他商品サムネイルが混ざるので og:image 1枚だけに限定する。
  function fromDom() {
    const ogImage = FC.dom.meta("og:image");
    return {
      title: FC.dom.text(["h1"]) || FC.dom.meta("og:title"),
      description: FC.dom.text(['[class*="description"]', '[class*="Description"]', '[class*="comment"]']),
      price: FC.parsePrice(FC.dom.text(['[class*="Price"]', '[class*="price"]'])),
      imageUrls: ogImage ? [ogImage] : [],
      conditionText: FC.dom.specValue(["商品の状態", "状態"]),
      categoryText: FC.dom.specValue(["カテゴリー", "カテゴリ"]),
      shippingText: FC.dom.specValue(["送料", "配送", "発送"]),
    };
  }

  async function handleCopy() {
    let node = null, ld = null, dom = null;
    try { node = fromItemNode(findItemNode()); } catch (e) { console.warn("[FurimaCopy] paypay item node failed", e); }
    if (!node) {
      // ページ内データが現在の商品と一致しない（SPA 遷移後の古いデータ）場合は、
      // 現在の URL の HTML を取り直して読み直す。
      try {
        const fresh = await fetchFreshItemNode();
        if (fresh) node = fromItemNode(fresh);
      } catch (e) { console.warn("[FurimaCopy] paypay fresh node failed", e); }
    }
    try { ld = fromJsonLd(); } catch (e) { console.warn("[FurimaCopy] paypay jsonld failed", e); }
    try { dom = fromDom(); } catch (e) { console.warn("[FurimaCopy] paypay dom failed", e); }

    // 優先順位: item ノード > JSON-LD > DOM。画像も同じ優先順位で、最初に取れた集合をそのまま使う。
    let data = FC.mergeData(dom || {}, ld || {});
    data = FC.mergeData(data, node || {});
    const imgSource = [node, ld, dom].find((x) => x && x.imageUrls && x.imageUrls.length);
    data.imageUrls = imgSource ? imgSource.imageUrls : [];

    const saved = await FC.save(Object.assign({}, data, { source: "paypay", sourceUrl: location.href }));
    console.log("[FurimaCopy] paypay diag:", {
      itemNode: !!node, itemNodeImages: node ? node.imageUrls.length : 0,
      jsonLdImages: ld ? (ld.imageUrls || []).length : 0,
      finalImages: saved.imageUrls.length,
    }, saved);
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

  // PayPayフリマも SPA のため、スクリプトはドメイン全体で読み込ませ、
  // 商品ページ（/item/<id>）のときだけボタンを出す（v0.7.4、Mercari v0.4.1 と同方式）。
  // /item/add は出品ページなので除外する。
  const onItemPage = () =>
    /^\/item\/(?!add(?:\/|$))[^/]+/.test(location.pathname);
  FC.ui.mountButton(handleCopy, onItemPage);

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
