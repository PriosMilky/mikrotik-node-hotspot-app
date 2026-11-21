# MikroTik Hotspot User (Node.js)

Web app lokal untuk membuat user Hotspot pada RouterOS 7 melalui REST API. Password router hanya disimpan di `.env` pada server, bukan di browser.

## Menjalankan aplikasi

Perlu Node.js 20 atau lebih baru.

```sh
cd MIKROTIK/mikrotik-node-hotspot-app
npm install
cp .env.example .env
```

Edit `.env`:

- `MIKROTIK_HOST`: IP atau hostname router, tanpa `http://` atau path.
- `MIKROTIK_PORT`: port layanan `www-ssl` (umumnya `443`).
- `MIKROTIK_PROTOCOL`: gunakan `https` untuk koneksi terenkripsi.
- `MIKROTIK_USERNAME` dan `MIKROTIK_PASSWORD`: akun RouterOS khusus aplikasi.

Jalankan:

```sh
npm start
```

Buka `http://127.0.0.1:3000`. Secara default server hanya menerima koneksi dari komputer yang sama. Jangan ubah `HOST` atau mengekspos port aplikasi/API RouterOS ke internet. Jika perlu akses dari LAN, batasi dengan firewall ke jaringan administrator.

Jika router memakai sertifikat CA internal, tambahkan CA tepercaya ke Node.js, misalnya dengan `NODE_EXTRA_CA_CERTS=/path/to/router-ca.pem`. Jangan menonaktifkan verifikasi sertifikat HTTPS. HTTP hanya sesuai untuk pengujian pada jaringan terisolasi karena mengirim credential tanpa enkripsi.

Jalankan `npm test` untuk menguji pemuatan profile, validasi pilihan, dan pembuatan user terhadap RouterOS tiruan.

Password Hotspot ditampilkan agar admin dapat memeriksanya. Setelah user berhasil dibuat, tombol cetak membuka dialog cetak dengan username, password, dan profile pada lembar yang rapi.

Profile Hotspot dimuat langsung dari MikroTik saat halaman dibuka. Pilihan profile diperiksa ulang oleh backend sebelum user dibuat. Jika profile baru ditambahkan saat halaman sudah terbuka, muat ulang halaman untuk memperbarui daftar.

## Mengatur koneksi dari halaman

Buka bagian **MikroTik Connection** untuk mengubah alamat router, protocol, port REST API, dan username. Masukkan password baru hanya jika ingin menggantinya; kolom password yang kosong akan mempertahankan password tersimpan. Tombol **Save & Test Connection** menguji akses profile Hotspot terlebih dahulu, lalu menyimpan pengaturan ke `.env` dan menerapkannya langsung tanpa restart jika berhasil. Pengaturan yang gagal diuji tidak disimpan.

Password tidak dikirim kembali ke browser. File `.env` ditulis dengan permission `0600` dan tetap diabaikan Git. Jika sebuah nilai berisi tanda kutip ganda atau backslash, aplikasi menyimpannya sebagai Base64 di `.env` agar dapat dibaca konsisten oleh dotenv; Base64 bukan enkripsi. Endpoint pengaturan hanya menerima permintaan lokal dari komputer yang menjalankan server. Pertahankan `HOST=127.0.0.1` dan jangan mengekspos aplikasi atau REST API ke internet.

## Konfigurasi RouterOS 7

REST tersedia melalui `www-ssl` mulai RouterOS 7.1beta4. Aktifkan HTTPS dan batasi service ke IP komputer yang menjalankan Node app. Contoh berikut perlu disesuaikan dengan IP server dan port yang dipakai:

```routeros
/user group add name=hotspot-webapp policy=read,write,rest-api
/user add name=hotspot-app group=hotspot-webapp address=192.168.88.10/32 password="GANTI_DENGAN_PASSWORD_KUAT"
/ip service set www-ssl disabled=no port=443 address=192.168.88.10/32
```

Pasang sertifikat TLS yang dipercaya oleh komputer server. Tambahkan juga aturan firewall router yang hanya mengizinkan koneksi TCP ke port `www-ssl` dari IP server; jangan membuka REST API ke WAN. Akun dengan policy `write` dapat mengubah konfigurasi router, jadi gunakan akun khusus dan batasi akses jaringan dengan ketat.

Endpoint `GET /api/hotspot-profiles` membaca profile router, sedangkan `POST /api/hotspot-users` menerima username, password, dan profile pilihan. Backend membuat user melalui `PUT /rest/ip/hotspot/user`.
