// Dựng một "internet" giả để chạy resolver domain mà không cần mạng thật.
//
// Mỗi origin khai báo được một trong ba kiểu:
//   { redirect: "https://..." }        → 301 mọi đường dẫn về đó (giữ nguyên path hoặc không)
//   { pages: { "/": {...} } }          → phục vụ theo từng đường dẫn
//   { dead: true }                     → fetch ném lỗi (domain chết hẳn / timeout)

// Một khối trận theo template B của nguồn (grid-matches__item-match).
function matchBlock(i, home, away) {
  return `
<div class="grid-matches__item grid-matches__item-match" data-status="1" data-runtime="${1755800000 + i * 3600}">
  <div class="grid-match__league"><img src="/l.png"><span class="text-ellipsis">Giải Test</span></div>
  <div class="grid-match__date"><span>20:00 22/08</span></div>
  <a href="/truc-tiep/tran-${i}/">
    <div class="grid-match__team--home-name">${home}</div>
    <img src="/h${i}.png" class="team-logo-0">
    <div class="grid-match__team--away-name">${away}</div>
    <img src="/a${i}.png" class="team-logo-0">
  </a>
</div>`;
}

// Trang danh sách trận thật sự (có lưới). label để phân biệt nội dung cũ / mới.
export function sourceHtml(n = 3, label = "") {
  const blocks = [];
  for (let i = 1; i <= n; i++) blocks.push(matchBlock(i, `${label}Home${i}`, `${label}Away${i}`));
  return `<!doctype html><html><body><div class="grid-matches">${blocks.join("")}</div></body></html>`;
}

// Trang park / trang lỗi: trả 200 nhưng không có lưới trận nào.
export const PARKED_HTML = `<!doctype html><html><body><h1>Domain for sale</h1></body></html>`;

export const NOT_FOUND_HTML = `<!doctype html><html><body><h1>404 Not Found</h1></body></html>`;

// Cài fetch giả lên globalThis. Trả về sổ ghi các request đã đi.
//
// web: { "https://origin": spec }
// config: object trả về cho DEFAULT_CONFIG_URL (null = GitHub lỗi)
export function installFakeFetch(web, config) {
  const log = [];

  function resolveOne(target, hop) {
    if (hop > 5) return { status: 508, html: "loop", url: target };
    const u = new URL(target);
    const spec = web[u.origin];
    if (!spec) return { status: 0, err: `no route to ${u.origin}` };
    if (spec.dead) return { status: 0, err: `connect fail ${u.origin}` };

    if (spec.redirect) {
      // keepPath: true = redirect giữ nguyên đường dẫn (thường gặp khi site dời nhà
      // nguyên trạng). Mặc định false = mọi đường dẫn đổ về trang gốc.
      const next = spec.keepPath
        ? spec.redirect.replace(/\/$/, "") + u.pathname
        : spec.redirect;
      return resolveOne(next, hop + 1);
    }

    const page = (spec.pages && (spec.pages[u.pathname] || spec.pages["*"])) || null;
    if (!page) return { status: 404, html: NOT_FOUND_HTML, url: u.href };
    return { status: page.status ?? 200, html: page.html, url: u.href };
  }

  globalThis.fetch = async (input, init) => {
    const target = typeof input === "string" ? input : input.url;
    log.push(target);

    // config.json trên GitHub
    if (target.includes("raw.githubusercontent.com")) {
      if (!config) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify(config), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const out = resolveOne(target, 0);
    if (out.status === 0) throw new Error(out.err);

    const res = new Response(out.html, { status: out.status });
    // Response tự tạo có url = "". Ghi đè để mô phỏng đúng hành vi redirect:"follow"
    // của runtime — chính chỗ này là cơ chế tự bám domain của Worker.
    Object.defineProperty(res, "url", { value: out.url, configurable: true });
    return res;
  };

  return log;
}

// Nạp một bản index.js hoàn toàn mới (state module reset sạch) cho mỗi kịch bản.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let seq = 0;

export async function loadWorker() {
  const src = readFileSync(join(HERE, "..", "src", "index.js"), "utf8");
  const dir = join(HERE, ".tmp");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `worker-${++seq}.mjs`);
  writeFileSync(file, src);
  return (await import(`file://${file}`)).default;
}
