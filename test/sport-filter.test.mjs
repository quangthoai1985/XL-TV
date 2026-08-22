// Kiểm thử bộ lọc theo môn thi đấu.
//
// Bối cảnh: nguồn trộn chung bóng đá với esports, tennis, bóng rổ vào MỘT lưới. Ngày
// 22/08/2026 có 88 trận thì phần lớn không phải bóng đá, và vì danh sách live sắp theo
// giờ bóng lăn tăng dần, các trận esports/tennis khai cuộc từ chiều đứng trên cùng —
// trận Man United 18:30 và Việt Nam 20:00 bị đẩy xuống tận đáy. Người dùng mở app bóng
// đá ra chỉ thấy Dota 2 và tennis.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeFetch, loadWorker, sourceHtml } from "./fake-source.mjs";

const SRC = "https://newdom.example";
const A1 = "https://xoilacz.io";

const CONFIG = {
  sources: { xoilacz: SRC + "/" },
  source_url: SRC + "/",
  anchor_domains: ["xoilacz.io"],
  pin_domain: false
};

// 9 trận: xen kẽ bóng đá / esports / tennis → 3 mỗi môn.
const MIXED = ["football", "esports", "tennis"];

function setup(n = 9) {
  installFakeFetch({
    [A1]: { redirect: SRC },
    [SRC]: { pages: { "/": { html: sourceHtml(n, "", MIXED) } } }
  }, CONFIG);
}

async function call(worker, query) {
  const res = await worker.fetch(new Request("https://worker.test/" + query), {}, {});
  return await res.json();
}

test("parser đọc được data-sport của từng trận", async () => {
  setup();
  const worker = await loadWorker();
  const d = await call(worker, "");
  assert.equal(d.matches.length, 9);
  const co = d.matches.map((m) => m.sport);
  assert.deepEqual([...new Set(co)].sort(), ["esports", "football", "tennis"]);
});

test("?sport=football chỉ trả bóng đá", async () => {
  setup();
  const worker = await loadWorker();
  const d = await call(worker, "?sport=football");
  assert.equal(d.matches.length, 3);
  assert.ok(d.matches.every((m) => m.sport === "football"), "không được lẫn môn khác");
});

test("không truyền ?sport thì trả mọi môn — APK cũ không đổi hành vi", async () => {
  setup();
  const worker = await loadWorker();
  const d = await call(worker, "");
  assert.equal(d.matches.length, 9);
});

test("sports[] đếm đúng số trận từng môn, tính trên toàn danh sách trước khi lọc", async () => {
  setup();
  const worker = await loadWorker();
  // Ngay cả khi đã lọc bóng đá, phần đếm vẫn phải khai đủ mọi môn để giao diện
  // dựng được nút chọn môn mà không phải tải lại lần nữa.
  const d = await call(worker, "?sport=football");
  assert.deepEqual(d.sports, { football: 3, esports: 3, tennis: 3 });
  assert.equal(d.total_parsed, 9);
  assert.equal(d.total_all, 3, "total_all là số trận sau khi lọc môn");
});

test("?sport=football lọc TRƯỚC bộ lọc live, không cắt nhầm nhau", async () => {
  setup();
  const worker = await loadWorker();
  const d = await call(worker, "?sport=football&filter=live");
  assert.ok(d.matches.every((m) => m.sport === "football"));
  assert.equal(d.sports.football, 3, "phần đếm vẫn dựa trên danh sách gốc");
});

test("môn không tồn tại → danh sách rỗng, không phải lỗi", async () => {
  setup();
  const worker = await loadWorker();
  const d = await call(worker, "?sport=bongchuyen");
  assert.equal(d.matches.length, 0);
  assert.ok(!d.error);
  assert.equal(d.total_parsed, 9, "vẫn khai được là đã bóc 9 trận");
});

test("class nhiều tên (grid-match grid-match-football …) vẫn bóc được", async () => {
  // Trang thật viết class="grid-match grid-match-football grid-match--is-hot", nên
  // chuỗi 'class="grid-match"' không còn tồn tại — parser A đứng 0, B phải gánh hết.
  setup(6);
  const worker = await loadWorker();
  const d = await call(worker, "");
  assert.equal(d.matches.length, 6);
  assert.ok(d.matches[0].home_team, "phải bóc được tên đội");
  assert.ok(d.matches[0].detail_url.startsWith(SRC), "detail_url phải trỏ domain đang sống");
});
