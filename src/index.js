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
async function handleHome(sourceUrl, noCache) {
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

// ====== ROUTER ======
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    // Chọn nguồn qua ?src= (xoilac86 mặc định | xoilacz). Domain đọc từ config.json.
    const config = await getConfig();
    const srcKey = url.searchParams.get("src") === "xoilacz" ? "xoilacz" : "xoilac86";
    const baseUrl = resolveBase(config, srcKey);
    // App gửi kèm ?t=<timestamp> mỗi lần tải/Tải lại → luôn lấy dữ liệu mới
    const noCache = url.searchParams.has("t") || url.searchParams.has("refresh");

    try {
      if (url.pathname === "/detail") {
        const detailUrl = url.searchParams.get("url");
        if (!detailUrl) {
          return Response.json({ error: "Thiếu tham số ?url=" }, { status: 400, headers: corsHeaders() });
        }
        return await handleDetail(detailUrl, baseUrl);
      }

      if (url.pathname === "/stream") {
        const streamAjaxUrl = url.searchParams.get("url");
        if (!streamAjaxUrl) {
          return Response.json({ error: "Thiếu tham số ?url=" }, { status: 400, headers: corsHeaders() });
        }
        return await handleStream(streamAjaxUrl, baseUrl);
      }

      return await handleHome(baseUrl, noCache);
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }
};
