# CHANGELOG XL-TV

> File này ghi lại toàn bộ thay đổi được thực hiện bởi **DeepSeek AI Agent** (DSH Harness) theo yêu cầu của chủ dự án **Quang Thoại**.

---

## [1.1.0] - 2025-07-16

### Added: Domain Discovery Module (`src/index.js`)

- **Mục tiêu:** Tự động dò tìm domain mới khi nguồn chính (xoilacz) đổi tên miền, giảm phụ thuộc vào việc cập nhật thủ công `config.json`.
- **Anchor domains:** `xoilacz.io`, `xoilacz.vip` — 2 domain cố định mà trang nguồn dùng để redirect người dùng đến domain mới.
- **Chiến lược 3 tầng (fallback):**
  1. **Layer 1 — HTTP redirect:manual:** Gửi request đến anchor domain với `redirect: "manual"`, đọc header `Location` (301/302). Nếu tìm thấy domain mới, gửi request verify đến `/truc-tiep/` để xác nhận còn sống.
  2. **Layer 2 — DNS CNAME lookup:** Gọi Cloudflare DNS-over-HTTPS (`cloudflare-dns.com/dns-query?type=CNAME`). Nếu anchor có CNAME trỏ sang domain khác, verify tương tự.
  3. **Layer 3 — IP comparison (log only):** So sánh A record của anchor domain với domain đang dùng; nếu trùng IP thì ghi log — không tự động chuyển.
- **Cache:** TTL 15 phút cho kết quả thành công, cooldown 5 phút khi thất bại (tránh spam DNS/HTTP).
- **Fallback:** Domain từ `config.json` → hardcoded default (`SOURCE_DEFAULT`).
- **Endpoint debug:** `GET /debug/discovery` — trả về trạng thái hiện tại của discovery cache, anchor domains, domain đang dùng.

### Changed: Router logic (`src/index.js`)

- `resolveBase(config)` → `resolveActiveDomain(config)` — thay vì chỉ đọc domain từ config, giờ ưu tiên domain discovery trước, fallback về config sau.

### Changed: Config cấu trúc (`config.json`)

- Thêm trường `"anchor_domains"` chứa danh sách 2 anchor domain.
- Cập nhật `"source_url"` và `"sources.xoilacz"` thành domain mới `xoilaczzrrz.tv/` (theo update trên remote).
- Cập nhật `"note"` để phản ánh cơ chế discovery mới.

---

## Previous (trước phiên làm việc này)

Xem lịch sử commit Git.