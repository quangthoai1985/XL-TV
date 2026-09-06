// Kiểm thử 2 endpoint phục vụ việc app Android tự cập nhật: /update và /apk.
//
// Ba điều phải giữ bằng mọi giá:
//   1. App CHỈ biết domain Worker. /update không được trả thẳng link GitHub, nếu không
//      sau này đổi chỗ host APK là phải build lại app đang nằm trên TV người dùng.
//   2. GitHub hỏng/429 KHÔNG được biến thành lỗi trên màn hình TV. Trả version_code 0
//      để app hiểu "không có bản mới" rồi im lặng.
//   3. /apk chỉ chuyển hướng tới https tuyệt đối. update.json là file trên mạng; nếu ai
//      đó sửa được nó thì cũng không được biến endpoint này thành bàn đạp redirect.

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

const APK = "https://github.com/quangthoai1985/XL-TV/releases/download/v1.4/xltv-1.4.apk";

const MANIFEST = {
  version_code: 5,
  version_name: "1.4",
  apk_url: APK,
  size_bytes: 11_100_000,
  mandatory: false,
  changelog: "Ban thu nghiem"
};

function setup(update) {
  return installFakeFetch({
    [A1]: { redirect: SRC },
    [SRC]: { pages: { "/": { html: sourceHtml(3) } } }
  }, CONFIG, update);
}

async function call(worker, path) {
  return await worker.fetch(new Request("https://worker.test" + path), {}, {});
}

test("/update trả phiên bản mới nhất, apk_url trỏ về chính Worker", async () => {
  setup(MANIFEST);
  const worker = await loadWorker();
  const d = await (await call(worker, "/update")).json();

  assert.equal(d.version_code, 5);
  assert.equal(d.version_name, "1.4");
  assert.equal(d.mandatory, false);
  assert.equal(d.size_bytes, 11_100_000);
  // Điểm mấu chốt: app không bao giờ nhìn thấy github.com
  assert.equal(d.apk_url, "https://worker.test/apk");
  assert.ok(!JSON.stringify(d).includes("github.com"), "không được lộ chỗ host thật");
});

test("/update không đụng tới trang nguồn — không tốn lượt cào", async () => {
  const log = setup(MANIFEST);
  const worker = await loadWorker();
  await call(worker, "/update");

  assert.ok(!log.some((u) => u.includes("newdom.example") || u.includes("xoilacz")),
    "chỉ được gọi update.json, không cào trang trận đấu: " + log.join(", "));
});

test("GitHub 429 → version_code 0, app im lặng chứ không báo lỗi", async () => {
  setup(null);
  const worker = await loadWorker();
  const res = await call(worker, "/update");
  const d = await res.json();

  assert.equal(res.status, 200, "vẫn phải là 200, đừng ném lỗi lên TV");
  assert.equal(d.version_code, 0);
  assert.equal(d.apk_url, "");
});

test("chưa có update.json trong repo → version_code 0", async () => {
  setup(undefined);
  const worker = await loadWorker();
  const d = await (await call(worker, "/update")).json();
  assert.equal(d.version_code, 0);
});

test("/apk chuyển hướng 302 tới đúng file trên GitHub Releases", async () => {
  setup(MANIFEST);
  const worker = await loadWorker();
  const res = await call(worker, "/apk");

  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), APK);
});

test("/apk từ chối apk_url không phải https — chặn bàn đạp redirect", async () => {
  setup({ ...MANIFEST, apk_url: "http://ai-do.example/malware.apk" });
  const worker = await loadWorker();
  const res = await call(worker, "/apk");
  assert.equal(res.status, 503);
});

test("/apk khi chưa khai báo apk_url → 503 chứ không phải redirect rỗng", async () => {
  setup({ version_code: 5, version_name: "1.4" });
  const worker = await loadWorker();
  const res = await call(worker, "/apk");
  assert.equal(res.status, 503);
});

test("version_code kiểu chuỗi trong update.json vẫn đọc được", async () => {
  setup({ ...MANIFEST, version_code: "7" });
  const worker = await loadWorker();
  const d = await (await call(worker, "/update")).json();
  assert.equal(d.version_code, 7);
});
