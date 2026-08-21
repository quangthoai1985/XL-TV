# CHANGELOG XL-TV

> Nhật ký thay đổi của dự án, theo yêu cầu của chủ dự án **Quang Thoại**.

---

## [1.2.0] - 2026-08-21

Viết lại cơ chế bám domain nguồn. Mục tiêu: **không bao giờ phải sửa URL nguồn bằng tay nữa.**

### Dữ kiện đo được (cơ sở của toàn bộ thiết kế)

Kiểm tra thực tế ngày 21/08/2026:

| Kiểm tra | Kết quả |
|---|---|
| `xoilacz.io/` | 301 → `https://nmsba.com/` |
| `xoilacz.vip/` | 301 → `https://nmsba.com/` |
| `xoilaczzrrz.tv/` (domain trong config cũ) | 301 → `https://nmsba.com/` |
| `nmsba.com/` | 200, chứa 79 khối trận (`grid-matches__item-match`) |
| `nmsba.com/truc-tiep/` | 301 → `/` (đường dẫn này không còn tồn tại) |
| A record của cả 3 domain | IP anycast dùng chung của Cloudflare |
| CNAME của cả 3 domain | không có (đều là apex domain) |

Hai kết luận: **domain cũ không bị xoá mà được giữ lại làm biển chỉ đường**, và **DNS/IP hoàn toàn vô dụng** cho việc dò tên miền ở đây.

### Changed: cơ chế bám domain (`src/index.js`)

- **Không còn bước "dò" riêng.** Trang danh sách vẫn được tải như cũ với `redirect: "follow"`, nhưng giờ đọc thêm `response.url` để biết request thực sự đáp xuống đâu — đó chính là domain đang sống. Khi nguồn đổi tên miền, hệ thống tự bám theo ở ngay lần tải kế tiếp, **không tốn thêm một request nào**.
- **Thứ tự ứng viên:** domain đang nhớ → anchor (`xoilacz.io`, `xoilacz.vip`) → `config.json` → hardcode. Dừng ở ứng viên đầu tiên trả về đúng trang có lưới trận.
- **Xác minh bằng nội dung, không bằng mã 200.** Kiểm tra HTML có chứa `grid-matches__item-match` hoặc `class="grid-match"`. Cần thiết vì `nmsba.com/truc-tiep/` chuyển hướng về `/` rồi trả 200 — riêng mã 200 không chứng minh được gì, trang park cũng trả 200.
- **`anchor_domains` trong `config.json` giờ có tác dụng thật** (trước đây bị bỏ qua hoàn toàn, chỉ là trường trang trí).
- **Thêm `pin_domain`**: đặt `true` để ép dùng đúng `source_url`, không tự chuyển đi đâu — phanh tay khi cần can thiệp khẩn cấp.
- `SOURCE_DEFAULT` → `https://nmsba.com`.

### Removed: hai tầng DNS của bản 1.1.0

Gỡ bỏ tra cứu CNAME và so sánh IP qua DNS-over-HTTPS. Cả hai đã được kiểm chứng là **không bao giờ chạy được**: các domain đều là apex nên không có CNAME, và IP đều là anycast dùng chung của Cloudflare nên không suy ngược ra tên miền. Riêng tầng so sánh IP còn tiêu 2 subrequest mỗi lần chỉ để ghi log.

### Fixed: độ trễ và chi phí

- Bản 1.1.0 chạy discovery **đồng bộ trên đường đi của mọi request**, kể cả `/detail` và `/stream`. Trên một tiến trình mới, trường hợp xấu nhất là ~86 giây timeout dồn và ~12 subrequest trước khi bỏ cuộc — đủ để app báo lỗi mạng. Nay việc resolve gắn liền với thao tác cào vốn đã phải làm, nên chi phí bằng **không**.
- `/detail` không còn cần biết domain nguồn: `Referer` suy từ chính link chi tiết (cùng origin, giống hệt trình duyệt bấm từ trang danh sách sang). Tiết kiệm một lần đọc `config.json` mỗi request và không còn phụ thuộc domain đang lưu có mới hay không.
- Bản 1.1.0 để discovery **đè lên `config.json`**, khiến việc sửa tay mất tác dụng — mất đường thoát khẩn cấp. Nay `config.json` là fallback thật, và `pin_domain` cho quyền phủ quyết tuyệt đối.

### Changed: `/debug/discovery`

Báo cáo domain đang dùng, nguồn resolve, danh sách anchor, nội dung `config.json`. Thêm `?probe=1` để ép dò lại ngay và trả về kết quả (origin, có lưới trận hay không, kích thước HTML).

### Changed: `config.json`

`source_url` và `sources.xoilacz` → `https://nmsba.com/` (giá trị cũ `xoilaczzrrz.tv` đã chết, chỉ còn là redirect). Thêm `pin_domain: false`.

### Kiểm thử

27 test giả lập mạng chạy trên HTML thật của nguồn (1.39 MB, 87 trận): khởi động nguội, tái sử dụng domain đã nhớ, nguồn đổi domain giữa chừng, cả 2 anchor chết, anchor trỏ vào trang park, `pin_domain`, `/detail`, và trường hợp mọi thứ đều chết. **27/27 PASS.**

### Tương thích

Không đổi đường dẫn, tham số hay cấu trúc JSON của `/`, `/detail`, `/stream`. **APK không cần build lại.**

---

## [1.1.0] - 2026-08-21

> **Đính chính:** phần mô tả dưới đây có hai điểm không đúng với code đã giao. (1) Anchor domain được **hardcode trong `index.js`**, không đọc từ `config.json` — trường `anchor_domains` khi đó hoàn toàn không được dùng. (2) "Layer 3 — IP comparison" và "Layer 2 — DNS CNAME" trên thực tế không bao giờ chạy được, vì lý do đã nêu ở mục 1.2.0. Bản 1.2.0 thay thế toàn bộ cơ chế này.

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
