// Kiểm thử cơ chế tự bám domain nguồn.
//
// Chạy: node --test test/
//
// Trọng tâm là 3 lỗi của bản 1.2.0 khiến hệ thống không bắt kịp lần đổi tên miền:
//   A. chỉ gọi /truc-tiep/, bố cục mới không có đường dẫn đó → 404 → mất ứng viên
//   B. !res.ok thì vứt luôn kết quả, mất cả res.url đang chỉ đúng domain mới
//   C. domain đã nhớ được tin vô thời hạn → bám chết vào bản sao đóng băng của domain cũ

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeFetch, loadWorker, sourceHtml, PARKED_HTML } from "./fake-source.mjs";

const OLD = "https://nmsba.com";
const NEW = "https://newdom.example";
const A1 = "https://xoilacz.io";
const A2 = "https://xoilacz.vip";

const CONFIG = {
  sources: { xoilacz: OLD + "/" },
  source_url: OLD + "/",
  anchor_domains: ["xoilacz.io", "xoilacz.vip"],
  pin_domain: false
};

// Một origin phục vụ lưới trận ở trang gốc, các đường dẫn khác 404.
const serves = (label, n = 3) => ({ pages: { "/": { html: sourceHtml(n, label) } } });

async function callHome(worker, query = "") {
  const res = await worker.fetch(new Request("https://worker.test/" + query), {}, {});
  return { status: res.status, body: await res.json() };
}

async function callDebug(worker, query = "") {
  const res = await worker.fetch(new Request("https://worker.test/debug/discovery" + query), {}, {});
  return await res.json();
}

// --- A. Lưới trận nằm ở trang gốc, không phải /truc-tiep/ ---

test("A1: bố cục mới không có /truc-tiep/, vẫn cào được vì thử trang gốc trước", async () => {
  installFakeFetch({
    [A1]: { redirect: NEW, keepPath: true }, // anchor giữ nguyên path → /truc-tiep/ 404
    [A2]: { dead: true },
    [NEW]: serves("moi", 4),
    [OLD]: { dead: true }
  }, CONFIG);

  const worker = await loadWorker();
  const { status, body } = await callHome(worker);
  assert.equal(status, 200);
  assert.equal(body.matches.length, 4);
  assert.ok(body.matches[0].home_team.startsWith("moi"), "phải là dữ liệu của domain mới");
});

test("A2: nguồn chỉ phục vụ ở /truc-tiep/ thì vẫn chạy (dự phòng còn nguyên)", async () => {
  installFakeFetch({
    [A1]: { redirect: NEW, keepPath: true },
    [A2]: { dead: true },
    [NEW]: { pages: { "/truc-tiep/": { html: sourceHtml(2, "tt") } } },
    [OLD]: { dead: true }
  }, CONFIG);

  const worker = await loadWorker();
  const { body } = await callHome(worker);
  assert.equal(body.matches.length, 2);
});

// --- B. Trang 404 vẫn khai ra domain mới ---

test("B1: anchor 404 cả hai đường dẫn nhưng lộ origin mới → lần theo manh mối", async () => {
  installFakeFetch({
    // Anchor dời sang một origin trung gian chỉ có 404 ở mọi path đã thử,
    // nhưng res.url khai ra origin đó; lưới trận nằm ở /home của chính nó.
    [A1]: { redirect: NEW, keepPath: true },
    [A2]: { dead: true },
    [NEW]: { pages: { "*": { status: 404, html: "<h1>404</h1>" } } },
    [OLD]: { dead: true }
  }, CONFIG);

  const worker = await loadWorker();
  const { body } = await callHome(worker);
  // Không nơi nào có lưới → phải báo lỗi rõ ràng, không được trả rác.
  assert.ok(body.error, "không có lưới trận ở đâu thì phải báo lỗi");

  // Nhưng debug vẫn phải cho biết đã lần được tới đâu.
  const dbg = await callDebug(worker);
  assert.ok(dbg.paths_tried.includes("/"), "phải có thử trang gốc");
});

test("B2: domain cũ 301 sang domain mới, đường dẫn cũ 404 ở nhà mới → vẫn bám được", async () => {
  installFakeFetch({
    [A1]: { dead: true },
    [A2]: { dead: true },
    [OLD]: { redirect: NEW, keepPath: true },
    [NEW]: serves("moi", 5)
  }, CONFIG);

  const worker = await loadWorker();
  const { body } = await callHome(worker);
  assert.equal(body.matches.length, 5);
  const dbg = await callDebug(worker);
  assert.equal(dbg.current_domain, NEW);
});

// --- C. Không tin domain đã nhớ vô thời hạn ---

