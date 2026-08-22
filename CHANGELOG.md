# CHANGELOG XL-TV

> Nhật ký thay đổi của dự án, theo yêu cầu của chủ dự án **Quang Thoại**.

---

## [1.3.0] - 2026-08-22

Nguồn đổi tên miền, hệ thống **không bắt kịp** — danh sách trận đứng yên ở dữ liệu cũ. Bản 1.2.0 hứa "tự bám domain" nhưng có ba lỗ hổng, sửa cả ba ở đây.

### Fixed: chỉ gọi `/truc-tiep/`, không bao giờ thử trang gốc

Lưới trận nằm ở **trang gốc**. Đường dẫn `/truc-tiep/` chỉ tình cờ chạy được vì `nmsba.com` 301 nó về `/`. Khi anchor redirect **giữ nguyên đường dẫn** sang domain mới mà bố cục mới không có `/truc-tiep/`, request trả 404 và ứng viên đó bị loại — kể cả khi nó chính là domain đang sống.

Nay thử `/` trước, `/truc-tiep/` chỉ còn là dự phòng (`SOURCE_PATHS`).

### Fixed: `if (!res.ok) return null` vứt mất manh mối quý nhất

Kể cả khi trang trả 404, `res.url` đã cho biết request đáp xuống domain nào — đúng thứ đang đi tìm. Bản cũ vứt cả response.

Nay đọc `origin` trước rồi mới xét nội dung. Nếu request đáp xuống một domain khác domain đã gọi, domain đó được **xếp vào hàng đợi để thử lại từ trang gốc** — lần theo biển chỉ đường thay vì bỏ cuộc. Chặn `MAX_CANDIDATES = 8` để không nổ số subrequest.

### Fixed: domain đã nhớ được tin vô thời hạn *(nguyên nhân chính)*

Domain cũ thường **không chết hẳn mà đóng băng** — vẫn trả 200 kèm lưới trận của mấy hôm trước. `looksLikeSource()` thấy có lưới là nhận, nên tiến trình bám chết vào domain cũ, anchor không bao giờ được hỏi tới, và người dùng xem mãi danh sách cũ. Đây khớp đúng triệu chứng gặp phải: không báo lỗi, chỉ là trận không cập nhật.

Nay `_domainState` có thêm mốc `verified_at` — lần cuối **đi qua anchor** mà ra domain này. Chỉ đường anchor mới được đóng dấu; resolve bằng domain đã nhớ **không tự gia hạn** (nếu không thì domain đóng băng cứ tự gia hạn cho chính nó mãi mãi). Quá `DOMAIN_TTL_MS` (10 phút), anchor lên đầu hàng đợi.

**Không tốn thêm request:** đi qua anchor thì redirect tự dẫn về domain sống và trả luôn trang cần cào — vẫn đúng 1 request như đường nhanh.

### Added: bộ kiểm thử (`test/`)

12 test chạy trên "internet giả" (`test/fake-source.mjs`) mô phỏng redirect, 404, trang park, domain chết, GitHub 429. Chạy bằng `npm test`.

Bản 1.2.0 nói "27 test PASS" nhưng không commit lại nên không kiểm chứng được — lần này bộ test nằm trong repo. **Đã đối chứng: 8/12 test này FAIL trên code 1.2.0, 12/12 PASS trên 1.3.0.**

### Changed: `/debug/discovery`

Thêm `verified_age_ms` (tuổi mốc xác minh qua anchor, `null` = chưa lần nào), `verify_ttl_ms`, `paths_tried`.

### Tương thích

Không đổi đường dẫn, tham số hay cấu trúc JSON của `/`, `/detail`, `/stream`. **APK không cần build lại.**

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
