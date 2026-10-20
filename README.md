# KLM Sender

Kirim file apa saja antar PC dan HP — ukuran asli tanpa kompres. Satu perangkat bisa terhubung ke banyak perangkat sekaligus.

- **Web / HP (PWA):** buka situs GitHub Pages repo ini, lalu tekan **Install** (Android/PC) atau **Bagikan → Tambahkan ke Layar Utama** (iPhone).
- **Windows:** tab **Actions → Build Windows → Run workflow**, lalu unduh `KLM-Sender-Windows` (installer + portable).

## Cara kerja
- **Wi-Fi yang sama (bisa tanpa internet):** aplikasi Windows menjalankan server lokal. HP/PC lain memindai QR di PC dan langsung masuk ke server itu; semua perangkat di server saling terlihat dan bisa saling kirim (HP⇄PC, HP⇄HP, PC⇄PC).
- **Jarak jauh (internet):** masukkan kode 6 karakter; file dikirim peer-to-peer terenkripsi.
- Setiap perangkat wajib punya **nama** sebagai identitas. **Kode/QR tetap** dan hanya bisa diganti dengan **password** yang diatur di masing-masing perangkat.

Struktur:
- `index.html`, `sw.js`, `manifest.webmanifest`, `vendor/`, ikon — aplikasi web (GitHub Pages)
- `desktop/` — aplikasi Windows (Electron) + server Wi-Fi lokal; tampilan web disalin saat build