test("C1: domain cũ đóng băng (vẫn trả lưới trận cũ) → hết TTL phải chuyển sang domain mới", async () => {
  // Giai đoạn 1: mọi thứ bình thường, anchor trỏ về OLD.
  installFakeFetch({
    [A1]: { redirect: OLD },
    [A2]: { redirect: OLD },
    [OLD]: serves("cu", 3),
    [NEW]: serves("moi", 7)
  }, CONFIG);

  const worker = await loadWorker();
  let r = await callHome(worker);
  assert.ok(r.body.matches[0].home_team.startsWith("cu"));
  assert.equal((await callDebug(worker)).current_domain, OLD);

  // Giai đoạn 2: nguồn dời sang NEW. Anchor cập nhật, nhưng OLD KHÔNG chết —
  // nó vẫn phục vụ bản chụp cũ. Đây đúng là ca làm bản 1.2.0 bám chết.
  installFakeFetch({
    [A1]: { redirect: NEW },
    [A2]: { redirect: NEW },
    [OLD]: serves("cu", 3),
    [NEW]: serves("moi", 7)
  }, CONFIG);

  // Còn trong hạn xác minh → vẫn dùng OLD (đường nhanh, chấp nhận được).
  r = await callHome(worker);
  assert.ok(r.body.matches[0].home_team.startsWith("cu"), "trong TTL thì giữ đường nhanh");

  // Đẩy đồng hồ qua TTL bằng cách lùi mốc verified_at.
  const dbg = await callDebug(worker);
  assert.ok(dbg.verified_age_ms !== null, "phải có mốc xác minh qua anchor");
  await advanceBeyondTtl(worker);

  r = await callHome(worker);
  assert.equal(r.body.matches.length, 7);
  assert.ok(r.body.matches[0].home_team.startsWith("moi"), "hết TTL phải bám sang domain mới");
  assert.equal((await callDebug(worker)).current_domain, NEW);
});

test("C2: resolve bằng domain đã nhớ KHÔNG được tự gia hạn mốc xác minh", async () => {
  installFakeFetch({
    [A1]: { redirect: OLD },
    [A2]: { redirect: OLD },
    [OLD]: serves("cu", 3),
    [NEW]: serves("moi", 7)
  }, CONFIG);

  const worker = await loadWorker();
  await callHome(worker);
  const t1 = (await callDebug(worker)).verified_age_ms;

  // Vài lượt cào nữa, đều đi bằng đường "nhớ".
  await new Promise((r) => setTimeout(r, 25));
  await callHome(worker);
  await callHome(worker);
  const t2 = (await callDebug(worker)).verified_age_ms;

  assert.ok(t2 > t1, "mốc xác minh phải già đi, không được reset về 0 sau mỗi lượt cào");
});

// --- Các đường lui ---

test("D1: pin_domain=true ép ở lại domain trong config dù anchor trỏ nơi khác", async () => {
  installFakeFetch({
    [A1]: { redirect: NEW },
    [A2]: { redirect: NEW },
    [OLD]: serves("cu", 3),
    [NEW]: serves("moi", 7)
  }, { ...CONFIG, pin_domain: true });

  const worker = await loadWorker();
  const { body } = await callHome(worker);
  assert.equal(body.matches.length, 3);
  assert.ok(body.matches[0].home_team.startsWith("cu"), "pin phải thắng anchor");
});

test("D2: cả hai anchor chết → rơi về source_url trong config", async () => {
  installFakeFetch({
    [A1]: { dead: true },
    [A2]: { dead: true },
    [OLD]: serves("cu", 3)
  }, CONFIG);

  const worker = await loadWorker();
  const { body } = await callHome(worker);
  assert.equal(body.matches.length, 3);
});

test("D3: anchor trỏ vào trang park (200, không lưới) → không được nhận bừa", async () => {
  installFakeFetch({
    [A1]: { pages: { "*": { html: PARKED_HTML } } },
    [A2]: { dead: true },
    [OLD]: serves("cu", 6)
  }, CONFIG);

  const worker = await loadWorker();
  const { body } = await callHome(worker);
  assert.equal(body.matches.length, 6, "phải đi tiếp tới config chứ không dừng ở trang park");
  assert.equal((await callDebug(worker)).current_domain, OLD);
});

test("D4: GitHub trả 429 (không đọc được config) → vẫn chạy nhờ anchor", async () => {
  installFakeFetch({
    [A1]: { redirect: NEW },
    [A2]: { dead: true },
    [NEW]: serves("moi", 4),
    [OLD]: { dead: true }
  }, null);

  const worker = await loadWorker();
  const { body } = await callHome(worker);
  assert.equal(body.matches.length, 4);
});

test("D5: mọi thứ đều chết → báo lỗi, không ném exception", async () => {
  installFakeFetch({
    [A1]: { dead: true },
    [A2]: { dead: true },
    [OLD]: { dead: true }
  }, CONFIG);

  const worker = await loadWorker();
  const { status, body } = await callHome(worker);
  assert.equal(status, 500);
  assert.ok(body.error);
});

test("D6: khởi động nguội đi thẳng qua anchor và đóng dấu xác minh", async () => {
  installFakeFetch({
    [A1]: { redirect: NEW },
    [A2]: { redirect: NEW },
    [NEW]: serves("moi", 3),
    [OLD]: serves("cu", 3)
  }, CONFIG);

  const worker = await loadWorker();
  const before = await callDebug(worker);
  assert.equal(before.current_domain, null, "chưa cào thì chưa có domain");

  await callHome(worker);
  const after = await callDebug(worker);
  assert.equal(after.current_domain, NEW);
  assert.equal(after.resolved_from, "anchor");
  assert.ok(after.verified_age_ms !== null);
});

// Đẩy tiến trình qua hạn xác minh: gọi lặp cho tới khi verified_age_ms vượt TTL là
// không khả thi trong test, nên dùng đúng đòn bẩy sẵn có — ?probe=1 sau khi giả lập
// thời gian trôi bằng cách chỉnh Date.now.
async function advanceBeyondTtl(worker) {
  const dbg = await callDebug(worker);
  const jump = dbg.verify_ttl_ms + 60_000;
  const realNow = Date.now;
  Date.now = () => realNow.call(Date) + jump;
  try {
    // Một lượt cào trong "tương lai" để resolver thấy mốc xác minh đã hết hạn.
    await callHome(worker);
  } finally {
    Date.now = realNow;
  }
}
