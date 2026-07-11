/**
 * XL-TV Scraper — Cloudflare Worker
 *
 * Hỗ trợ 2 nguồn (chọn qua ?src=):
 *   - xoilac86 (mặc định) → inyoureyesmovie.com   (template A: class="grid-match", tên đội <p>)
 *   - xoilacz             → xoilaczwwz.tv          (template B: grid-match__body, tên đội <div>)
 *
 * Endpoints:
 *   GET /?src=X             → Danh sách trận đấu
 *   GET /detail?url=X&src=Y → Chi tiết trận: BLV + link stream
 *   GET /stream?url=X&src=Y → Lấy URL stream thật
 */

const DEFAULT_CONFIG_URL = "https://raw.githubusercontent.com/quangthoai1985/XL-TV/main/config.json";

// Domain mặc định cho mỗi nguồn (dùng khi config.json không có).
const SOURCE_DEFAULTS = {
  xoilac86: "https://inyoureyesmovie.com",
  xoilacz: "https://xoilaczwwz.tv"
};

// Đọc config.json trên GitHub (luôn lấy bản mới nhất, bỏ qua cache).
async function getConfig() {
  try {
    const res = await fetch(DEFAULT_CONFIG_URL + "?_=" + Date.now(), {
      cf: { cacheTtl: 0, cacheEverything: false },
      headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" }
    });
    if (res.ok) return await res.json();
  } catch (e) {}
  return null;
}

// Chọn domain nguồn theo srcKey. Cho phép sửa domain động qua config.json.
function resolveBase(config, srcKey) {
  const key = srcKey === "xoilacz" ? "xoilacz" : "xoilac86";
  if (config) {
    if (config.sources && config.sources[key]) return config.sources[key];
    // Tương thích ngược: config cũ chỉ có source_url → dùng cho xoilac86
    if (key === "xoilac86" && config.source_url) return config.source_url;
  }
  return SOURCE_DEFAULTS[key];
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json; charset=utf-8",
    // Không cho app/CDN cache lại kết quả của Worker
    "Cache-Control": "no-store, no-cache, must-revalidate"
  };
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Giải mã các HTML entity phổ biến trong tên đội/giải
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&#0?34;|&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// Thêm domain nếu là đường dẫn tương đối
function absUrl(base, u) {
  if (u && u.startsWith("/")) return base.replace(/\/$/, "") + u;
  return u;
}

function makeMatch(id, time, home, away, isLive, homeLogo, awayLogo, league, leagueLogo, detailUrl) {
  return {
    id: id.toString(),
    time,
    home_team: home,
    away_team: away,
    home_logo: homeLogo,
    away_logo: awayLogo,
    home_score: "",
    away_score: "",
    is_live: isLive,
    league: league || "",
    league_logo: leagueLogo || "",
    detail_url: detailUrl,
    stream_url: ""
  };
}

// ====== ENDPOINT 1: Danh sách trận ======
// enc=true (bản web): mã hoá detail_url + ẩn source để domain nguồn không xuất hiện
// trong JSON -> tránh phần mềm diệt virus (ESET) quét body và chặn/treo request fetch.
// App Android gọi không có enc -> nhận detail_url dạng thường như cũ.
async function handleHome(sourceUrl, noCache, enc) {
  const targetUrl = sourceUrl.replace(/\/$/, "") + "/truc-tiep/";
  const fetchOpts = { headers: { "User-Agent": UA }, redirect: "follow" };
  // Khi app bấm "Tải lại", ép cào trực tiếp trang nguồn, bỏ qua cache Cloudflare
  if (noCache) fetchOpts.cf = { cacheTtl: 0, cacheEverything: false };
  const pageRes = await fetch(targetUrl, fetchOpts);
  if (!pageRes.ok) {
    return Response.json({ error: "Không kết nối được web nguồn" }, { status: 500, headers: corsHeaders() });
  }
  const html = await pageRes.text();

  // Chạy cả 2 parser rồi lấy cái ra nhiều trận hơn.
  // (Hai template loại trừ lẫn nhau nên cái sai sẽ ra 0 → cách này chắc chắn hơn
  //  việc dò chuỗi, tránh nhầm khi trang có class template ẩn.)
  const a = parseListA(html, sourceUrl);
  const b = parseListB(html, sourceUrl);
  const matches = b.length > a.length ? b : a;

  if (enc) {
    // Giấu domain nguồn: detail_url -> base64url. Web sẽ gửi lại thẳng qua ?u64=.
    for (const m of matches) m.detail_url = b64urlEncode(m.detail_url);
    return Response.json({ source: "", total: matches.length, matches }, { headers: corsHeaders() });
  }
  return Response.json({ source: sourceUrl, total: matches.length, matches }, { headers: corsHeaders() });
}

