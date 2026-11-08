# Status CBT r1

Baseline `skagamu/cbt` adalah repo kosong pada 8 November 2026 WIB. Dokumen r1 di [SPEC](SPEC.md), [DESIGN](DESIGN.md), [PLAN](PLAN.md), dan [API](API.md).

- **P1 terverifikasi.** Drive dibaca melalui konektor. Supabase mengonfirmasi 466 peserta pada 18 kelas, kelas terbesar 37, serta 150 soal berstatus draf. Sheet sumber hanya diperiksa metadata. Tidak ada nama, NIS, isi soal nyata, atau kunci nyata dalam repo.
- **P2 terverifikasi.** Migrasi tambahan diterapkan di Supabase pilot dan dicatat dengan ID yang sama di repo. RLS aktif di 14 tabel CBT. Peran anon/authenticated tidak memiliki SELECT langsung. Cron finalisasi dan pembersihan sesi aktif. Advisory keamanan hanya info RLS tanpa kebijakan karena tabel sengaja tertutup. Advisory performa mencatat indeks belum terpakai pada baseline. Advisory kesehatan kosong.
- **P3 terverifikasi lokal.** Build Vite, uji SQL terpadu, dan Chromium 320 CSS px dengan adaptor SQL lokal. Uji portal staf tambahan memakai API tiruan.
- **P4 berlangsung.** Uji SQL lokal dan tahap HTTPS 36, 350, serta putaran pertama 700 peserta telah selesai. Lihat [laporan verifikasi](../verification.md) untuk skenario dan bukti terukur.
- **P5 tayang dan terverifikasi.** [GitHub Pages](https://skagamu.github.io/cbt/) menyajikan portal pada subpath yang benar. Auth publik dimatikan dan Site URL dikonfigurasi. Pemilik harus menentukan dan membuat akun admin pertama sebelum aktivasi sekolah.

Referensi advisory [RLS tanpa kebijakan](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) dan [indeks belum terpakai](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index).
