/**
 * Xoilac TV Scraper - Cloudflare Worker
 */

const DEFAULT_CONFIG_URL = "https://raw.githubusercontent.com/quangthoai1985/XL-TV/main/config.json";
const FALLBACK_DOMAIN = "https://inyoureyesmovie.com";

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      let sourceUrl = FALLBACK_DOMAIN;
      try {
        const configRes = await fetch(DEFAULT_CONFIG_URL);
        if (configRes.ok) {
          const config = await configRes.json();
          if (config.source_url) {
            sourceUrl = config.source_url;
          }
        }
      } catch (e) {}

      const pageRes = await fetch(sourceUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      });

      if (!pageRes.ok) {
        return Response.json({ error: "Không kết nối được web", status: pageRes.status }, { status: 500 });
      }

      const htmlText = await pageRes.text();
      
      const matches = [];
      const re = /<div class="h-time">([^<]+)<\/div>.*?<div class="h-team-name">([^<]+)<\/div>.*?<div class="h-team-name">([^<]+)<\/div>/gs;
      let m;
      let idCounter = 1;
      while ((m = re.exec(htmlText)) !== null) {
          matches.push({
             id: idCounter.toString(),
             time: m[1].trim(),
             home_team: m[2].trim(),
             away_team: m[3].trim(),
             is_live: m[1].toLowerCase().includes("trực tiếp") || m[1].toLowerCase().includes("hiệp") || m[1].toLowerCase().includes("live"),
             stream_url: "http://sample.vodobox.net/skate_phantom_flex_4k/skate_phantom_flex_4k.m3u8" // Mock video link
          });
          idCounter++;
      }

      return Response.json({
        source: sourceUrl,
        api_data_detected: true,
        message: "Dữ liệu thông tin trận ĐÃ ĐƯỢC CÀO THỰC TẾ từ trang chủ. (Link video vẫn là mẫu do Xoilac ẩn stream dưới iframe)",
        matches: matches
      }, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json"
        }
      });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  },
};
