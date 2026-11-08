# CBT SMK Gajah Mungkur 1 Wuryantoro

Portal ujian pilihan ganda untuk siswa dan ruang kerja guru/admin. Aplikasi statis JavaScript dibangun dengan Vite. GitHub Pages menyajikan aplikasi pada `/cbt/` dan rute `#siswa` serta `#guru`. Supabase Auth mengelola akun guru. Postgres menyimpan naskah, jawaban, dan nilai, serta menjalankan finalisasi melalui Supabase Cron.

[Buka aplikasi](https://skagamu.github.io/cbt/) · [Kontrak API](docs/app-builder/API.md) · [Status verifikasi](docs/app-builder/STATUS.md)

## Siapkan akses pertama

1. Buka [Authentication → Users](https://supabase.com/dashboard/project/ynepxhlvpvlfuhcerydu/auth/users) di proyek pilot. Buat akun individual admin sekolah melalui **Add user → Create new user**, dan konfirmasi akun sesuai prosedur sekolah. Masukkan kredensial di Dashboard.
2. Di [SQL Editor](https://supabase.com/dashboard/project/ynepxhlvpvlfuhcerydu/sql/new), ganti alamat contoh di bawah dengan email akun Auth yang sudah dibuat. SQL ini memberi profil admin pada akun tersebut. Setelah admin pertama aktif, daftar profil berikutnya lewat menu **Akses Guru**.

   ```sql
   insert into cbt_private.staff (user_id, display_name, role, is_active)
   select id, 'Admin CBT', 'admin', true
   from auth.users
   where lower(email) = lower('admin@example.invalid')
   on conflict (user_id) do nothing
   returning user_id;
   ```

   Hasil harus satu baris saat pemasangan pertama. Masuk melalui [portal guru](https://skagamu.github.io/cbt/#guru), lalu cek dashboard dan pengelolaan akses. Untuk guru, buat akun Auth terlebih dahulu dan tetapkan kelas melalui portal admin.
3. Pertahankan pendaftaran publik dan login anonim Auth dalam posisi mati. **Site URL** harus `https://skagamu.github.io/cbt/`. Jika reset kata sandi dipakai, uji pengiriman email di browser yang sama dengan browser peminta reset. Untuk pengiriman ke pengguna sekolah, ikuti konfigurasi SMTP Supabase. [Dokumentasi Supabase Auth](https://supabase.com/docs/guides/auth/passwords)
4. Tinjau draf bank soal. Untuk ujian standar 40 soal, tambahkan soal hingga ada 40 soal yang sudah disetujui untuk mapel tersebut. Buat jadwal WIB, pilih kelas dan soal, lalu terbitkan. Terbitkan token individual dan bagikan melalui saluran privat. Token mentah muncul sekali. Jika salinan hilang, gunakan regenerasi untuk mencabut token dan sesi lama sambil mempertahankan jawaban server.
5. Buat ujian bertipe paket susulan dengan soal berbeda. Pilih peserta reguler, paket, alasan, jadwal, dan durasi. Rekap menyimpan hasil reguler dan susulan secara terpisah.

## Pengembangan dan deploy

```sh
cp .env.example .env.local
# Isi URL dan publishable key dari Dashboard Supabase.
npm ci
npm run dev
npm run check
```

- Proyek pilot sudah memakai migrasi di `supabase/migrations/`. Dua migrasi awal di repo adalah catatan skema saja. Roster dan isi bank soal asli ada di proyek Supabase.
- Untuk proyek baru, jalankan migrasi berurutan dengan Supabase CLI yang sudah ditautkan ke proyek yang benar. Pastikan ekstensi `pgcrypto` aktif di schema `extensions` sebelum menjalankan migrasi. Impor hanya data yang disetujui melalui jalur admin/database. Jangan ubah spreadsheet PRESENSI BK.
- GitHub → **Settings → Pages → Source → GitHub Actions**. Isi Actions **Variables** `SUPABASE_URL` dan `SUPABASE_PUBLISHABLE_KEY`. Push ke `main` atau jalankan workflow **Deploy CBT to GitHub Pages**. [Dokumentasi GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- Rute siswa memanggil RPC Postgres anonim dengan sesi CBT berumur terbatas. Jalur guru memakai JWT Auth dan profil aktif. Seluruh tabel CBT menolak akses langsung dari peran browser. Skema `cbt_private` harus tetap di luar daftar skema yang diekspos Data API. Desain ini tidak memerlukan Edge Function, service-role key, atau secret runtime di frontend.
- Ganti logo sementara di `public/logo.svg`. Warna utama di `web/style.css`.

## Operasi pilot

- Semua waktu server tersimpan sebagai `timestamptz`. Tiga slot bawaan berulang dalam WIB. Tanggal dan jendela absolut ditetapkan di setiap ujian. Batas efektif siswa adalah yang paling awal di antara durasi sejak mulai, penutupan sesi, dan penutupan manual.
- Cron `cbt-finalize-due` memproses ujian yang melewati tenggat setiap menit. Cek **Integrations → Cron** jika percobaan tertahan. Dari rekap, gunakan tindakan finalisasi percobaan jatuh tempo jika diperlukan.
- Salin ekspor rekap ke penyimpanan sekolah yang terbatas aksesnya. Ekspor mengandung data peserta. Data CSV dilindungi dari evaluasi formula saat dibuka.
- Untuk pemulihan versi frontend, kembalikan commit dengan `git revert` lalu jalankan Pages lagi. Pertahankan data percobaan dan audit saat perbaikan database. Terapkan migrasi koreksi ke depan.
- Supabase Free menyediakan database 500 MB, RAM bersama 500 MB, dan egress 5 GB serta dapat menjeda proyek setelah satu minggu tanpa aktivitas. Cadangkan data privat secara terpisah dan uji pemulihan ke proyek isolasi sebelum ujian resmi. Catat kesehatan Cron, penggunaan database dan egress. [Harga Supabase](https://supabase.com/pricing) · [Cadangan Supabase](https://supabase.com/docs/guides/platform/backups)
