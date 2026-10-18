// Canh domain nguồn từ BÊN NGOÀI Cloudflare, chạy định kỳ bằng GitHub Actions.
//
// Vì sao không để Worker tự làm: từ 10/2026 xoilacz.io và xoilacz.vip trả 403 cho mọi
// request xuất phát từ Cloudflare Workers (kể cả /robots.txt), trong khi request thường
// nhận 301 sang domain đang sống. Dấu hiệu chặn nằm ở hạ tầng, không ở header, nên Worker
// không giả được. Runner GitHub thì đứng ngoài Cloudflare: đọc Location của anchor, kiểm
// tra trang đích có lưới trận, rồi ghi config.json. Worker đọc config.json (cache 60s)
// nên không phải deploy lại.
//
// Chạy tay:   node scripts/watch-domain.mjs [--dry-run]
// Mã thoát:   0 = ổn (đổi hoặc không đổi), 1 = không tìm được domain nào sống.

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SOURCE_PATHS = ["/", "/truc-tiep/"];
const TIMEOUT_MS = 15000;
const MAX_HOPS = 6;

// Giữ đúng tiêu chí của looksLikeSource trong src/index.js: chỉ "200" thì chưa chứng
// minh được gì, trang park hay trang lỗi cũng trả 200.
function looksLikeSource(html) {
  return html.includes("grid-matches__item-match") || html.includes('class="grid-match"');
}

function normOrigin(u) {
  if (!u) return null;
  try { return new URL(String(u).includes("://") ? u : "https://" + u).origin; }
  catch (e) { return null; }
}

const hostOf = (u) => { const o = normOrigin(u); return o ? new URL(o).host : null; };

// Tự đi từng bước redirect thay vì để fetch đi hộ: cần biết anchor trỏ đi đâu và bị
// chặn ở bước nào, đó chính là thứ log trên runner phải cho thấy.
async function follow(url, fetchImpl) {
  const hops = [];
  let cur = url;
  for (let i = 0; i < MAX_HOPS; i++) {
    let res;
    try {
      res = await fetchImpl(cur, {
        redirect: "manual",
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (e) {
      hops.push({ url: cur, loi: e.message || String(e) });
      return { hops, final: null, html: "" };
    }
    const loc = res.headers.get("location");
    hops.push({ url: cur, status: res.status, location: loc || undefined });
    if (res.status >= 300 && res.status < 400 && loc) {
      cur = new URL(loc, cur).href;
      continue;
    }
    let html = "";
    if (res.status === 200) { try { html = await res.text(); } catch (e) {} }
    return { hops, final: normOrigin(cur), html };
  }
  return { hops, final: null, html: "" };
}

// Một ứng viên: thử lần lượt các đường dẫn, dừng ở cái đầu tiên ra lưới trận.
async function probe(origin, fetchImpl) {
  const tries = [];
  for (const path of SOURCE_PATHS) {
    const r = await follow(origin + path, fetchImpl);
    tries.push(r.hops);
    if (r.final && looksLikeSource(r.html)) {
      return { origin, alive: true, final: r.final, redirected: r.final !== origin, tries };
    }
  }
  return { origin, alive: false, final: null, redirected: false, tries };
}

// Quyết định domain đúng từ kết quả dò. Thứ tự tin cậy:
//   1. anchor CHUYỂN HƯỚNG sang domain có lưới trận: biển chỉ đường chính chủ, thắng cả
//      domain hiện tại còn sống (ca domain cũ đóng băng vẫn trả lưới trận cũ).
//   2. domain hiện tại còn sống: giữ nguyên.
//   3. một anchor tự phục vụ lưới trận.
export async function watchDomain(config, { fetchImpl = fetch } = {}) {
  const current = normOrigin((config.sources && config.sources.xoilacz) || config.source_url);
  const anchors = [];
  for (const a of config.anchor_domains || []) {
    const n = normOrigin(a);
    if (n && !anchors.includes(n)) anchors.push(n);
  }

  const results = [];
  for (const a of anchors) results.push(await probe(a, fetchImpl));
  let currentResult = results.find((r) => r.origin === current);
  if (current && !currentResult) {
    currentResult = await probe(current, fetchImpl);
    results.push(currentResult);
  }

  const signposts = results.filter((r) => r.alive && r.redirected);
  let target = null, reason = null;
  if (signposts.length) {
    target = signposts[0].final;
    reason = `anchor ${hostOf(signposts[0].origin)} chuyển hướng tới`;
  } else if (currentResult && currentResult.alive) {
    target = current;
    reason = "domain hiện tại còn lưới trận, không anchor nào chỉ đi nơi khác";
  } else {
    const direct = results.find((r) => r.alive);
    if (direct) { target = direct.final; reason = `anchor ${hostOf(direct.origin)} tự phục vụ`; }
  }

  const disagree = [...new Set(signposts.map((r) => r.final))].length > 1;

  if (!target) return { status: "dead", current, target: null, reason: "không ứng viên nào ra lưới trận", results, disagree };
  if (target === current) return { status: "unchanged", current, target, reason, results, disagree };

  // Domain cũ bị thay thì bỏ khỏi anchor, trừ khi chính nó là biển chỉ đường (đã redirect).
  const keepOld = results.some((r) => r.origin === current && r.redirected);
  const oldHost = keepOld ? null : hostOf(current);
  const targetHost = hostOf(target);
  const next = JSON.parse(JSON.stringify(config));
  next.sources = { ...(config.sources || {}), xoilacz: target + "/" };
  next.source_url = target + "/";
  next.anchor_domains = [targetHost, ...(config.anchor_domains || []).filter((a) => {
    const h = hostOf(a);
    return h && h !== targetHost && h !== oldHost;
  })];
  return { status: "changed", current, target, reason, results, disagree, next };
}

function report(out) {
  const lines = [];
  lines.push(`Domain hiện tại: ${out.current || "(không có)"}`);
  for (const r of out.results) {
    lines.push(`- ${r.origin}: ${r.alive ? `SỐNG → ${r.final}${r.redirected ? " (redirect)" : ""}` : "chết"}`);
    for (const hops of r.tries) {
      lines.push("    " + hops.map((h) => h.loi ? `${h.url} [lỗi: ${h.loi}]` : `${h.url} [${h.status}]`).join(" → "));
    }
  }
  if (out.disagree) lines.push("CẢNH BÁO: các anchor chỉ về những domain khác nhau, đã lấy anchor đứng trước.");
  lines.push(`Kết luận: ${out.status}${out.target ? " → " + out.target : ""} (${out.reason})`);
  return lines.join("\n");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const file = join(root, "config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));

  const out = await watchDomain(config);
  const text = report(out);
  console.log(text);

  if (out.status === "changed" && !dryRun) {
    writeFileSync(file, JSON.stringify(out.next, null, 2) + "\n");
    console.log(`Đã ghi config.json: ${out.current} → ${out.target}`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `changed=${out.status === "changed" && !dryRun}\nold=${out.current || ""}\nnew=${out.target || ""}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Domain nguồn${dryRun ? " (dry-run)" : ""}\n\n\`\`\`\n${text}\n\`\`\`\n`);
  }
  process.exit(out.status === "dead" ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