// --- Template A: inyoureyesmovie.com (class="grid-match", tên đội trong <p>) ---
function parseListA(html, sourceUrl) {
  const matches = [];
  const added = new Set();
  let id = 1;
  const gridBlocks = html.split('class="grid-match"');
  for (let i = 1; i < gridBlocks.length; i++) {
    const block = gridBlocks[i];

    let url = null;
    const urlMatches = [...gridBlocks[i - 1].matchAll(/href="([^"]+)"/g)];
    if (urlMatches.length > 0) url = urlMatches[urlMatches.length - 1][1];

    const teamMatches = [...block.matchAll(/<p>([^<]+)<\/p>/g)];
    if (!url || teamMatches.length < 2) continue;

    const logoMatches = [...block.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*class=["'][^"']*team-logo-0[^"']*["'][^>]*>/g)];
    const homeLogo = logoMatches[0] ? logoMatches[0][1] : "";
    const awayLogo = logoMatches[1] ? logoMatches[1][1] : "";

    let league = "", leagueLogo = "";
    const leagueBlock = block.match(/gmd-match-league([\s\S]*?)<\/div>/);
    if (leagueBlock) {
      const seg = leagueBlock[1];
      const compImg = seg.match(/<img[^>]*gmd-comp_logo[^>]*>/);
      if (compImg) { const s = compImg[0].match(/src=["']([^"']+)["']/); if (s) leagueLogo = s[1]; }
      const nameM = seg.match(/text-ellipsis[^>]*>([^<]+)</) || seg.match(/data-attr="[^"]*"[^>]*>([^<]+)</);
      if (nameM) league = decodeEntities(nameM[1]);
    }

    const timeMatch = block.match(/<div class="grid-match__date[^>]*>\s*<span>([^<]+)<\/span>/);
    let time = timeMatch ? timeMatch[1].trim() : "";
    const elapsedMatch = block.match(/<p[^>]*id="elapsedTime"[^>]*>([^<]+)<\/p>/);
    if (elapsedMatch && elapsedMatch[1].trim() !== "") time = elapsedMatch[1].trim();

    const isLive = /trực tiếp|hiệp|live|đang|phút/i.test(time) || block.includes('grid-match__status--live') || block.includes('live-gif');

    const detailUrl = absUrl(sourceUrl, url);
    if (added.has(detailUrl)) continue;
    added.add(detailUrl);
    matches.push(makeMatch(id++, time, decodeEntities(teamMatches[0][1]), decodeEntities(teamMatches[1][1]), isLive, homeLogo, awayLogo, league, leagueLogo, detailUrl));
  }
  return matches;
}

// --- Template B: xoilaczwwz.tv (grid-match__body, tên đội trong <div class="grid-match__team--name">) ---
function parseListB(html, sourceUrl) {
  const matches = [];
  const added = new Set();
  let id = 1;
  const parts = html.split("grid-match__header");
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];

    // Link chi tiết: <a href="/truc-tiep/<slug>/"> nằm ở CUỐI phần trước (ngay trước card).
    // Loại các href .../link/N (là link BLV, không phải trang chi tiết).
    let url = null;
    const hrefs = [...parts[i - 1].matchAll(/href="([^"]*\/truc-tiep\/[^"]*)"/g)]
      .map(m => m[1])
      .filter(h => !/\/link\//.test(h));
    if (hrefs.length > 0) url = hrefs[hrefs.length - 1];

    const homeM = block.match(/grid-match__team--home-name[^>]*>([^<]+)</);
    const awayM = block.match(/grid-match__team--away-name[^>]*>([^<]+)</);
    if (!url || !homeM || !awayM) continue;

    const logoMatches = [...block.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*class=["'][^"']*team-logo-0[^"']*["'][^>]*>/g)];
    const homeLogo = logoMatches[0] ? logoMatches[0][1] : "";
    const awayLogo = logoMatches[1] ? logoMatches[1][1] : "";

    let league = "", leagueLogo = "";
    const leagueBlock = block.match(/grid-match__league([\s\S]*?)<\/div>/);
    if (leagueBlock) {
      const seg = leagueBlock[1];
      const img = seg.match(/<img[^>]*src=["']([^"']+)["']/);
      if (img) leagueLogo = img[1];
      const nameM = seg.match(/text-ellipsis[^>]*>\s*([^<]+?)\s*</) || seg.match(/data-attr="[^"]*"[^>]*>\s*([^<]+?)\s*</);
      if (nameM) league = decodeEntities(nameM[1]);
    }

    const timeM = block.match(/grid-match__date[^>]*>\s*([^<]+?)\s*</);
    const time = timeM ? decodeEntities(timeM[1]) : "";

    const isLive = block.includes('grid-match__status--live') || block.includes('grid-match--is-live') || block.includes('is-living');

    const detailUrl = absUrl(sourceUrl, url);
    if (added.has(detailUrl)) continue;
    added.add(detailUrl);
    matches.push(makeMatch(id++, time, decodeEntities(homeM[1]), decodeEntities(awayM[1]), isLive, homeLogo, awayLogo, league, leagueLogo, detailUrl));
  }
  return matches;
}

// ====== ENDPOINT 2: Chi tiết trận (BLV + link stream) ======
async function handleDetail(detailPageUrl, sourceUrl) {
  const pageRes = await fetch(detailPageUrl, {
    headers: { "User-Agent": UA, "Referer": sourceUrl + "/" }
  });
  if (!pageRes.ok) {
    return Response.json({ error: "Không tải được trang chi tiết" }, { status: 500, headers: corsHeaders() });
  }
  const html = await pageRes.text();

  const titleMatch = html.match(/<h1>([\s\S]*?)<\/h1>/);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";

  const leagueMatch = html.match(/<div class="title_box">[\s\S]*?<span>(.*?)<\/span>/);
  const league = leagueMatch ? leagueMatch[1].trim() : "";

  let listStream = [];
  const streamMatch = html.match(/var list_stream = ([\s\S]*?);/);
  if (streamMatch) {
    try { listStream = JSON.parse(streamMatch[1]); } catch (e) {}
  }

  const blvList = [];
  const blvRe = /<a[^>]*class="[^"]*player-link[^"]*"[^>]*data-link="(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  let blvMatch;
  while ((blvMatch = blvRe.exec(html)) !== null) {
    const linkIndex = parseInt(blvMatch[1]);
    const name = blvMatch[2].replace(/<[^>]+>/g, "").trim();
    const streamUrls = listStream[linkIndex] || [];
    blvList.push({
      index: linkIndex,
      name: name,
      stream_ajax_urls: streamUrls
    });
  }

  return Response.json({
    title,
    league,
    blv_list: blvList,
    total_links: listStream.length
  }, { headers: corsHeaders() });
}

// ====== ENDPOINT 3: Lấy stream thật từ ajax URL ======
async function handleStream(ajaxUrl, sourceUrl) {
  const res = await fetch(ajaxUrl, {
    headers: {
      "User-Agent": UA,
      "Referer": sourceUrl + "/",
      "Origin": sourceUrl
    },
    redirect: "follow"
  });

  if (!res.ok) {
    return Response.json({ error: `Lỗi khi fetch stream: HTTP ${res.status}` }, { status: 500, headers: corsHeaders() });
  }

  const html = await res.text();

  // ===== Ưu tiên 1: Lấy urlStream (link stream thật, thường là .flv hoặc .m3u8) =====
  let streamUrl = null;
  let streamType = null; // "flv" hoặc "hls"

  const urlStreamMatch = html.match(/var\s+urlStream\s*=\s*["']([^"']+)["']/);
  if (urlStreamMatch) {
    streamUrl = urlStreamMatch[1];
    // Kiểm tra loại stream
    const isFlvMatch = html.match(/var\s+isFlv\s*=\s*(true|false)/);
    if (isFlvMatch && isFlvMatch[1] === "true") {
      streamType = "flv";
    } else if (streamUrl.includes(".m3u8")) {
      streamType = "hls";
    } else if (streamUrl.includes(".flv")) {
      streamType = "flv";
    } else {
      streamType = "unknown";
    }
  }

  // ===== Ưu tiên 2: Nếu không có urlStream, tìm m3u8 KHÔNG NẰM trong adsTvc =====
  if (!streamUrl) {
    // Lấy danh sách URL quảng cáo để loại trừ
    const adUrls = new Set();
    const adsTvcMatch = html.match(/var\s+adsTvc\s*=\s*(\[[\s\S]*?\]);/);
    if (adsTvcMatch) {
      try {
        const ads = JSON.parse(adsTvcMatch[1]);
        ads.forEach(ad => {
          if (ad.file) adUrls.add(ad.file);
        });
      } catch (e) {}
    }

    // Tìm tất cả m3u8
    const allM3u8 = [];
    const m3u8Re = /https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/g;
    let m;
    while ((m = m3u8Re.exec(html)) !== null) {
      allM3u8.push(m[0]);
    }

    // Lọc bỏ quảng cáo
    const realM3u8 = allM3u8.filter(url => !adUrls.has(url));
    if (realM3u8.length > 0) {
      streamUrl = realM3u8[0];
      streamType = "hls";
    } else if (allM3u8.length > 0) {
      // Fallback: dùng m3u8 cuối cùng (thường quảng cáo nằm đầu)
      streamUrl = allM3u8[allM3u8.length - 1];
      streamType = "hls";
    }
  }

  // ===== Ưu tiên 3: Tìm trong src= attributes =====
  if (!streamUrl) {
    const srcMatch = html.match(/(?:source|file)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i);
    if (srcMatch) {
      streamUrl = srcMatch[1];
      streamType = srcMatch[1].includes(".m3u8") ? "hls" : "unknown";
    }
  }

  return Response.json({
    ajax_url: ajaxUrl,
    stream_url: streamUrl,
    stream_type: streamType,
    // Referer/Origin để app gắn header khi phát (CDN thường chặn nếu thiếu)
    referer: sourceUrl.replace(/\/$/, "") + "/",
    origin: sourceUrl.replace(/\/$/, ""),
  }, { headers: corsHeaders() });
}

// ====== PROXY STREAM (cho bản web trên trình duyệt) ======
// Trình duyệt không cho JS đặt Referer/Origin/User-Agent, và bị chặn CORS.
// Worker đứng ra tải stream: gắn hộ 3 header đó + thêm CORS + rewrite playlist m3u8.
// Referer/Origin lấy động từ query (?ref=&org=) do endpoint /stream trả về theo nguồn.

const STREAM_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function proxyCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "*"
  };
}

// base64url <-> chuỗi. Dùng để "giấu" domain nguồn khỏi query string, tránh bị
// phần mềm diệt virus / bộ lọc web (ESET, ad-block, DNS filter) chặn vì thấy
// domain streaming trong URL. App Android vẫn dùng ?url= dạng thường (không đụng).
function b64urlEncode(s) {
  const b = btoa(unescape(encodeURIComponent(s)));
  return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(v) {
  if (!v) return "";
  let s = v.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  try { return decodeURIComponent(escape(atob(s))); } catch (e) {
    try { return atob(s); } catch (e2) { return ""; }
  }
}

async function handleProxy(request, url, ctx) {
  // Nhận cả dạng thường (?u=) lẫn base64url (?u64=) để tương thích.
  const target = url.searchParams.get("u") || b64urlDecode(url.searchParams.get("u64"));
  if (!target) return new Response("thiếu ?u=", { status: 400, headers: proxyCorsHeaders() });

  let t;
  try { t = new URL(target); } catch (e) {
    return new Response("URL không hợp lệ", { status: 400, headers: proxyCorsHeaders() });
  }
  if (t.protocol !== "http:" && t.protocol !== "https:") {
    return new Response("chỉ hỗ trợ http/https", { status: 400, headers: proxyCorsHeaders() });
  }

  const ref = url.searchParams.get("ref") || b64urlDecode(url.searchParams.get("ref64")) || "";
  const org = url.searchParams.get("org") || b64urlDecode(url.searchParams.get("org64")) || "";

  const pathAndQuery = t.pathname + t.search;
  const isPlaylist = /\.m3u8(\?|$)/i.test(pathAndQuery);
  const isSegment = /\.(ts|m4s|aac|mp4|m4a|mpd|key|vtt)(\?|$)/i.test(pathAndQuery);
  const isImage = /\.(png|jpe?g|webp|gif|svg|ico)(\?|$)/i.test(pathAndQuery);

  // Header gắn hộ để CDN chấp nhận request (giống ExoPlayer bên Android).
  const reqHeaders = { "User-Agent": STREAM_UA };
  if (ref) reqHeaders["Referer"] = ref;
  if (org) reqHeaders["Origin"] = org;
  const range = request.headers.get("Range");
  if (range) reqHeaders["Range"] = range;

  // Cache segment/ảnh ở edge: nhiều người xem cùng 1 trận chỉ fetch origin 1 lần.
  const cache = caches.default;
  let cacheKey = null;
  if ((isSegment || isImage) && !range) {
    cacheKey = new Request(request.url, { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const originResp = await fetch(t.toString(), { headers: reqHeaders, redirect: "follow" });
  if (!originResp.ok && originResp.status !== 206) {
    return new Response("upstream " + originResp.status, { status: 502, headers: proxyCorsHeaders() });
  }

  const ct = originResp.headers.get("Content-Type") || "";
  const looksPlaylist = isPlaylist || /mpegurl|vnd\.apple/i.test(ct);

  // --- Playlist: viết lại mọi URL con (segment/key/sub-playlist) đi qua /proxy ---
  if (looksPlaylist) {
    const body = await originResp.text();
    const rewritten = rewritePlaylist(body, t, url.origin, ref, org);
    return new Response(rewritten, {
      headers: {
        ...proxyCorsHeaders(),
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store"
      }
    });
  }

  // --- Segment / key / FLV / MP4: passthrough stream (không buffer vào RAM) ---
  const respHeaders = {
    ...proxyCorsHeaders(),
    "Content-Type": ct || "application/octet-stream",
    "Cache-Control": isImage ? "public, max-age=86400" : (isSegment ? "public, max-age=8" : "no-store")
  };
  const cl = originResp.headers.get("Content-Length"); if (cl) respHeaders["Content-Length"] = cl;
  const ar = originResp.headers.get("Accept-Ranges"); if (ar) respHeaders["Accept-Ranges"] = ar;
  const cr = originResp.headers.get("Content-Range"); if (cr) respHeaders["Content-Range"] = cr;

  const resp = new Response(originResp.body, { status: originResp.status, headers: respHeaders });

  if ((isSegment || isImage) && !range && originResp.status === 200 && cacheKey) {
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  }
  return resp;
}

// Viết lại playlist HLS: đổi mọi URI segment/key/sub-playlist -> /proxy?u=<abs>&ref=&org=
function rewritePlaylist(text, baseUrl, workerOrigin, ref, org) {
  const toProxy = (u) => {
    let abs;
    try { abs = new URL(u, baseUrl).toString(); } catch (e) { return u; }
    // Mã hoá base64url để bộ lọc web (ESET…) không thấy domain nguồn trong URL.
    let s = workerOrigin + "/proxy?u64=" + b64urlEncode(abs);
    if (ref) s += "&ref64=" + b64urlEncode(ref);
    if (org) s += "&org64=" + b64urlEncode(org);
    return s;
  };
  return text.split("\n").map((line) => {
    const s = line.trim();
    if (s === "") return line;
    if (s.charAt(0) === "#") {
      // #EXT-X-KEY (khóa AES) và #EXT-X-MAP (init fmp4) chứa URI="..."
      if ((s.startsWith("#EXT-X-KEY") || s.startsWith("#EXT-X-MAP")) && s.indexOf("URI=") !== -1) {
        return line.replace(/URI="([^"]+)"/, (_, u) => 'URI="' + toProxy(u) + '"');
      }
      return line;
    }
    return toProxy(s); // dòng URI segment / sub-playlist
  }).join("\n");
}

// ====== ROUTER ======
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: proxyCorsHeaders() });
    }

    const url = new URL(request.url);

    // Trình duyệt tự xin favicon → trả 204, tránh rơi vào scrape (đỡ 1 subrequest thừa).
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    // --- Trang web (bản trình duyệt PC), không cần config → trả HTML luôn ---
    if (url.pathname === "/web" || url.pathname === "/web/") {
      return new Response(WEB_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
      });
    }

    // --- Proxy stream cho trình duyệt (gắn Referer/Origin/UA + CORS + rewrite m3u8) ---
    // Đặt TRƯỚC getConfig() để mỗi segment không phải fetch config.json (tiết kiệm subrequest).
    if (url.pathname === "/proxy") {
      try {
        return await handleProxy(request, url, ctx);
      } catch (err) {
        return new Response("proxy error: " + err.message, { status: 502, headers: proxyCorsHeaders() });
      }
    }

    // Chọn nguồn qua ?src= (xoilac86 mặc định | xoilacz). Domain đọc từ config.json.
    const config = await getConfig();
    const srcKey = url.searchParams.get("src") === "xoilacz" ? "xoilacz" : "xoilac86";
    const baseUrl = resolveBase(config, srcKey);
    // App gửi kèm ?t=<timestamp> mỗi lần tải/Tải lại → luôn lấy dữ liệu mới
    const noCache = url.searchParams.has("t") || url.searchParams.has("refresh");

    try {
      if (url.pathname === "/detail") {
        // ?url= (app Android) hoặc ?u64= base64url (web, để né bộ lọc ESET…)
        const detailUrl = url.searchParams.get("url") || b64urlDecode(url.searchParams.get("u64"));
        if (!detailUrl) {
          return Response.json({ error: "Thiếu tham số ?url=" }, { status: 400, headers: corsHeaders() });
        }
        return await handleDetail(detailUrl, baseUrl);
      }

      if (url.pathname === "/stream") {
        const streamAjaxUrl = url.searchParams.get("url") || b64urlDecode(url.searchParams.get("u64"));
        if (!streamAjaxUrl) {
          return Response.json({ error: "Thiếu tham số ?url=" }, { status: 400, headers: corsHeaders() });
        }
        return await handleStream(streamAjaxUrl, baseUrl);
      }

      return await handleHome(baseUrl, noCache, url.searchParams.get("enc") === "1");
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }
};


