# Verifikasi CBT

Tanggal uji 8 November 2026, WIB. Pengujian memakai peserta dan soal sintetis. Koneksi ke spreadsheet roster tidak dipakai oleh pengujian.

## Menjalankan ulang

Gunakan Node.js 22.12 atau lebih baru, PostgreSQL 17, dan Google Chrome atau Chromium. Paket verifikasi dipasang terpisah dari frontend. Skrip lokal membuat database sekali pakai di soket Unix, menerapkan migrasi, lalu membuangnya saat selesai.

```sh
npm ci
npm ci --prefix tests
npm run check
npm --prefix tests run integration
CBT_LOAD_ROUNDS=3 npm --prefix tests run load
CBT_LOAD_USERS=700 CBT_LOAD_MODE=timer npm --prefix tests run load
CBT_LOAD_USERS=700 CBT_LOAD_SECONDS=5400 npm --prefix tests run load
```

Jika PostgreSQL lokal memiliki ekstensi `pg_cron`, skrip memakainya untuk finalisasi terjadwal. Atur `CBT_CRON=1` agar pengujian gagal jika ekstensi tidak tersedia. Tanpa ekstensi, laporan menandai pemanggilan langsung fungsi finalisasi. Gunakan `CBT_PG_BIN` jika biner PostgreSQL berada di luar PATH.

Jalankan `npm run dev -- --host 127.0.0.1 --port 4173 --strictPort` dengan konfigurasi publik aplikasi, lalu `npm --prefix tests run browser`. Pengujian browser memakai kode frontend yang sama, meneruskan permintaan CBT ke RPC lokal yang sebenarnya, dan menyimulasikan respons Supabase Auth untuk akun uji staf. Chrome fisik dan TalkBack di Android memerlukan pengujian perangkat terpisah.

## Skenario fungsional

- Lulus di PostgreSQL 17.11. Hak eksekusi RPC, RLS, pembatasan kelas guru, aksi admin, penolakan sesi tumpang tindih, peninjauan soal, penerbitan berdasarkan soal disetujui, dan naskah beku.
- Lulus di PostgreSQL 17.11. Penolakan token yang salah dan peserta asing, akses lintas peserta ditolak, hash token, token sekali tampil, rotasi dan pencabutan sesi lama, revisi idempoten, pemulihan status, ambil alih perangkat, submit ganda dengan bukti yang sama, penolakan perubahan jawaban setelah tenggat.
- Lulus di PostgreSQL 17.11. Penilaian naskah yang dikerjakan, histori koreksi, rilis nilai, nilai/kunci tersembunyi sebelum waktunya, susulan satu kali dengan paket berbeda dan jejak audit.
- Lulus di PostgreSQL 17.11. JWT staf yang masih aktif secara waktu ditolak jika akun diblokir, sesi dihapus/kedaluwarsa, atau sesi milik pengguna lain.
- Lulus pada emulasi Chrome Android 320 × 640 CSS px. Fokus keyboard, kontrol utama dan opsi sentuh ≥44 px, tidak ada gulir horizontal halaman, timer/status simpan, simpan dan refresh, putus-sambung koneksi, rotasi, Back, bukti kirim, dan dasbor staf dengan Auth simulasi. Skenario ini tidak memakai Supabase Auth produksi.

