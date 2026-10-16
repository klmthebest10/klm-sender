# KLM Sender

Kirim file apa saja antar PC dan HP — ukuran asli tanpa kompres, langsung peer-to-peer.

- **Web / HP (PWA):** buka situs GitHub Pages repo ini, lalu tekan **Install** (Android/PC) atau **Bagikan → Tambahkan ke Layar Utama** (iPhone).
- **Windows:** tab **Actions → Build Windows → Run workflow**, lalu unduh `KLM-Sender-Windows` (installer + portable).

Struktur:
- `index.html`, `sw.js`, `manifest.webmanifest`, `vendor/`, ikon — aplikasi web (dipublikasikan ke GitHub Pages)
- `desktop/` — aplikasi Windows (Electron); tampilan web disalin saat build
