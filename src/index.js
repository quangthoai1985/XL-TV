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
    const res = await fetch(DEFAULT_CONFIG_URL);
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
    "Content-Type": "application/json; charset=utf-8"
  };
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ====== ENDPOINT 1: Danh sách trận ======
async function handleHome(sourceUrl) {
  const pageRes = await fetch(sourceUrl, { headers: { "User-Agent": UA } });
  if (!pageRes.ok) {
    return Response.json({ error: "Không kết nối được web nguồn" }, { status: 500, headers: corsHeaders() });
  }
  const html = await pageRes.text();

  const matches = [];
  const addedUrls = new Set();
  let id = 1;

  function addMatch(detailUrl, timeText, home, away, isLive) {
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
      is_live: isLive,
      detail_url: detailUrl,
      stream_url: ""
    });
  }

  // 1. Phân tích match-horizontals-item (carousel)
  const blocks = html.split('class="match-horizontals-item"');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const urlMatch = block.match(/href="([^"]+)"/);
    const timeMatch = block.match(/<div class="h-time">([^<]+)<\/div>/);
    const teamMatches = [...block.matchAll(/<div class="h-team-name">([^<]+)<\/div>/g)];
    
    if (urlMatch && timeMatch && teamMatches.length >= 2) {
      const time = timeMatch[1].trim();
      const isLive = /tr\u1ef1c ti\u1ebfp|hi\u1ec7p|live|\u0111ang/i.test(time);
      addMatch(urlMatch[1], time, teamMatches[0][1].trim(), teamMatches[1][1].trim(), isLive);
    }
  }

  // 2. Phân tích grid-match (danh sách chính)
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
    
    if (url && teamMatches.length >= 2) {
      let time = timeMatch ? timeMatch[1].trim() : "";
      
      const elapsedMatch = block.match(/<p[^>]*id="elapsedTime"[^>]*>([^<]+)<\/p>/);
      if (elapsedMatch && elapsedMatch[1].trim() !== "") {
        time = elapsedMatch[1].trim();
      } else {
        const dataTimeMatch = block.match(/data-time="([^"]+)"/);
        if (dataTimeMatch && dataTimeMatch[1].trim() !== "") {
          time = dataTimeMatch[1].trim();
        }
      }

      const isLive = /tr\u1ef1c ti\u1ebfp|hi\u1ec7p|live|\u0111ang|ph\u00fat/i.test(time) || block.includes('grid-match__status--live') || block.includes('live-gif');
      addMatch(url, time, teamMatches[0][1].trim(), teamMatches[1][1].trim(), isLive);
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
    return Response.json({ error: `L\u1ed7i khi fetch stream: HTTP ${res.status}` }, { status: 500, headers: corsHeaders() });
  }

  const html = await res.text();

  // ===== \u01afu ti\u00ean 1: L\u1ea5y urlStream (link stream th\u1eadt, th\u01b0\u1eddng l\u00e0 .flv ho\u1eb7c .m3u8) =====
  let streamUrl = null;
  let streamType = null;

  const urlStreamMatch = html.match(/var\s+urlStream\s*=\s*["']([^"']+)["']/);
  if (urlStreamMatch) {
    streamUrl = urlStreamMatch[1];
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

  // ===== \u01afu ti\u00ean 2: N\u1ebfu kh\u00f4ng c\u00f3 urlStream, t\u00ecm m3u8 KH\u00d4NG N\u1eb0M trong adsTvc =====
  if (!streamUrl) {
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

    const allM3u8 = [];
    const m3u8Re = /https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/g;
    let m;
    while ((m = m3u8Re.exec(html)) !== null) {
      allM3u8.push(m[0]);
    }

    const realM3u8 = allM3u8.filter(url => !adUrls.has(url));
    if (realM3u8.length > 0) {
      streamUrl = realM3u8[0];
      streamType = "hls";
    } else if (allM3u8.length > 0) {
      streamUrl = allM3u8[allM3u8.length - 1];
      streamType = "hls";
    }
  }

  // ===== \u01afu ti\u00ean 3: T\u00ecm trong src= attributes =====
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

    try {
      if (url.pathname === "/detail") {
        const detailUrl = url.searchParams.get("url");
        if (!detailUrl) {
          return Response.json({ error: "Thi\u1ebfu tham s\u1ed1 ?url=" }, { status: 400, headers: corsHeaders() });
        }
        return await handleDetail(detailUrl, sourceUrl);
      }

      if (url.pathname === "/stream") {
        const streamAjaxUrl = url.searchParams.get("url");
        if (!streamAjaxUrl) {
          return Response.json({ error: "Thi\u1ebfu tham s\u1ed1 ?url=" }, { status: 400, headers: corsHeaders() });
        }
        return await handleStream(streamAjaxUrl, sourceUrl);
      }

      return await handleHome(sourceUrl);
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
    }
  }
};
