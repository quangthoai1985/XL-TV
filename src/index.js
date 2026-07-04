/**
 * Xoilac TV Scraper - Cloudflare Worker
 * 
 * 1. Đọc config.json từ GitHub
 * 2. Fetch trang chủ
 * 3. Bóc tách danh sách trận đấu và trả về dạng JSON chuẩn cho Android TV
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
      } catch (e) {
        console.error("Lỗi khi đọc config từ Github", e);
      }

      const pageRes = await fetch(sourceUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)"
        }
      });

      if (!pageRes.ok) {
        return Response.json({ error: "Không thể kết nối đến web nguồn", status: pageRes.status }, { status: 500 });
      }

      const htmlText = await pageRes.text();
      
      const apiMatch = htmlText.match(/var sport_data = (.*?);/);
      let apiData = null;
      if (apiMatch) {
         try {
           apiData = JSON.parse(apiMatch[1]);
         } catch(e) {}
      }

      return Response.json({
        source: sourceUrl,
        api_data_detected: apiData ? true : false,
        message: "Hệ thống backend đã hoạt động. Trả về dữ liệu mẫu.",
        matches: [
           {
             id: "1",
             home_team: "Việt Nam",
             away_team: "Thái Lan",
             time: "19:30",
             is_live: true,
             stream_url: "http://sample.vodobox.net/skate_phantom_flex_4k/skate_phantom_flex_4k.m3u8"
           }
        ]
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