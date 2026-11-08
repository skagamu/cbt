# Verifikasi CBT

Tanggal uji 8–9 November 2026, WIB. Pengujian memakai peserta dan soal sintetis. Koneksi ke spreadsheet roster tidak dipakai oleh pengujian.

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

Jalankan `npm run dev -- --host 127.0.0.1 --port 4173 --strictPort` dengan konfigurasi publik aplikasi, lalu `npm --prefix tests run browser`. Pengujian browser memakai kode frontend yang sama, meneruskan permintaan CBT ke RPC lokal yang sebenarnya, dan menyimulasikan respons Supabase Auth untuk akun uji staf. Chrome native di emulator Android berhenti di layar persetujuan penggunaan pertama. Pemeriksaan Chrome dan TalkBack pada perangkat Android memerlukan pengujian terpisah.

## Skenario fungsional

- Lulus di PostgreSQL 17.11. Hak eksekusi RPC, RLS, pembatasan kelas guru, aksi admin, penolakan sesi tumpang tindih, peninjauan soal, penerbitan berdasarkan soal disetujui, dan naskah beku.
- Lulus di PostgreSQL 17.11. Penolakan token yang salah dan peserta asing, akses lintas peserta ditolak, hash token, token sekali tampil, rotasi dan pencabutan sesi lama, revisi idempoten, pemulihan status, ambil alih perangkat, submit ganda dengan bukti yang sama, penolakan perubahan jawaban setelah tenggat.
- Lulus di PostgreSQL 17.11. Penilaian naskah yang dikerjakan, histori koreksi, rilis nilai, nilai/kunci tersembunyi sebelum waktunya, susulan satu kali dengan paket berbeda dan jejak audit.
- Lulus di PostgreSQL 17.11. JWT staf yang masih aktif secara waktu ditolak jika akun diblokir, sesi dihapus/kedaluwarsa, atau sesi milik pengguna lain.
- Lulus pada emulasi Chrome Android 320 × 640 CSS px. Fokus keyboard, kontrol utama dan opsi sentuh ≥44 px, tidak ada gulir horizontal halaman, timer/status simpan, navigasi antarsoal, penandaan ragu, simpan dan refresh, isolasi duplikat tab, putus-sambung koneksi, rotasi, Back, bukti kirim, dasbor staf dan ekspor CSV dengan Auth simulasi. Skenario ini tidak memakai Supabase Auth produksi.