// ====== TRANG WEB (bản trình duyệt PC) ======
// Giao diện bám theo app Android: nền tối, accent xanh #00E676, lưới thẻ trận,
// bấm trận -> modal Play ở giữa: danh sách BLV + player (hls.js/flv.js) + fullscreen.
// Mọi stream phát qua /proxy để gắn Referer/Origin + CORS.
const WEB_HTML = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>XL TV — Trực tiếp bóng đá</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/flv.js@1.6.2/dist/flv.min.js"></script>
<style>
  :root{
    --accent:#00E676; --gold:#DAA520; --live:#E53935;
    --top:#0B0E13; --bottom:#05060A; --card1:#232733; --card2:#14161C;
    --card1live:#17361F; --card2live:#12140F; --dim:#8A93A6; --panel:#161A22;
  }
  *{box-sizing:border-box}
  body{
    margin:0; font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
    color:#fff; min-height:100vh;
    background:linear-gradient(180deg,var(--top),var(--bottom)); background-attachment:fixed;
  }
  header{
    display:flex; align-items:center; gap:12px;
    padding:16px 28px; position:sticky; top:0; z-index:5;
    background:rgba(9,11,16,.86); backdrop-filter:blur(8px);
    border-bottom:1px solid rgba(0,230,118,.18);
  }
  .logo{font-size:26px; font-weight:900; color:var(--accent); white-space:nowrap}
  .srcbtn,.reload{
    border:1px solid rgba(255,255,255,.2); background:var(--panel); color:#B9C2D0;
    border-radius:20px; padding:8px 16px; font-size:14px; cursor:pointer;
    font-weight:600; transition:.15s;
  }
  .srcbtn:hover,.reload:hover{border-color:var(--accent); transform:translateY(-1px)}
  .srcbtn.active{background:var(--accent); color:#000; border-color:var(--accent)}
  .count{margin-left:auto; background:var(--panel); color:#B9C2D0;
    border-radius:20px; padding:6px 14px; font-size:14px; font-weight:600}
  .reload{color:var(--accent); border-color:var(--accent)}
  .reload:disabled{opacity:.6; cursor:default}

  .grid{
    display:grid; gap:16px; padding:22px 28px 40px;
    grid-template-columns:repeat(auto-fill,minmax(240px,1fr));
  }
  .card{
    height:196px; border-radius:16px; overflow:hidden; cursor:pointer;
    background:linear-gradient(180deg,var(--card1),var(--card2));
    border:1px solid rgba(255,255,255,.13); display:flex; flex-direction:column;
    transition:.15s;
  }
  .card:hover{transform:translateY(-3px) scale(1.02); border-color:var(--accent);
    box-shadow:0 10px 30px rgba(0,0,0,.45)}
  .card.live{background:linear-gradient(180deg,var(--card1live),var(--card2live))}
  .chead{display:flex; align-items:center; gap:8px; padding:8px 12px;
    background:rgba(0,0,0,.2)}
  .chead img{width:18px; height:18px; object-fit:contain}
  .league{flex:1; font-size:11px; font-weight:600; color:#B9C2D0;
    text-transform:uppercase; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
  .badge-live{background:var(--live); color:#fff; font-size:9px; font-weight:800;
    padding:2px 7px; border-radius:4px; white-space:nowrap}
  .teams{flex:1; display:flex; align-items:center; padding:0 10px; gap:6px}
  .team{flex:1; display:flex; flex-direction:column; align-items:center; gap:8px; min-width:0}
  .tlogo{width:54px; height:54px; border-radius:50%; background:#fff;
    display:flex; align-items:center; justify-content:center; overflow:hidden}
  .tlogo img{width:100%; height:100%; object-fit:contain; padding:7px}
  .tlogo span{color:#1B5E20; font-size:22px; font-weight:900}
  .tname{font-size:14px; font-weight:600; text-align:center; line-height:1.15;
    max-height:2.4em; overflow:hidden}
  .vs{background:#0A0A0A; border:1px solid var(--gold); border-radius:10px;
    padding:6px 12px; font-weight:900; font-size:16px; white-space:nowrap}
  .ctime{text-align:center; color:var(--dim); font-size:12px; font-weight:500;
    padding:0 12px 10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
  .msg{padding:60px 20px; text-align:center; color:#B9C2D0; font-size:17px}
  .msg.err{color:#FF5252}

  /* Modal Play */
  .overlay{position:fixed; inset:0; z-index:20; display:none;
    background:rgba(0,0,0,.82); backdrop-filter:blur(3px);
    align-items:center; justify-content:center; padding:20px}
  .overlay.show{display:flex}
  .modal{width:100%; max-width:1000px; max-height:94vh; overflow:auto;
    background:#0D0D0D; border:1px solid rgba(255,255,255,.12); border-radius:16px;
    box-shadow:0 20px 60px rgba(0,0,0,.6)}
  .mhead{display:flex; align-items:center; gap:12px; padding:16px 20px;
    border-bottom:1px solid rgba(255,255,255,.08)}
  .mtitle{flex:1; font-size:20px; font-weight:800; min-width:0}
  .msub{color:#888; font-size:14px; font-weight:500}
  .xclose{border:none; background:#222; color:#fff; width:36px; height:36px;
    border-radius:50%; font-size:18px; cursor:pointer}
  .xclose:hover{background:var(--live)}
  .playerwrap{position:relative; background:#000}
  video{width:100%; aspect-ratio:16/9; max-height:60vh; object-fit:contain; display:block; background:#000}
  .pmsg{position:absolute; inset:0; display:none; align-items:center; justify-content:center;
    flex-direction:column; gap:8px; color:#fff; text-align:center; pointer-events:none;
    background:rgba(0,0,0,.5); font-size:16px}
  .pmsg.show{display:flex}
  .pbar{display:flex; align-items:center; gap:10px; padding:10px 16px; flex-wrap:wrap}
  .pinfo{color:var(--accent); font-size:14px; font-weight:600; flex:1; min-width:120px}
  .fsbtn{border:1px solid var(--accent); background:transparent; color:var(--accent);
    padding:8px 14px; border-radius:8px; font-size:14px; font-weight:700; cursor:pointer}
  .fsbtn:hover{background:var(--accent); color:#000}
  .blvhead{padding:6px 20px 4px; color:var(--accent); font-size:16px; font-weight:600}
  .blvlist{display:flex; flex-direction:column; gap:8px; padding:8px 20px 22px}
  .blv{display:flex; align-items:center; gap:14px; padding:12px 18px; border-radius:10px;
    background:#1E1E1E; border:1px solid transparent; cursor:pointer; transition:.12s}
  .blv:hover{background:#243024}
  .blv.hd{background:#1A237E}
  .blv.active{border-color:var(--accent); background:#1B5E20}
  .blv .ic{font-size:22px}
  .blv .nm{flex:1; min-width:0}
  .blv .nm b{font-size:16px}
  .blv .nm small{display:block; color:#8a93a6; font-size:12px}
  .qbadge{background:#424242; color:#fff; font-size:12px; font-weight:800;
    padding:3px 8px; border-radius:4px}
  .qbadge.hd{background:#2962FF}
</style>
</head>
<body>
<header>
  <div class="logo">⚽ XL TV</div>
  <button class="srcbtn active" id="s86">Xoilac86</button>
  <button class="srcbtn" id="sz">XoilacZ</button>
  <div class="count" id="count">0 trận</div>
  <button class="reload" id="reload">🔄 Tải lại</button>
</header>

<div id="grid" class="grid"></div>
<div id="status" class="msg">Đang tải danh sách trận...</div>

<div class="overlay" id="overlay">
  <div class="modal">
    <div class="mhead">
      <div class="mtitle" id="mtitle">—</div>
      <button class="xclose" id="xclose">✕</button>
    </div>
    <div class="playerwrap" id="playerwrap">
      <video id="player" controls playsinline></video>
      <div class="pmsg" id="pmsg"></div>
    </div>
    <div class="pbar">
      <div class="pinfo" id="pinfo">Chọn bình luận viên bên dưới để xem</div>
      <button class="fsbtn" id="fsbtn">⛶ Toàn màn hình</button>
    </div>
    <div class="blvhead" id="blvhead">🎙️ Bình luận viên</div>
    <div class="blvlist" id="blvlist"></div>
  </div>
</div>

<script>
var API = location.origin;
var src = 'xoilac86';
var hls = null, flv = null;

// Mã hoá base64url để domain nguồn không lộ trong URL -> né bộ lọc web (ESET, ad-block…)
function b64(s){ return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''); }
// Bọc URL ảnh (logo) qua /proxy để ESET không chặn khi tải trực tiếp từ domain nguồn.
function imgProxy(u){ return u ? (API + '/proxy?u64=' + b64(u)) : u; }

var grid = document.getElementById('grid');
var statusEl = document.getElementById('status');
var countEl = document.getElementById('count');
var overlay = document.getElementById('overlay');
var video = document.getElementById('player');
var pmsg = document.getElementById('pmsg');
var pinfo = document.getElementById('pinfo');

function setStatus(t, isErr){
  statusEl.textContent = t || '';
  statusEl.style.display = t ? 'block' : 'none';
  statusEl.className = 'msg' + (isErr ? ' err' : '');
}
function el(tag, cls){ var e = document.createElement(tag); if(cls) e.className = cls; return e; }

// ------- Danh sách trận -------
function loadMatches(){
  setStatus('Đang tải danh sách trận...', false);
  grid.innerHTML = '';
  var reloadBtn = document.getElementById('reload');
  reloadBtn.disabled = true; reloadBtn.textContent = '⏳ Đang tải...';
  fetch(API + '/?src=' + src + '&enc=1&t=' + Date.now())
    .then(function(r){ return r.json(); })
    .then(function(data){
      var list = (data && data.matches) || [];
      countEl.textContent = list.length + ' trận';
      renderMatches(list);
      if(list.length) setStatus('', false);
      else if(data && data.error) setStatus('Lỗi nguồn: ' + data.error, true);
      else setStatus('Không có trận nào.', false);
    })
    .catch(function(e){ setStatus('Lỗi kết nối: ' + e.message, true); })
    .finally(function(){ reloadBtn.disabled = false; reloadBtn.textContent = '🔄 Tải lại'; });
}

function renderMatches(list){
  grid.innerHTML = '';
  list.forEach(function(m){
    var card = el('div', 'card' + (m.is_live ? ' live' : ''));

    var head = el('div', 'chead');
    if(m.league_logo){ var li = el('img'); li.src = imgProxy(m.league_logo); li.onerror = function(){ li.style.display='none'; }; head.appendChild(li); }
    var lg = el('div', 'league'); lg.textContent = (m.league || '').toUpperCase(); head.appendChild(lg);
    if(m.is_live){ var bl = el('div', 'badge-live'); bl.textContent = '● LIVE'; head.appendChild(bl); }
    card.appendChild(head);

    var teams = el('div', 'teams');
    teams.appendChild(teamCol(m.home_team, m.home_logo));
    var hasScore = m.home_score && m.away_score;
    var vs = el('div', 'vs');
    vs.textContent = hasScore ? (m.home_score + ' : ' + m.away_score) : 'VS';
    vs.style.color = hasScore ? 'var(--accent)' : '#fff';
    teams.appendChild(vs);
    teams.appendChild(teamCol(m.away_team, m.away_logo));
    card.appendChild(teams);

    if(m.time){ var tm = el('div', 'ctime'); tm.textContent = '🕐 ' + m.time; card.appendChild(tm); }

    card.onclick = function(){ openMatch(m); };
    grid.appendChild(card);
  });
}

function teamCol(name, logo){
  var col = el('div', 'team');
  var lo = el('div', 'tlogo');
  if(logo){
    var img = el('img'); img.src = imgProxy(logo); img.alt = name || '';
    img.onerror = function(){ lo.innerHTML = ''; var sp = el('span'); sp.textContent = (name||'?').charAt(0).toUpperCase(); lo.appendChild(sp); };
    lo.appendChild(img);
  } else {
    var sp = el('span'); sp.textContent = (name||'?').charAt(0).toUpperCase(); lo.appendChild(sp);
  }
  col.appendChild(lo);
  var nm = el('div', 'tname'); nm.textContent = name || ''; col.appendChild(nm);
  return col;
}

// ------- Modal + chi tiết -------
function openMatch(m){
  document.getElementById('mtitle').textContent = (m.home_team || '') + ' vs ' + (m.away_team || '');
  document.getElementById('blvlist').innerHTML = '';
  document.getElementById('blvhead').textContent = '🎙️ Đang tải danh sách BLV...';
  pinfo.textContent = 'Chọn bình luận viên bên dưới để xem';
  overlay.classList.add('show');
  showPmsg('');
  fetch(API + '/detail?u64=' + m.detail_url + '&src=' + src) // detail_url đã là base64url từ server
    .then(function(r){ return r.json(); })
    .then(function(d){ renderBlv((d && d.blv_list) || []); })
    .catch(function(e){ document.getElementById('blvhead').textContent = '⚠️ Lỗi tải BLV: ' + e.message; });
}

function renderBlv(blvs){
  var head = document.getElementById('blvhead');
  var listEl = document.getElementById('blvlist');
  listEl.innerHTML = '';
  head.textContent = '🎙️ Chọn bình luận viên (' + blvs.length + ' kênh):';
  blvs.forEach(function(blv){
    var isHD = (blv.name || '').toUpperCase().indexOf('HD') !== -1;
    var row = el('div', 'blv' + (isHD ? ' hd' : ''));
    var ic = el('div', 'ic'); ic.textContent = isHD ? '📺' : '🎙️'; row.appendChild(ic);
    var nm = el('div', 'nm');
    var b = el('b'); b.textContent = blv.name || 'BLV';
    var s = el('small'); s.textContent = (blv.stream_ajax_urls ? blv.stream_ajax_urls.length : 0) + ' link khả dụng';
    nm.appendChild(b); nm.appendChild(s); row.appendChild(nm);
    var q = el('div', 'qbadge' + (isHD ? ' hd' : '')); q.textContent = isHD ? 'HD' : 'SD'; row.appendChild(q);
    row.onclick = function(){
      var prev = listEl.querySelector('.blv.active'); if(prev) prev.classList.remove('active');
      row.classList.add('active');
      pinfo.textContent = '🎙️ ' + (blv.name || 'BLV');
      tryLink(blv.stream_ajax_urls || [], 0);
    };
    listEl.appendChild(row);
  });
}

// ------- Lấy link stream + phát -------
function tryLink(urls, i){
  if(i >= urls.length){ showPmsg('❌ Không phát được (đã thử hết link)'); return; }
  showPmsg('⏳ Đang kết nối link ' + (i+1) + '/' + urls.length + '...');
  fetch(API + '/stream?u64=' + b64(urls[i]) + '&src=' + src)
    .then(function(r){ return r.json(); })
    .then(function(s){
      if(s && s.stream_url){ playStream(s, function(){ tryLink(urls, i+1); }); }
      else { tryLink(urls, i+1); }
    })
    .catch(function(){ tryLink(urls, i+1); });
}

function inferType(url, type){
  if(type === 'hls' || type === 'flv') return type;
  if(/\\.m3u8/i.test(url)) return 'hls';
  if(/\\.flv/i.test(url)) return 'flv';
  return 'hls';
}

function destroyPlayers(){
  if(hls){ try{ hls.destroy(); }catch(e){} hls = null; }
  if(flv){ try{ flv.pause(); flv.unload(); flv.detachMediaElement(); flv.destroy(); }catch(e){} flv = null; }
  try{ video.pause(); video.removeAttribute('src'); video.load(); }catch(e){}
}

function playStream(s, onFail){
  destroyPlayers();
  var type = inferType(s.stream_url, s.stream_type);
  var proxied = API + '/proxy?u64=' + b64(s.stream_url);
  if(s.referer) proxied += '&ref64=' + b64(s.referer);
  if(s.origin) proxied += '&org64=' + b64(s.origin);

  var failed = false;
  function fail(){ if(!failed){ failed = true; if(onFail) onFail(); } }

  if(type === 'flv' && window.flvjs && flvjs.isSupported()){
    flv = flvjs.createPlayer({ type: 'flv', url: proxied, isLive: true }, { enableStashBuffer: false, stashInitialSize: 128 });
    flv.attachMediaElement(video);
    flv.on(flvjs.Events.ERROR, function(){ fail(); });
    flv.load();
    video.play().catch(function(){});
  } else {
    if(video.canPlayType('application/vnd.apple.mpegurl')){
      video.src = proxied;
      video.addEventListener('error', fail, { once: true });
      video.play().catch(function(){});
    } else if(window.Hls && Hls.isSupported()){
      hls = new Hls({ lowLatencyMode: true, enableWorker: true });
      hls.loadSource(proxied);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function(){ video.play().catch(function(){}); });
      hls.on(Hls.Events.ERROR, function(evt, data){ if(data && data.fatal) fail(); });
    } else {
      showPmsg('Trình duyệt không hỗ trợ phát loại stream này');
      return;
    }
  }
}

function showPmsg(t){
  if(!t){ pmsg.classList.remove('show'); pmsg.textContent=''; return; }
  pmsg.textContent = t; pmsg.classList.add('show');
}
video.addEventListener('playing', function(){ showPmsg(''); });

// ------- Điều khiển UI -------
document.getElementById('xclose').onclick = closeModal;
overlay.onclick = function(e){ if(e.target === overlay) closeModal(); };
function closeModal(){ overlay.classList.remove('show'); destroyPlayers(); showPmsg(''); }

document.getElementById('fsbtn').onclick = function(){
  var wrap = document.getElementById('playerwrap');
  if(document.fullscreenElement){ document.exitFullscreen(); }
  else if(wrap.requestFullscreen){ wrap.requestFullscreen(); }
  else if(video.webkitEnterFullscreen){ video.webkitEnterFullscreen(); }
};

document.getElementById('s86').onclick = function(){ if(src!=='xoilac86'){ src='xoilac86'; setSrcUI(); loadMatches(); } };
document.getElementById('sz').onclick = function(){ if(src!=='xoilacz'){ src='xoilacz'; setSrcUI(); loadMatches(); } };
function setSrcUI(){
  document.getElementById('s86').classList.toggle('active', src==='xoilac86');
  document.getElementById('sz').classList.toggle('active', src==='xoilacz');
}
document.getElementById('reload').onclick = loadMatches;
document.addEventListener('keydown', function(e){ if(e.key==='Escape' && overlay.classList.contains('show') && !document.fullscreenElement) closeModal(); });

loadMatches();
</script>
</body>
</html>`;
