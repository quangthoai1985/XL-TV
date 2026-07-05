/**
 * XL-TV Scraper — Cloudflare Worker
 * 
 * Endpoints:
 *   GET /             → Danh sách trận đấu (scrape từ trang chủ)
 *   GET /detail?url=X → Chi tiết trận: BLV, link stream (scrape trang chi tiết)
 *   GET /stream?url=X → Proxy fetch iframe stream → trả về URL stream thật
 */

const DEFAULT_CONFIG_URL = "https://raw.githubusercontent.com/quangthoai1985/XL-TV/main/config.json";
const FALLBACK_DOMAIN = "https://inyoureyesmovie.com";

async function getSourceUrl() {
  try {
    // Cache-bust để luôn lấy config.json MỚI NHẤT trên GitHub.
    // (query "?_=" phá cache Fastly của GitHub, cf.cacheTtl=0 phá cache Cloudflare)
    const res = await fetch(DEFAULT_CONFIG_URL + "?_=" + Date.now(), {
      cf: { cacheTtl: 0, cacheEverything: false },
      headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" }
    });
    if (res.ok) {
      const config = await res.json();
      if (config.source_url) return config.source_url;
    }
  } catch (e) {}
  return FALLBACK_DOMAIN;
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

// ====== ENDPOINT 1: Danh sách trận ======
async function handleHome(sourceUrl, noCache) {
  const targetUrl = sourceUrl.replace(/\/$/, "") + "/truc-tiep/";
  const fetchOpts = { headers: { "User-Agent": UA } };
  // Khi app bấm "Tải lại", ép cào trực tiếp trang nguồn, bỏ qua cache Cloudflare
  if (noCache) fetchOpts.cf = { cacheTtl: 0, cacheEverything: false };
  const pageRes = await fetch(targetUrl, fetchOpts);
  if (!pageRes.ok) {
    return Response.json({ error: "Không kết nối được web nguồn" }, { status: 500, headers: corsHeaders() });
  }
  const html = await pageRes.text();

  const matches = [];
  const addedUrls = new Set();
  let id = 1;

  function addMatch(detailUrl, timeText, home, away, isLive, homeLogo, awayLogo, homeScore, awayScore) {
    if (!detailUrl) return;
    if (detailUrl.startsWith("/")) {
      detailUrl = sourceUrl.replace(/\/$/, "") + detailUrl;
    }
    if (addedUrls.has(detailUrl)) return;
    addedUrls.add(detailUrl);
    
    matches.push({
      id: (id++).toString(),
      time: timeText,
      home_team: home,
      away_team: away,
      home_logo: homeLogo,
      away_logo: awayLogo,
      home_score: homeScore,
      away_score: awayScore,
      is_live: isLive,
      detail_url: detailUrl,
      stream_url: ""
    });
  }

  // Phân tích grid-match (danh sách chính trong grid-matches)
  const gridBlocks = html.split('class="grid-match"');
  for (let i = 1; i < gridBlocks.length; i++) {
    const block = gridBlocks[i];
    
    let url = null;
    const urlMatches = [...gridBlocks[i-1].matchAll(/href="([^"]+)"/g)];
    if (urlMatches.length > 0) {
      url = urlMatches[urlMatches.length - 1][1];
    }

    const timeMatch = block.match(/<div class="grid-match__date[^>]*>\s*<span>([^<]+)<\/span>/);
    const teamMatches = [...block.matchAll(/<p>([^<]+)<\/p>/g)];
    
    const logoMatches = [...block.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*class=["'][^"']*team-logo-0[^"']*["'][^>]*>/g)];
    const homeLogo = logoMatches.length > 0 ? logoMatches[0][1] : "";
    const awayLogo = logoMatches.length > 1 ? logoMatches[1][1] : "";

    let homeScore = "";
    let awayScore = "";
    const homeScoreMatch = block.match(/<div[^>]*class=["'][^"']*gmd_home-score[^"']*["'][^>]*>[\s\S]*?<p>([^<]+)<\/p>/);
    const awayScoreMatch = block.match(/<div[^>]*class=["'][^"']*gmd_away-score[^"']*["'][^>]*>[\s\S]*?<p>([^<]+)<\/p>/);
    if (homeScoreMatch && awayScoreMatch) {
      homeScore = homeScoreMatch[1].trim();
      awayScore = awayScoreMatch[1].trim();
    }

    if (url && teamMatches.length >= 2) {
      let time = timeMatch ? timeMatch[1].trim() : "";
      
      const elapsedMatch = block.match(/<p[^>]*id="elapsedTime"[^>]*>([^<]+)<\/p>/);
      if (elapsedMatch && elapsedMatch[1].trim() !== "") {
        time = elapsedMatch[1].trim();
      }

      const isLive = /trực tiếp|hiệp|live|đang|phút/i.test(time) || block.includes('grid-match__status--live') || block.includes('live-gif');
      addMatch(url, time, teamMatches[0][1].trim(), teamMatches[1][1].trim(), isLive, homeLogo, awayLogo, homeScore, awayScore);
    }
  }

  return Response.json({ source: sourceUrl, total: matches.length, matches }, { headers: corsHeaders() });
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
  }, { headers: corsHeaders() });
}

// ====== ROUTER ======
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const sourceUrl = await getSourceUrl();
    // App gửi kèm ?t=<timestamp> mỗi lần tải/Tải lại → luôn lấy dữ liệu mới
    const noCache = url.searchParams.has("t") || url.searchParams.has("refresh");

    try {
      if (url.pathname === "/detail") {
        const detailUrl = url.searchParams.get("url");
        if (!detailUrl) {
          return Response.json({ error: "Thiếu tham số ?url=" }, { status: 400, headers: corsHeaders() });
        }
        return await handleDetail(detailUrl, sourceUrl);
      }

      if (url.pathname === "/stream") {
        const streamAjaxUrl = url.searchParams.get("url");
        if (!streamAjaxUrl) {
          return Response.json({ error: "Thiếu tham số ?url=" }, { status: 400, headers: corsHeaders() });
        }
        return await handleStream(streamAjaxUrl, sourceUrl);
      }

      return await handleHome(sourceUrl, noCache);
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }
};
