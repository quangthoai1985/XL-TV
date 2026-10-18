// Kiểm thử script canh domain chạy trên GitHub Actions (scripts/watch-domain.mjs).
//
// Fetch giả trả đúng redirect thô (301 + Location) vì script tự đi từng bước redirect.

import { test } from "node:test";
import assert from "node:assert/strict";
import { watchDomain } from "../scripts/watch-domain.mjs";

const GRID = '<div class="grid-matches__item-match">x</div>';

// sites: { origin: { redirect: "https://..." } | { html } | { status } | { dead: true } }
function fakeFetch(sites) {
  return async (url) => {
    const u = new URL(url);
    const s = sites[u.origin];
    if (!s || s.dead) throw new Error("fetch failed");
    if (s.redirect) {
      return new Response("", { status: 301, headers: { location: s.redirect.replace(/\/$/, "") + u.pathname } });
    }
    if (s.status) return new Response("error code: 1010", { status: s.status });
    return new Response(s.html ?? "", { status: 200 });
  };
}

const CONFIG = {
  sources: { xoilacz: "https://cu.example/" },
  source_url: "https://cu.example/",
  anchor_domains: ["cu.example", "xoilacz.vip", "xoilacz.io"],
  pin_domain: false,
  note: "giữ nguyên"
};

test("anchor chuyển hướng sang domain mới có lưới trận → đổi config", async () => {
  const out = await watchDomain(CONFIG, { fetchImpl: fakeFetch({
    "https://cu.example": { dead: true },
    "https://xoilacz.vip": { redirect: "https://moi.example/" },
    "https://xoilacz.io": { status: 403 },
    "https://moi.example": { html: GRID }
  }) });
  assert.equal(out.status, "changed");
  assert.equal(out.target, "https://moi.example");
  assert.equal(out.next.source_url, "https://moi.example/");
  assert.equal(out.next.sources.xoilacz, "https://moi.example/");
  // domain mới lên đầu, domain cũ (chết, không phải biển chỉ đường) bị bỏ
  assert.deepEqual(out.next.anchor_domains, ["moi.example", "xoilacz.vip", "xoilacz.io"]);
  assert.equal(out.next.note, "giữ nguyên");
  assert.equal(out.next.pin_domain, false);
});

test("domain cũ đóng băng vẫn ra lưới trận nhưng anchor chỉ nơi khác → vẫn đổi", async () => {
  const out = await watchDomain(CONFIG, { fetchImpl: fakeFetch({
    "https://cu.example": { html: GRID },
    "https://xoilacz.vip": { redirect: "https://moi.example/" },
    "https://xoilacz.io": { status: 403 },
    "https://moi.example": { html: GRID }
  }) });
  assert.equal(out.status, "changed");
  assert.equal(out.target, "https://moi.example");
});

test("anchor đều bị chặn, domain hiện tại còn sống → giữ nguyên", async () => {
  const out = await watchDomain(CONFIG, { fetchImpl: fakeFetch({
    "https://cu.example": { html: GRID },
    "https://xoilacz.vip": { status: 403 },
    "https://xoilacz.io": { status: 403 }
  }) });
  assert.equal(out.status, "unchanged");
  assert.equal(out.next, undefined);
});

test("anchor chỉ vào chính domain hiện tại → không đổi", async () => {
  const out = await watchDomain(CONFIG, { fetchImpl: fakeFetch({
    "https://cu.example": { html: GRID },
    "https://xoilacz.vip": { redirect: "https://cu.example/" },
    "https://xoilacz.io": { dead: true }
  }) });
  assert.equal(out.status, "unchanged");
});

test("anchor chỉ vào trang park (200, không lưới) → không nhận bừa", async () => {
  const out = await watchDomain(CONFIG, { fetchImpl: fakeFetch({
    "https://cu.example": { html: GRID },
    "https://xoilacz.vip": { redirect: "https://park.example/" },
    "https://xoilacz.io": { dead: true },
    "https://park.example": { html: "<html>domain for sale</html>" }
  }) });
  assert.equal(out.status, "unchanged");
  assert.equal(out.target, "https://cu.example");
});

test("lưới trận chỉ có ở /truc-tiep/ trên domain mới → vẫn nhận", async () => {
  const sites = {
    "https://cu.example": { dead: true },
    "https://xoilacz.vip": { redirect: "https://moi.example/" },
    "https://xoilacz.io": { dead: true }
  };
  const base = fakeFetch(sites);
  const fetchImpl = async (url, o) => {
    const u = new URL(url);
    if (u.origin === "https://moi.example") {
      return new Response(u.pathname === "/truc-tiep/" ? GRID : "", { status: u.pathname === "/truc-tiep/" ? 200 : 404 });
    }
    return base(url, o);
  };
  const out = await watchDomain(CONFIG, { fetchImpl });
  assert.equal(out.status, "changed");
  assert.equal(out.target, "https://moi.example");
});

test("mọi thứ đều chết → dead, không ném exception", async () => {
  const out = await watchDomain(CONFIG, { fetchImpl: fakeFetch({}) });
  assert.equal(out.status, "dead");
  assert.equal(out.target, null);
});

test("domain hiện tại không nằm trong anchor vẫn được dò", async () => {
  const cfg = { ...CONFIG, anchor_domains: ["xoilacz.vip"] };
  const out = await watchDomain(cfg, { fetchImpl: fakeFetch({
    "https://cu.example": { html: GRID },
    "https://xoilacz.vip": { status: 403 }
  }) });
  assert.equal(out.status, "unchanged");
});

test("hai anchor chỉ hai nơi khác nhau → lấy anchor đứng trước và cảnh báo", async () => {
  const out = await watchDomain(CONFIG, { fetchImpl: fakeFetch({
    "https://cu.example": { dead: true },
    "https://xoilacz.vip": { redirect: "https://a.example/" },
    "https://xoilacz.io": { redirect: "https://b.example/" },
    "https://a.example": { html: GRID },
    "https://b.example": { html: GRID }
  }) });
  assert.equal(out.target, "https://a.example");
  assert.equal(out.disagree, true);
});