Uji integrasi Auth terpisah memakai Supabase Auth v2.197.0 resmi untuk Darwin ARM64 dengan SHA terverifikasi, seluruh 75 migrasi upstream, PostgreSQL 17.11 sekali pakai, dan Supabase SDK v2.119.0 melalui HTTP. Login kata sandi, `getUser`, dan logout lokal lulus. Kata sandi salah dan pendaftaran publik ditolak. RPC staf dengan klaim JWT yang benar-benar ditandatangani membuktikan penugasan admin/guru, pembatasan kelas, penolakan akun tanpa penugasan, perubahan admin oleh guru, sesi lintas pengguna, dan token sesi yang telah dicabut. Lingkungan uji telah dibersihkan. Login guru positif di Supabase produksi dan pemulihan kata sandi melalui email PKCE belum dijalankan. [Rilis Supabase Auth](https://github.com/supabase/auth/releases/tag/v2.197.0).

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

Soak lokal 700 peserta selama 90 menit menghasilkan 168.322 autosave, 140 reconnect, 350 kirim manual, dan 350 pengiriman ulang. P95 login/baca/autosave/kirim adalah 157/139.7/4.2/79.8 ms. Cron memfinalisasi seluruh timer dalam 7.593 s. Ada 0 galat, retry, kehilangan jawaban, hasil ganda, respons lintas peserta atau deadlock. Jawaban diperiksa sesudah soak.

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

Tahap 350 peserta dan tiga putaran 700 peserta lulus melalui HTTPS. Setiap putaran 700 menghasilkan 700 bukti unik, 700 hasil dan checksum jawaban yang sama antara klien dan database. Keempat tahap ini mencatat 0 galat operasi, 0 retry otomatis dan 0 respons lintas peserta. Pool 48 permintaan membatasi koneksi aktif, sehingga latensi mencakup antrean untuk burst login, baca dan kirim. Angka ini tidak mengukur 700 koneksi HTTP simultan. Putaran 700 kedua dan ketiga memakai migrasi akhir yang membatasi data yang dapat dilihat perangkat tanpa hak tulis.

| Peserta | Putaran | Login | Baca 40 | Autosave | Sambung ulang | Bukti kirim | Ulang kirim | Bukti timer | Grading timer maksimum, detik |
| ---: | ---: | --- | --- | --- | --- | --- | --- | --- | ---: |
| 350 | 1 | 1876.7/2458.8/2515.5 | 1261.2/1422.7/1506.8 | 151.7/251.1/348.5 | 148.2/200.1/347.1 | 510.3/822.5/928.7 | 616.1/739.6/800.9 | 1516.7/1836.2/1972.5 | 59.301 |
| 700 | 1 | 2400.6/3447.2/3550.4 | 2332.4/2653.3/2708.7 | 157.2/419.7/679.1 | 154.1/207.5/313.5 | 800.3/1314.6/1369.4 | 1139.4/1213.4/1264.6 | 1742.5/2273.3/2330.8 | 4.714 |
| 700 | 2 | 1865.4/3047.6/3136 | 2356.3/2466/2514.1 | 142.5/187.3/264.3 | 140.5/173.1/198.5 | 1073.9/1708/1806.6 | 1205.6/1454.9/1535.1 | 1532.3/2064.7/2129.4 | 46.133 |
| 700 | 3 | 1659/2643.2/2726 | 2206/2448.7/2482 | 145.1/207.8/298.9 | 144.3/178.5/204.8 | 787.9/1303.6/1356.5 | 1097.4/1177.3/1252.2 | 1998.3/2503.9/2558.9 | 19.519 |

| Peserta | Putaran | Body HTTPS tanpa kompresi, byte | Ukuran database akhir, byte | Perubahan ukuran, byte | Blok dibaca | Blok cache | Deadlock |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 350 | 1 | 3663033 | 13743795 | 1024000 | 0 | 203974 | 0 |
| 700 | 1 | 7327485 | 14882483 | 1138688 | 1 | 243980 | 0 |
| 700 | 2 | 7326313 | 15259315 | 1179648 | 0 | 440559 | 0 |
| 700 | 3 | 7326287 | 16389811 | 1130496 | 0 | 239047 | 0 |

Statistik database menghitung seluruh aktivitas proyek selama interval ukur. Pembersihan setiap tahap menyisakan 0 peserta sintetis dan 0 ujian sintetis, serta 466 siswa, 5 mapel, 150 soal awal dan 0 ujian sekolah. Dashboard penggunaan sebelum tahap panjang menampilkan database organisasi 0,029 dari 0,5 GB dan egress di bawah 1% dari 5 GB, dengan kemungkinan jeda meter satu jam.

Soak HTTPS 700 peserta berlangsung 90 menit pada 8 November 2026. Setiap peserta mulai ujian 40 soal, melakukan autosave berjeda acak 15–30 detik, dan sebagian reconnect. Pool membatasi 48 permintaan aktif. Sebanyak 350 peserta mengirim manual dan 350 lainnya difinalisasi melalui pg_cron.

| Operasi | Jumlah | p50/p95/p99, ms | Galat/retry |
| --- | ---: | --- | ---: |
| login | 700 | 1512.6/2502.2/2593.4 | 0/0 |
| baca 40 | 700 | 2196.3/2287.4/2347.9 | 0/0 |
| autosave | 166375 | 147.6/187.1/306.4 | 0/0 |
| reconnect | 456 | 149.6/193.9/235.1 | 0/0 |
| kirim manual | 350 | 872.1/1418.5/1472.4 | 0/0 |
| ulang kirim | 350 | 1166.9/1268.2/1399.2 | 0/0 |
| cek bukti timer | 350 | 1821.8/2329.3/2373.9 | 0/0 |

Checksum jawaban klien dan database sama. Ada 0 kehilangan jawaban terkonfirmasi, 0 hasil ganda, 0 respons lintas pengguna, 0 deadlock dan 0 galat operasi. Finalisasi Cron selesai dalam 7.593 detik. Body JSON aplikasi terukur 463.242.291 byte tanpa kompresi dan ukuran database bertambah sekitar 4.227.072 byte selama interval tersebut. Setelah pembersihan exact-ID dan verifikasi, database kembali mencatat 466 siswa, 5 mapel, 150 soal draf, 0 ujian, 0 siswa sintetis, dan kedua tugas Cron aktif. Usage dashboard sebelum soak mencatat database 0,029 / 0,5 GB dan egress di bawah 1% / 5 GB. Meter egress dapat tertunda hingga satu jam.

P95 autosave dan bukti kirim berada di bawah target 2 dan 5 detik pada pool dan jaringan penguji ini. P95 login dan baca mencakup antrean pool selama burst serentak. Pool 48 tidak merepresentasikan 700 koneksi HTTP serentak, dan hasil uji tidak menjamin kapasitas pada jaringan sekolah. Pengukuran ini perlu dipakai bersama latihan Android fisik, backup/restore, dan pemantauan sebelum ujian resmi.

### Menjalankan tahap HTTPS

Jadwalkan penggunaan proyek uji terisolasi atau waktu tanpa ujian aktif. Skrip `node tests/hosted.mjs prepare 36` membuat direktori sementara berizin terbatas. Jalankan `prepare.sql` pada proyek yang dituju, kemudian `node --env-file=.env.local tests/hosted.mjs run <direktori>/manifest.json`. Akses runner hanya membutuhkan publishable key. Jalankan `verify.sql` dan selalu jalankan `cleanup.sql`, juga ketika pengujian gagal. Konfirmasi jumlah peserta dan ujian sintetis tersisa sama dengan nol. Hapus direktori sementara yang memuat token.

Runner juga menyiapkan tahap 350 dan 700 dengan `prepare 350` atau `prepare 700`. Jalankan setelah meninjau galat tahap sebelumnya, pemakaian paket dan jam operasional, memakai `CBT_ALLOW_LARGER_HOSTED_LOAD=1`. Ukuran pool HTTP default 48. Untuk uji 90 menit gunakan argumen ketiga `node tests/hosted.mjs prepare 700 5400`. Hasil tahap HTTPS di atas tidak menggantikan uji Android fisik atau verifikasi sesi guru melalui Supabase Auth sungguhan.