GitHub Pages mengembalikan HTTP 200 dan memuat tiga aset pada subpath `/cbt/`. Rute `#guru` bertahan saat reload, rute `#siswa` dapat dibuka kembali, tanpa overflow atau galat runtime pada emulasi Chrome Android 320 × 640. Pemeriksaan artefak statis menemukan 0 marker kunci server atau JWT dengan peran istimewa. REST Supabase mengembalikan 401 untuk permintaan anonim ke tabel roster, kolom kunci bank, dan RPC staf. Ulangi pemeriksaan ini dengan `node --env-file=.env.local tests/live.mjs`. [Portal CBT](https://skagamu.github.io/cbt/).

## Beban PostgreSQL lokal

PostgreSQL 17.11, pg_cron 1.6.8, Node.js 24.13.0, macOS ARM64 dengan 8 inti dan RAM 8 GiB, soket Unix, pool 24 koneksi. Tiga putaran masing-masing naik dari 36 ke 350 ke 700 peserta. Setiap tahap menjalankan login serentak, membaca 40 soal, autosave dengan jeda acak 15–30 detik selama 31 detik, sambung ulang sebagian peserta, kirim massal separuh peserta, dan finalisasi timer sisanya. Autosave terakhir dapat berkelompok ketika jendela uji berakhir. Waktu termasuk antrean pool. Satuan latensi p50/p95/p99 adalah milidetik.

| Putaran | Peserta | Login | Baca 40 | Autosave | Sambung ulang | Ulang simpan | Bukti kirim | Ulang kirim | Finalisasi timer, detik |
| ---: | ---: | --- | --- | --- | --- | --- | --- | --- | ---: |
| 1 | 36 | 55.4/62.7/64.3 | 12.2/38.9/46.2 | 10.4/49.7/52.5 | 2.2/4.4/4.4 | 1.3/2/2 | 12.6/14/14 | 1.3/1.9/1.9 | 14.089 |
| 1 | 350 | 96.8/120/123.8 | 70.2/83.2/111.2 | 13/101.6/104.8 | 1.8/2.9/3.9 | 0.9/1.4/1.5 | 31.2/49.1/50 | 28.8/40.6/43.2 | 28.710 |
| 1 | 700 | 103/134.2/137.6 | 95.6/123.3/125.4 | 7.5/107.5/110.1 | 1.9/2.6/3.4 | 0.9/1.5/1.7 | 79.9/108.4/110 | 46.1/63.2/64 | 28.217 |
| 2 | 36 | 54.9/73.7/73.7 | 19.1/38.9/49.7 | 8.7/66.5/67.3 | 1.9/2.8/2.8 | 1/1.9/1.9 | 16.1/16.4/16.4 | 1.4/6.8/6.8 | 29.176 |
| 2 | 350 | 80.7/96.6/99.4 | 64.9/72.6/78 | 20.7/110.3/114.1 | 1.9/2.5/2.8 | 0.9/1.4/18.5 | 27/43/43.4 | 21/33.2/35.4 | 28.701 |
| 2 | 700 | 102.9/148/150.4 | 122.9/157.6/160.2 | 21.2/161.6/210.2 | 1/3/4.6 | 0.6/1.4/1.4 | 63.2/90.8/95.8 | 47.4/66.6/70.4 | 28.255 |
| 3 | 36 | 30.7/58.7/58.8 | 18.9/25.6/30.3 | 18.8/488.5/490.3 | 7.4/28.5/28.5 | 0.6/15.2/15.2 | 31.8/32.9/32.9 | 9.2/11.8/11.8 | 28.159 |
| 3 | 350 | 128.8/151.4/154.1 | 87.8/96.2/120.1 | 21.5/98.2/100 | 1.6/4/6 | 0.7/2.6/3.9 | 24.5/46.1/48.3 | 30.5/38/39.6 | 28.282 |
| 3 | 700 | 128.9/187.6/191.1 | 162/170.7/173.4 | 21.1/123.7/128.4 | 1.8/2.9/4.1 | 0.8/1.9/5 | 55.2/88.1/91.6 | 49/76.7/80.4 | 28.762 |

Sembilan tahap berjumlah 17,252 operasi, dengan 0 galat, 0 retry otomatis, 0 jawaban terkonfirmasi hilang, 0 hasil ganda, dan 0 respons lintas peserta. Uji tambahan dengan 700 peserta berakhir serentak seluruhnya melalui penjadwal. Finalisasi selesai dalam 23.678 detik, autosave 19.4/126.9/129.9 ms dan 0 galat. Angka ini mengukur PostgreSQL lokal. Trafik melewati soket Unix dan tidak mengonsumsi egress Supabase.

| Putaran | Peserta | Operasi | Ukuran respons JSON tanpa kompresi, byte | Perubahan ukuran basis data, byte | Blok dibaca | Blok cache |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 36 | 192 | 470246 | 344064 | 34 | 93623 |
| 1 | 350 | 1853 | 4500956 | 3358720 | 1 | 200563 |
| 1 | 700 | 3708 | 9002211 | 991232 | 0 | 335888 |
| 2 | 36 | 192 | 470241 | 16384 | 0 | 109096 |
| 2 | 350 | 1853 | 4500948 | 122880 | 0 | 210138 |
| 2 | 700 | 3704 | 9002324 | 647168 | 0 | 378709 |
| 3 | 36 | 192 | 470247 | 16384 | 0 | 110888 |
| 3 | 350 | 1852 | 4500310 | 131072 | 0 | 252135 |
| 3 | 700 | 3706 | 9003768 | 573440 | 0 | 413736 |

Uji ketahanan 700 peserta selama 90 menit dimulai di PostgreSQL lokal. Hasil akhir dicatat setelah seluruh durasi, finalisasi, dan pemeriksaan jawaban selesai.

## Supabase Free Tokyo

Tahap 36 peserta sintetis lewat HTTPS ke REST Supabase dari jaringan penguji, dengan 40 soal, autosave berjeda acak 15–30 detik, sambung ulang, kirim ulang dan finalisasi. Seluruh token uji disimpan di berkas sementara lokal. Fixture dihapus berdasarkan ID yang dibangkitkan dan database diperiksa ulang.

| Operasi | Sampel | p50/p95/p99, ms | Galat | Retry |
| --- | ---: | --- | ---: | ---: |
| login | 36 | 765/797.2/798.4 | 0 | 0 |
| read_40 | 36 | 320.5/590.1/607.5 | 0 | 0 |
| autosave | 36 | 170/475.8/592.1 | 0 | 0 |
| reconnect | 8 | 143.3/157.8/157.8 | 0 | 0 |
| submit | 18 | 264.1/477.9/477.9 | 0 | 0 |
| retry_submit | 18 | 170.1/387.6/387.6 | 0 | 0 |
| timer_receipt | 18 | 883.6/913.1/913.1 | 0 | 0 |

Database mencatat 36 jawaban terkonfirmasi, 36 hasil dan 36 ID bukti unik. Sebanyak 18 peserta mengirim manual dan 18 difinalisasi oleh penjadwal. Keterlambatan grading timer terlama 38,952 detik dari tenggat. Body respons yang terukur 381.698 byte tanpa kompresi dan ukuran database pada akhir tahap 12.801.715 byte. Angka body merupakan perkiraan volume respons aplikasi. Meter egress paket mencakup kompresi, protokol, dan trafik lain. Setelah pembersihan, terdapat 0 peserta dan ujian sintetis, 466 siswa roster, 5 mapel, dan 150 soal sumber.

Paket Free tercatat menyediakan CPU bersama, RAM hingga 0,5 GB, database 500 MB per proyek, egress 5 GB dan cached egress 5 GB. Proyek bisa dijeda setelah seminggu tanpa aktivitas. Backup otomatis dan point-in-time recovery tidak disertakan pada paket Free. Kelulusan pengujian kapasitas tetap perlu disertai rencana backup, pemulihan dan pemantauan untuk ujian sekolah. [Harga Supabase](https://supabase.com/pricing), [Compute and Disk](https://supabase.com/docs/guides/platform/compute-and-disk).

Tahap HTTPS 350 peserta juga lulus. Login p50/p95/p99 1.876,7/2.458,8/2.515,5 ms, autosave 151,7/251,1/348,5 ms, dan bukti kirim 510,3/822,5/928,7 ms. Tidak ada galat atau retry otomatis. Semua 350 jawaban terkonfirmasi tersimpan dan menghasilkan 350 bukti unik. Timer terlama 59,301 detik. Body respons 3.663.033 byte, ukuran database 13.743.795 byte, dan hasil pembersihan kembali ke jumlah sumber. Pool 48 permintaan membuat waktu login mencakup antrean saat ratusan peserta tiba bersamaan.

### Menjalankan tahap HTTPS

Jadwalkan penggunaan proyek uji terisolasi atau waktu tanpa ujian aktif. Skrip `node tests/hosted.mjs prepare 36` membuat direktori sementara berizin terbatas. Jalankan `prepare.sql` pada proyek yang dituju, kemudian `node --env-file=.env.local tests/hosted.mjs run <direktori>/manifest.json`. Akses runner hanya membutuhkan publishable key. Jalankan `verify.sql` dan selalu jalankan `cleanup.sql`, juga ketika pengujian gagal. Konfirmasi jumlah peserta dan ujian sintetis tersisa sama dengan nol. Hapus direktori sementara yang memuat token.

Runner juga menyiapkan tahap 350 dan 700 dengan `prepare 350` atau `prepare 700`. Jalankan setelah meninjau galat tahap sebelumnya, pemakaian paket dan jam operasional, memakai `CBT_ALLOW_LARGER_HOSTED_LOAD=1`. Ukuran pool HTTP default 48. Hasil tahap HTTPS di atas tidak menggantikan uji Android fisik atau verifikasi sesi guru melalui Supabase Auth sungguhan.
