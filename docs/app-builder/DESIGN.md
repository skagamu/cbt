# Rancangan r1

Referensi visual [Sistem Manajemen BK](https://skagamu.github.io/presensi-siswa/) dibuka dan diperiksa di Chromium. Portal memakai susunan identitas sekolah dan kartu login, latar terang, tombol biru, serta sudut kontrol membulat. Pada HP kartu menjadi satu kolom.

- Siswa: masuk → persiapan/jadwal → satu soal → konfirmasi kirim → bukti. Header soal menampilkan timer dan status simpan. Nomor soal menyertakan status lewat label aksesibel dan warna. Draf tersimpan per tab dan versi akses tulis.
- Guru: dashboard, ujian, bank soal, peserta/token, rekap, jadwal, dan akses guru. Jadwal dan akses guru dibatasi admin. Tindakan yang mencabut akses atau mengunci data meminta konfirmasi di layar.
- Browser menyimpan aset statis di subpath Pages. Jalur RPC siswa memakai sesi acak terikat perangkat dan token versi. Jalur RPC guru terikat profil Auth aktif. Fungsi internal memvalidasi hak akses dalam transaksi; RLS menutup akses tabel langsung.
- Slot sesi adalah templat WIB. Bentrok ujian reguler dicek untuk kelas yang sama. Paket susulan harus terpisah dan jadwal tiap peserta tidak boleh bentrok.
- Bobot awal semua soal adalah 1. Jika guru mengatur bobot, nilai adalah proporsi bobot benar terhadap bobot semua soal aktif. Pembatalan seluruh soal menghasilkan nilai untuk ditinjau.
