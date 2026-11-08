# Spesifikasi r1

Sumber utama adalah brief pelaksanaan dan dokumen [Spesifikasi Implementasi Aplikasi CBT](https://docs.google.com/document/d/1ktTJkgLFYY1DX3P0lHIlE-i22FrlaKCp/edit). Baseline repo kosong. Database pilot telah berisi roster dan bank soal awal.

| ID | Kriteria penerimaan |
| --- | --- |
| CBT-01 | Guru Auth berprofil aktif dan admin dapat masuk. Operasi guru terbatas pada kelas yang ditetapkan. Tabel dan kunci tidak tersedia melalui akses siswa. |
| CBT-02 | Guru mengelola naskah, peserta, jadwal WIB, token individual dan pencabutan. Naskah terbit membekukan soal yang disetujui. |
| CBT-03 | Siswa masuk dengan identitas dan token, mendapat satu percobaan, memulihkan jawaban, mengambil alih akses tulis secara eksplisit, dan menerima bukti yang sama untuk kirim ulang. Tenggat berlaku di server. |
| CBT-04 | Susulan berizin punya paket terpisah, audit, dan bukti sendiri. Koreksi menyimpan versi lama. Nilai tersedia bagi siswa setelah rilis. Guru dapat mengekspor rekap. |
| CBT-05 | Tampilan ujian pada 320 CSS px mendukung kontrol 44 px, fokus, timer, dan umpan balik simpan. |
| CBT-06 | Ukur skenario 36, 350, dan 700 pengguna sintetis, tiga ulangan dan satu soak 90 menit bila kuota dan lingkungan mendukung. Ukur kehilangan data, duplikasi, akses silang, persentil latensi, error, dan finalisasi. |
| CBT-07 | Deploy ke GitHub Pages dan verifikasi rute subpath. Roster dan kunci nyata tetap di Supabase. |

Di luar pilot: mode kios, deteksi pindah aplikasi/tab, pembahasan.
