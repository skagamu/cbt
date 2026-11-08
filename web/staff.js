import './staff.css';

const OPTION_KEYS = ['A', 'B', 'C', 'D'];
const GRADES = ['10', '11', '12'];
const STATUS = {
  draft: 'Draf',
  approved: 'Disetujui',
  archived: 'Dipensiunkan',
  published: 'Terbit',
  closed: 'Ditutup',
  teacher: 'Guru',
  admin: 'Admin',
};
const ATTEMPT_STATUS = {
  pending: 'Belum mulai',
  active: 'Mengerjakan',
  finalizing: 'Menunggu finalisasi',
  final: 'Terkirim',
};
const SUBMIT_REASON = {
  manual: 'Dikirim siswa',
  timeout: 'Waktu habis',
  closed: 'Ujian ditutup',
};
const WIB = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta',
  dateStyle: 'medium',
  timeStyle: 'short',
});

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const label = (value) => STATUS[value] || value;
const stamp = (value) => value ? `${WIB.format(new Date(value))} WIB` : '—';
const localWib = (value) => value ? new Date(new Date(value).getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 16) : '';
const absoluteWib = (value) => new Date(`${value}+07:00`).toISOString();
const noRows = (message) => `<p class="staff-empty">${esc(message)}</p>`;
const opt = (value, title, current) => `<option value="${esc(value)}"${String(current) === String(value) ? ' selected' : ''}>${esc(title)}</option>`;
const field = (title, control) => `<label class="staff-field"><span>${esc(title)}</span>${control}</label>`;
const btn = (action, title, id = '', style = '') => `<button type="button" class="staff-btn ${style}" data-act="${action}" data-id="${esc(id)}">${esc(title)}</button>`;
const submit = (title) => `<button class="staff-btn staff-btn-primary" type="submit">${esc(title)}</button>`;
const badge = (value, tone = 'quiet') => `<span class="staff-badge" data-tone="${tone}">${esc(label(value))}</span>`;
const title = (heading, description = '') => `<div class="staff-title"><h2>${esc(heading)}</h2>${description ? `<p>${esc(description)}</p>` : ''}</div>`;

function image(source) {
  if (!source) return '';
  let url;
  try { url = new URL(source); } catch { return ''; }
  if (url.protocol !== 'https:' || url.username || url.password) return '';
  return `<img class="staff-image" src="${esc(url.href)}" alt="Ilustrasi soal" referrerpolicy="no-referrer" loading="lazy">`;
}

function csvCell(value) {
  let raw = String(value ?? '');
  if (/^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(raw)) raw = "'" + raw;
  return '"' + raw.replaceAll('"', '""') + '"';
}

function exportCsv(participants) {
  const rows = [
    ['NIS', 'Nama', 'Kelas', 'Jenis', 'Status', 'Mulai (WIB)', 'Kirim (WIB)', 'Bukti', 'Nilai', 'Benar', 'Salah', 'Kosong', 'Hasil resmi'],
    ...participants.map((p) => [
      p.nis, p.full_name, p.class_code, p.regular_id ? 'Susulan' : 'Reguler',
      ATTEMPT_STATUS[p.attempt_status],
      p.started_at && stamp(p.started_at), p.submitted_at && stamp(p.submitted_at),
      p.receipt, p.score, p.correct_count, p.wrong_count, p.blank_count, p.official_result,
    ]),
  ];
  const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], {
    type: 'text/csv;charset=utf-8',
  }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'rekap-cbt.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function classOptions(classes, selected = [], grade = '') {
  const options = classes.filter((row) => !grade || String(row.grade_level) === String(grade));
  return options.map((row) => `<label class="staff-check"><input type="checkbox" name="classes"
    value="${esc(row.class_code)}"${selected.includes(row.class_code) ? ' checked' : ''}>
    <span>${esc(row.class_code)} <small>· ${esc(row.count)} siswa</small></span></label>`).join('') || noRows('Belum ada kelas yang dapat dipilih.');
}

function questionContent(question) {
  return `<p class="staff-pre">${esc(question.prompt)}</p>${image(question.image_url)}
    <dl class="staff-options">${OPTION_KEYS.map((key) => `<div><dt>${key}</dt>
      <dd class="staff-pre">${esc(question.options?.[key])}${key === question.correct_option ? ' <strong>· Kunci</strong>' : ''}</dd>
    </div>`).join('')}</dl><small>Bobot ${esc(question.weight ?? 1)}</small>`;
}

function explainError(error) {
  const code = String(error?.message || error || '').toLowerCase();
  const specific = {
    invalid_schedule: 'Periksa jam buka, jam tutup, durasi, dan slot yang dipilih.',
    invalid_questions: 'Periksa jumlah dan status soal. Gunakan soal disetujui dari mapel ujian.',
    invalid_participants: 'Periksa kelas dan status peserta yang dipilih.',
    exam_state: 'Status ujian atau percobaan belum memungkinkan tindakan ini. Muat ulang data ujian.',
    results_pending: 'Masih ada percobaan atau susulan yang belum selesai. Muat ulang dan periksa finalisasi.',
    makeup_exists: 'Hak susulan siswa ini sudah ditugaskan. Buka paket susulan untuk melihatnya.',
    makeup_package: 'Pilih paket susulan terbit dengan soal berbeda, mapel dan angkatan yang sesuai, serta kelas siswa.',
    account_not_found: 'Akun email tersebut belum ada di Supabase Auth.',
    last_admin: 'Setidaknya satu admin aktif harus tetap memiliki akses.',
  };
  if (Object.hasOwn(specific, code)) return specific[code];
  if (/jwt|auth|access_denied|forbidden|permission|not authorized|akses ditolak/.test(code)) {
    return 'Akses tidak tersedia. Periksa sesi dan penugasan akun Anda.';
  }
  if (/overlap|bertumpang|tumpang tindih|23p01/.test(code)) return 'Jadwal bertumpang tindih. Ubah jam atau tanggal sebelum menyimpan.';
  if (/duplicate|23505|already|sudah/.test(code)) return 'Data sudah ada atau statusnya telah berubah. Muat ulang tampilan dan periksa kembali.';
  if (/network|fetch|connection|failed to reach|timeout/.test(code)) return 'Koneksi terputus. Periksa status data sebelum mengulangi tindakan.';
  if (/version|versi/.test(code)) return 'Versi sudah berubah. Muat ulang data ujian sebelum mengoreksi.';
  if (/not found|tidak ditemukan/.test(code)) return 'Data tidak ditemukan dalam cakupan akun Anda.';
  if (/invalid|validasi|required|wajib|tidak valid|tidak sesuai/.test(code)) return 'Data belum sesuai. Periksa isian dan status ujian sebelum mencoba lagi.';
  return 'Tindakan belum dapat diselesaikan. Periksa jadwal, status, serta hak akses, lalu coba lagi.';
}

export function mountStaff(root, api) {
  const pane = document.createElement('section');
  pane.className = 'cbt-staff staff-stack';
  root.replaceChildren(pane);
  let dash = null;
  let tab = 'home';
  let bankSubject = '';
  let bankRows = [];
  let questionId = null;
  let examId = '';
  let examMode = 'list';
  let detail = null;
  let publishRows = [];
  let selectedClass = '';
  let makeupId = '';
  let participantEdit = null;
  let shownTokens = [];
  let editingStaffId = '';
  let busy = false;
  let notice = null;
  let loginDenied = false;
  let loginMode = 'login';
  let recoveryMode = Boolean(api.isRecovery?.());
  let resetEmail = '';

  const call = async (action, data = {}) => {
    const result = await api.rpc('cbt_staff', { p_action: action, p_data: data });
    if (result?.ok === false) throw new Error(result.code || result.error || '');
    return result;
  };

  function flash(message, kind = 'info') {
    notice = { message, kind };
    const box = pane.querySelector('.staff-notice');
    if (box) {
      box.dataset.kind = kind;
      box.textContent = message;
      if (kind === 'error' && pane.isConnected) box.focus();
    }
  }

  function noticeMarkup() {
    return `<p class="staff-notice" role="status" aria-live="polite" tabindex="-1" data-kind="${notice?.kind ?? 'info'}">${esc(notice?.message)}</p>`;
  }

  function renderLogin() {
    const recovering = recoveryMode && api.updatePassword;
    const requesting = !recovering && loginMode === 'reset' && api.resetPassword;
    pane.innerHTML = `<div class="staff-panel staff-login staff-stack">
      <div class="staff-title"><span class="staff-kicker">Ruang staf</span>
        <h1 tabindex="-1">${recovering ? 'Atur kata sandi baru' : requesting ? 'Pulihkan akun guru' : 'Masuk sebagai guru'}</h1>
        <p>${recovering ? 'Pilih kata sandi baru untuk akun sekolah Anda.'
          : requesting ? 'Kami akan mengirim tautan pemulihan jika alamat email terdaftar.'
          : 'Kelola soal, jadwal, dan hasil ujian melalui akun sekolah.'}</p></div>
      ${noticeMarkup()}
      ${recovering ? `<form class="staff-form" data-form="recover">
        ${field('Kata sandi baru', '<input name="password" type="password" autocomplete="new-password" minlength="8" required>')}
        ${field('Ulangi kata sandi baru', '<input name="confirm_password" type="password" autocomplete="new-password" minlength="8" required>')}
        ${submit('Simpan kata sandi')}
      </form>` : `<form class="staff-form" data-form="${requesting ? 'reset' : 'login'}">
        ${field('Email akun sekolah', `<input name="email" type="email" autocomplete="username" required maxlength="254" value="${esc(resetEmail)}">`)}
        ${requesting ? submit('Kirim tautan pemulihan') : `
          ${field('Kata sandi', '<input name="password" type="password" autocomplete="current-password" required>')}
          ${submit('Masuk')}`}
      </form>
      ${api.resetPassword ? btn(requesting ? 'login-mode' : 'reset-mode', requesting ? 'Kembali ke login' : 'Lupa kata sandi?') : ''}`}
      <small>Hubungi admin sekolah untuk mengaktifkan akun atau memulihkan akses.</small>
    </div>`;
  }

  function subjectOptions(current, placeholder = '') {
    return (placeholder ? opt('', placeholder, current) : '') + dash.subjects.map((item) => opt(item.id, item.name, current)).join('');
  }

  const subjectName = (id) => dash.subjects.find((item) => item.id === id)?.name || 'Mapel';
  const isAdmin = () => dash.profile.role === 'admin';
  const activeSlots = () => dash.slots.filter((slot) => slot.is_active);

  function home() {
    const visibleExams = dash.exams.filter((exam) => !exam.makeup_only);
    return `<section class="staff-panel staff-section">
      ${title('Ringkasan', 'Lihat cakupan akun dan buka ujian yang sedang Anda kelola.')}
      <div class="staff-grid">
        <div class="staff-card"><div class="staff-count">${dash.subjects.length}</div><small>Mata pelajaran</small></div>
        <div class="staff-card"><div class="staff-count">${dash.classes.length}</div><small>Kelas dalam akses</small></div>
        <div class="staff-card"><div class="staff-count">${visibleExams.filter((exam) => exam.status === 'draft').length}</div><small>Ujian reguler draf</small></div>
        <div class="staff-card"><div class="staff-count">${visibleExams.filter((exam) => exam.status === 'published').length}</div><small>Ujian reguler terbit</small></div>
      </div>
      <div class="staff-actions">${btn('new-exam', 'Buat ujian', '', 'staff-btn-primary')}${btn('tab', 'Tinjau bank soal', 'bank')}</div>
    </section>
    <section class="staff-panel staff-section">
      ${title('Mata pelajaran')}
      <div class="staff-grid">
        ${dash.subjects.map((subject) => `<article class="staff-card staff-item"><h3>${esc(subject.name)}</h3>
          <div>${btn('subject', 'Buka bank soal', subject.id)}</div></article>`).join('') || noRows('Belum ada mata pelajaran.')}
      </div>
    </section>
    <section class="staff-panel staff-section">
      ${title('Kelas', 'Ringkasan siswa aktif berdasarkan penugasan akun Anda.')}
      <div class="staff-grid">${dash.classes.map((row) => `<div class="staff-card"><strong>${esc(row.class_code)}</strong>
        <br><small>${esc(row.count)} siswa · Angkatan ${esc(row.grade_level)}</small></div>`).join('') || noRows('Belum ada kelas yang ditugaskan.')}</div>
    </section>`;
  }

  function bank() {
    const approved = bankRows.filter((row) => row.review_status === 'approved').length;
    const draft = bankRows.filter((row) => row.review_status === 'draft').length;
    const question = bankRows.find((row) => row.id === questionId);
    const edit = questionId !== null;
    return `<section class="staff-panel staff-section">
      ${title('Bank soal', 'Tinjau naskah dan kunci. Ujian hanya dapat memakai soal yang disetujui.')}
      ${field('Mata pelajaran', `<select name="bank_subject">${subjectOptions(bankSubject, 'Pilih mata pelajaran')}</select>`)}
      ${bankSubject ? `<div class="staff-actions">
        ${badge(`${approved} disetujui`, 'ready')}${badge(`${draft} draf`)}
        ${btn('question-add', 'Tambah soal', '', 'staff-btn-primary')}
      </div>` : ''}
    </section>
    ${edit && bankSubject ? questionForm(question) : ''}
    ${bankSubject ? `<section class="staff-panel staff-list" aria-label="Daftar soal">
      ${bankRows.map((row) => `<details class="staff-item staff-detail">
        <summary><span>Soal ${esc(row.question_number)}</span> ${badge(row.review_status, row.review_status === 'approved' ? 'ready' : 'quiet')}</summary>
        <div class="staff-stack">
          <small>Cakupan ${esc(row.grade_scope)}</small>
          ${questionContent(row)}
          <div class="staff-actions">${btn('question-edit', 'Edit atau tinjau', row.id)}
            ${row.review_status === 'draft' ? btn('question-approve', 'Setujui soal', row.id, 'staff-btn-primary') : ''}
            ${row.review_status !== 'archived' ? btn('question-archive', 'Pensiunkan soal', row.id, 'staff-btn-danger') : ''}</div>
        </div>
      </details>`).join('') || noRows('Belum ada soal untuk mata pelajaran ini.')}
    </section>` : ''}`;
  }

  function questionForm(row) {
    return `<section class="staff-panel staff-section" id="staff-question-editor">
      ${title(row ? 'Edit soal' : 'Tambah soal', 'Pilih satu kunci A–D. Paket ujian yang sudah terbit menyimpan versi sendiri.')}
      <form class="staff-form" data-form="question">
        ${field('Naskah soal', `<textarea name="prompt" required maxlength="10000">${esc(row?.prompt)}</textarea>`)}
        <div class="staff-grid-wide">${OPTION_KEYS.map((key) => field(`Opsi ${key}`, `<textarea name="option_${key}" required maxlength="1500">${esc(row?.options?.[key])}</textarea>`)).join('')}</div>
        <div class="staff-grid">
          ${field('Kunci jawaban', `<select name="correct_option" required>${opt('', 'Pilih kunci', row?.correct_option)}${OPTION_KEYS.map((key) => opt(key, key, row?.correct_option)).join('')}</select>`)}
          ${field('Cakupan angkatan', `<input name="grade_scope" value="${esc(row?.grade_scope ?? 'X–XII')}" required maxlength="80">`)}
          ${field('Bobot', `<input type="number" name="weight" value="${esc(row?.weight ?? 1)}" required min="0.01" max="100" step="0.01">`)}
          ${field('Status tinjauan', `<select name="review_status">${['draft', 'approved', 'archived'].map((s) => opt(s, label(s), row?.review_status ?? 'draft')).join('')}</select>`)}
        </div>
        ${field('Tautan ilustrasi HTTPS (opsional)', `<input type="url" name="image_url" value="${esc(row?.image_url)}" maxlength="2048" pattern="https://.+"><small>Gunakan tautan gambar sekolah yang dapat dibuka siswa.</small>`)}
        <div class="staff-actions">${submit('Simpan soal')}${btn('question-cancel', 'Batal')}</div>
      </form>
    </section>`;
  }

  function scheduleFields(value, withSlot = false) {
    return `<div class="staff-grid">
      ${withSlot ? field('Slot jadwal (opsional)', `<select name="slot_id">${opt('', 'Atur jam sendiri', value?.slot_id ?? '')}
        ${activeSlots().map((slot) => opt(slot.id, `${slot.label} · ${slot.start_time.slice(0, 5)}–${slot.end_time.slice(0, 5)}`, value?.slot_id)).join('')}</select>
        <small>Pilih slot untuk mengisi jam pada tanggal yang dipilih.</small>`) : ''}
      ${field('Buka (WIB)', `<input type="datetime-local" name="opens_at" value="${esc(localWib(value?.opens_at))}" required>`)}
      ${field('Tutup (WIB)', `<input type="datetime-local" name="closes_at" value="${esc(localWib(value?.closes_at))}" required>`)}
      ${field('Durasi per siswa (menit)', `<input type="number" name="duration_minutes" min="1" max="240" value="${esc(value?.duration_minutes ?? 90)}" required><small>Durasi berjalan sejak siswa mulai dan berakhir paling lambat saat jadwal tutup.</small>`)}
    </div>`;
  }

  function examEditor() {
    const exam = examMode === 'edit' ? detail.exam : null;
    const grade = exam?.grade_level ?? GRADES.find((g) => dash.classes.some((c) => String(c.grade_level) === g)) ?? '10';
    const locked = exam?.status === 'published';
    const kind = exam?.makeup_only ? 'makeup' : 'regular';
    return `<section class="staff-panel staff-section">
      ${title(exam ? 'Edit ujian' : 'Buat ujian', 'Jadwal menggunakan WIB. Tentukan durasi pengerjaan di dalam rentang buka dan tutup.')}
      <form class="staff-form" data-form="exam">
        ${locked ? `<p>${esc(exam.title)} · ${esc(subjectName(exam.subject_id))} · ${esc(exam.classes.join(', '))}</p>` : `
          ${field('Nama ujian', `<input name="title" required maxlength="160" value="${esc(exam?.title)}">`)}
          <div class="staff-grid">
            ${field('Mata pelajaran', `<select name="subject_id" required>${subjectOptions(exam?.subject_id, 'Pilih mata pelajaran')}</select>`)}
            ${field('Angkatan', `<select name="grade_level">${GRADES.map((g, i) => opt(g, ['X', 'XI', 'XII'][i], grade)).join('')}</select>`)}
            ${field('Jenis paket', `<select name="package_kind">${opt('regular', 'Ujian reguler', kind)}${opt('makeup', 'Paket susulan', kind)}</select>
              <small>Paket susulan mendapat peserta melalui penugasan per siswa.</small>`)}
            ${field('Jumlah soal', `<input type="number" name="question_count" min="1" max="40" required value="${esc(exam?.question_count ?? 40)}">`)}
          </div>
          <fieldset class="staff-checks"><legend>Kelas</legend><div data-class-options>${classOptions(dash.classes, exam?.classes, grade)}</div></fieldset>
        `}
        ${scheduleFields(exam, true)}
        <div class="staff-actions">${submit('Simpan ujian')}${btn('exam-cancel', 'Batal')}</div>
      </form>
    </section>`;
  }

  function exams() {
    if (examMode === 'create' || examMode === 'edit') return examEditor();
    if (examMode === 'detail' && detail) return examDetail();
    return `<section class="staff-panel staff-section">
      ${title('Ujian', 'Kelola paket reguler dan paket susulan yang terpisah.')}
      <div class="staff-actions">${btn('new-exam', 'Buat ujian', '', 'staff-btn-primary')}${btn('reload', 'Muat ulang')}</div>
      <div class="staff-list">${dash.exams.map((exam) => `<article class="staff-card staff-item">
        <div class="staff-item-top"><h3>${esc(exam.title)}</h3>${badge(exam.status, exam.status === 'published' ? 'ready' : 'quiet')}</div>
        <small>${esc(subjectName(exam.subject_id))} · ${esc(exam.classes.join(', '))} · ${exam.makeup_only ? 'Paket susulan' : 'Reguler'}</small>
        <p>${esc(stamp(exam.opens_at))} · ${esc(exam.duration_minutes)} menit · ${esc(exam.question_count)} soal</p>
        <div>${btn('exam-open', 'Kelola ujian', exam.id)}</div>
      </article>`).join('') || noRows('Belum ada ujian. Buat draf dari bank soal untuk memulai.')}</div>
    </section>`;
  }

  function publisher(exam) {
    return `<section class="staff-panel staff-section">
      ${title('Pilih naskah ujian', `Pilih tepat ${exam.question_count} soal yang disetujui. Naskah dan kunci dikunci saat terbit.`)}
      ${publishRows.length >= exam.question_count ? `<form class="staff-form" data-form="publish">
        <fieldset class="staff-checks"><legend>Soal tersedia</legend>
        ${publishRows.map((q) => `<label class="staff-check"><input type="checkbox" name="question_ids" value="${esc(q.id)}">
          <span>${esc(q.question_number)} · ${esc(q.prompt)}</span></label>`).join('')}
        </fieldset>
        <p class="staff-muted" data-selected-count aria-live="polite">0 dipilih dari ${esc(exam.question_count)} soal</p>
        <div class="staff-actions">${btn('select-first', `Pilih ${exam.question_count} pertama`)}${submit('Terbitkan ujian')}</div>
      </form>` : `<p class="staff-muted">Tersedia ${publishRows.length} dari ${esc(exam.question_count)} soal. Tinjau atau tambahkan soal di bank terlebih dahulu.</p>
      <div>${btn('subject', 'Buka bank soal', exam.subject_id)}</div>`}
    </section>`;
  }

  function tokenPanel() {
    if (!shownTokens.length) return '';
    return `<section class="staff-panel staff-section" id="staff-token-panel">
      ${title('Token individual', 'Bagikan token secara pribadi kepada siswa yang bersangkutan. Token hanya ditampilkan di layar ini setelah dibuat.')}
      <div class="staff-actions">${btn('tokens-hide', 'Tutup token')}</div>
      <div class="staff-list">${shownTokens.map((entry, i) => `<div class="staff-item">
        <strong>${esc(entry.full_name)} · ${esc(entry.nis)} · ${esc(entry.class_code)}</strong>
        <code class="staff-token">${esc(entry.token)}</code>
        <div>${btn('token-copy', 'Salin token', i)}</div>
      </div>`).join('')}</div>
    </section>`;
  }

  function makeupForm(regular, exam) {
    const candidates = dash.exams.filter((candidate) =>
      candidate.id !== exam.id && candidate.makeup_only && candidate.status === 'published' &&
      candidate.subject_id === exam.subject_id && candidate.grade_level === exam.grade_level &&
      candidate.classes.includes(regular.class_code));
    return `<section class="staff-panel staff-section" id="staff-makeup-editor">
      ${title('Tugaskan ujian susulan', `${regular.full_name} · ${regular.class_code}`)}
      ${candidates.length ? `<form class="staff-form" data-form="makeup">
        ${field('Paket susulan terbit', `<select name="exam_id" required>${opt('', 'Pilih paket', '')}
          ${candidates.map((candidate) => opt(candidate.id, candidate.title)).join('')}</select>
          <small>Waktu susulan harus berada di dalam jadwal paket ini.</small>`)}
        ${scheduleFields(null)}
        ${field('Alasan penugasan', '<textarea name="reason" required minlength="3" maxlength="500"></textarea>')}
        <div class="staff-actions">${submit('Tugaskan dan buat token')}${btn('makeup-cancel', 'Batal')}</div>
      </form>` : `<p class="staff-muted">Buat dan terbitkan paket susulan berbeda untuk mapel dan angkatan ini, dengan kelas siswa tercakup.</p>
      <div>${btn('makeup-cancel', 'Tutup')}</div>`}
    </section>`;
  }

  function participantEditor(person) {
    const isExtension = participantEdit.mode === 'extend';
    const official = person.official_result === 'susulan';
    return `<section class="staff-panel staff-section" id="staff-participant-editor">
      ${title(isExtension ? 'Tambah waktu pengerjaan' : official ? 'Kembalikan hasil resmi ke reguler' : 'Tetapkan nilai susulan sebagai hasil resmi',
        `${person.full_name} · ${person.class_code}`)}
      <form class="staff-form" data-form="${participantEdit.mode}">
        ${isExtension
          ? field('Tambahan waktu (menit)', '<input name="extra_minutes" type="number" min="1" max="120" required><small>Batas tetap mengikuti jam tutup untuk siswa ini.</small>')
          : '<p class="staff-muted">Nilai dan bukti kedua percobaan tetap tersimpan di riwayat masing-masing.</p>'}
        ${field('Alasan perubahan', '<textarea name="reason" required minlength="3" maxlength="500"></textarea>')}
        <div class="staff-actions">${submit('Simpan perubahan')}${btn('participant-cancel', 'Batal')}</div>
      </form>
    </section>`;
  }

  function participantsPanel(exam) {
    const { participants = [], candidates = [] } = detail;
    const visible = participants.filter((person) => !selectedClass || person.class_code === selectedClass);
    const existingIds = new Set(participants.map((person) => person.student_id));
    const addable = candidates.filter((person) => !existingIds.has(person.id) && (!selectedClass || person.class_code === selectedClass));
    const missing = visible.filter((person) => !person.has_token && !person.submitted_at);
    const regular = participants.find((person) => person.right_id === makeupId);
    const selected = participants.find((person) => person.right_id === participantEdit?.id);
    return `
    ${regular ? makeupForm(regular, exam) : ''}
    ${selected ? participantEditor(selected) : ''}
    <section class="staff-panel staff-section">
      ${title('Peserta dan token', 'Setiap hak ikut menggunakan satu token. Penggantian token mencabut sesi lama dan mempertahankan jawaban yang sudah tersimpan.')}
      <div class="staff-actions">
        ${field('Filter kelas', `<select name="participant_class">${opt('', 'Semua kelas', selectedClass)}
          ${exam.classes.map((code) => opt(code, code, selectedClass)).join('')}</select>`)}
        ${exam.status === 'published' && missing.length ? btn('tokens-issue-missing', `Buat ${missing.length} token`, '', 'staff-btn-primary') : ''}
        ${btn('export', 'Ekspor rekap CSV')}${btn('reload-exam', 'Muat ulang')}
      </div>
      ${exam.status === 'published' && !exam.makeup_only && addable.length ? `<form class="staff-form" data-form="participant-add">
        ${field('Tambahkan peserta dari roster', `<select name="student_id" required>${opt('', 'Pilih siswa', '')}
          ${addable.map((person) => opt(person.id, `${person.full_name} · ${person.nis} · ${person.class_code}`)).join('')}</select>`)}
        <div>${submit('Tambah peserta')}</div>
      </form>` : ''}
      <p><small>${visible.length} peserta ditampilkan · ${visible.filter((p) => p.submitted_at).length} terkirim</small></p>
      <div class="staff-list">${visible.map((person) => `<article class="staff-card staff-item">
        <div class="staff-item-top"><h3>${esc(person.full_name)}</h3>${badge(ATTEMPT_STATUS[person.attempt_status] ?? 'Belum mulai', person.submitted_at ? 'ready' : 'quiet')}</div>
        <small>${esc(person.nis)} · ${esc(person.class_code)} · ${person.regular_id ? 'Susulan' : 'Reguler'} · ${person.has_token ? 'Token tersedia' : 'Tanpa token'}</small>
        ${person.reason ? `<p>${esc(person.reason)}</p>` : ''}
        ${person.deadline && !person.submitted_at ? `<small>Tenggat ${esc(stamp(person.deadline))} · Simpan terakhir ${esc(stamp(person.saved_at))}</small>` : ''}
        ${person.score != null ? `<p><strong>Nilai ${esc(person.score)}</strong> · ${esc(person.correct_count)} benar · ${esc(person.wrong_count)} salah · ${esc(person.blank_count)} kosong</p>` : ''}
        ${person.official_result ? `<small>Hasil resmi ${esc(person.official_result)}</small>` : ''}
        ${person.receipt ? `<small>Bukti ${esc(person.receipt)} · ${esc(stamp(person.submitted_at))}${SUBMIT_REASON[person.submit_reason] ? ` · ${SUBMIT_REASON[person.submit_reason]}` : ''}</small>` : ''}
        <div class="staff-actions">
          ${person.has_token ? btn('token-rotate', 'Ganti token', person.right_id) : btn('token-issue', 'Buat token', person.right_id)}
          ${person.has_token ? btn('token-revoke', 'Cabut token', person.right_id, 'staff-btn-danger') : ''}
          ${!person.regular_id && !exam.makeup_only ? btn('makeup-open', 'Tugaskan susulan', person.right_id) : ''}
          ${person.attempt_status === 'active' && Date.parse(person.deadline) < Date.parse(person.closes_at || exam.closes_at) ? btn('extend-open', 'Tambah waktu', person.right_id) : ''}
          ${person.regular_id && person.submitted_at ? btn('official-open', person.official_result === 'susulan' ? 'Pulihkan hasil reguler' : 'Pilih sebagai hasil resmi', person.right_id) : ''}
          ${!person.started_at && !person.regular_id && exam.status === 'published' ? btn('participant-remove', 'Keluarkan', person.student_id, 'staff-btn-danger') : ''}
        </div>
      </article>`).join('') || noRows('Belum ada peserta pada filter ini.')}</div>
    </section>`;
  }

  function resultsPanel(exam) {
    const ended = exam.status === 'closed' || Date.parse(exam.closes_at) <= Date.now();
    const history = detail.audit ?? [];
    const pending = detail.participants.filter((person) => person.attempt_status === 'finalizing').length;
    return `<section class="staff-panel staff-section">
      ${title('Nilai dan riwayat')}
      <p>Versi penilaian ${esc(exam.grading_version)} · ${exam.released_at ? `Dirilis ${esc(stamp(exam.released_at))}` : 'Belum dirilis ke siswa'}</p>
      ${pending ? `<p>${pending} percobaan melewati tenggat dan menunggu finalisasi.</p>
        <div>${btn('finalize', 'Finalisasi yang melewati tenggat')}</div>` : ''}
      ${ended && !exam.released_at && !pending ? `<div>${btn('release', 'Rilis nilai', '', 'staff-btn-primary')}</div>` : ''}
      ${ended && detail.questions.length ? `<details class="staff-detail"><summary>Koreksi kunci penilaian</summary>
        <form class="staff-form" data-form="correct">
          <p class="staff-muted">Koreksi membuat versi nilai baru. Rilis ulang diperlukan untuk menampilkan nilai yang dikoreksi.</p>
          <div class="staff-grid">
            ${field('Soal', `<select name="position" required>${opt('', 'Pilih nomor', '')}
              ${detail.questions.map((q) => opt(q.position, `Soal ${q.position} · Kunci naskah ${q.correct_option}`)).join('')}</select>`)}
            ${field('Kunci penilaian baru', `<select name="correct_option" required>${opt('', 'Pilih perubahan', '')}
              ${OPTION_KEYS.map((key) => opt(key, key)).join('')}${opt('cancel', 'Batalkan penilaian soal')}</select>`)}
          </div>
          ${field('Alasan koreksi', '<textarea name="reason" required minlength="3" maxlength="500"></textarea>')}
          <p class="staff-muted" data-correction-preview aria-live="polite"></p>
          <div class="staff-actions"><button class="staff-btn" type="submit" name="intent" value="preview" formnovalidate>Pratinjau dampak</button>
            ${submit('Simpan koreksi dan hitung ulang')}</div>
        </form>
      </details>` : ''}
      ${history.length ? `<details class="staff-detail"><summary>Riwayat tindakan (${history.length})</summary>
        <div class="staff-list">${history.map((row) => `<div class="staff-item">
          <p>${esc(auditLabel(row.action))} · ${esc(stamp(row.created_at))}</p>
          ${row.detail?.reason ? `<small>${esc(row.detail.reason)}</small>` : ''}
        </div>`).join('')}</div>
      </details>` : ''}
    </section>`;
  }

  function auditLabel(action) {
    return ({
      publish: 'Ujian diterbitkan',
      close: 'Ujian ditutup',
      makeup: 'Susulan ditugaskan',
      tokens: 'Token diperbarui',
      correct: 'Kunci dikoreksi',
      release: 'Nilai dirilis',
      exam_save: 'Ujian disimpan',
      participants: 'Peserta diperbarui',
      extend: 'Waktu pengerjaan ditambah',
      official: 'Hasil resmi diperbarui',
    })[action] || action;
  }

  function examDetail() {
    const { exam, questions = [] } = detail;
    const editable = exam.status === 'draft' || (exam.status === 'published' && Date.parse(exam.opens_at) > Date.now());
    return `<section class="staff-panel staff-section">
      ${title(exam.title, `${subjectName(exam.subject_id)} · ${exam.classes.join(', ')} · ${exam.makeup_only ? 'Paket susulan' : 'Reguler'}`)}
      <p>${esc(stamp(exam.opens_at))} sampai ${esc(stamp(exam.closes_at))}</p>
      <p>${esc(exam.duration_minutes)} menit per siswa · ${esc(exam.question_count)} soal</p>
      <div class="staff-actions">${badge(exam.status, exam.status === 'published' ? 'ready' : 'quiet')}
        ${btn('exam-list', 'Daftar ujian')}${editable ? btn('exam-edit', 'Edit ujian') : ''}
        ${exam.status === 'published' && Date.parse(exam.closes_at) > Date.now() ? btn('close-exam', 'Tutup ujian', '', 'staff-btn-danger') : ''}
      </div>
    </section>
    ${exam.status === 'draft' ? publisher(exam) : `
      ${tokenPanel()}
      ${resultsPanel(exam)}
      ${participantsPanel(exam)}
      <section class="staff-panel staff-section">
        ${title('Pratinjau naskah terbit', 'Kunci di bagian ini adalah kunci asli pada naskah yang dikunci saat terbit.')}
        ${questions.map((question) => `<details class="staff-item staff-detail"><summary>Soal ${esc(question.position)}</summary>${questionContent(question)}</details>`).join('')}
      </section>
    `}`;
  }

  function slots() {
    return `<section class="staff-panel staff-section">
      ${title('Slot sesi (WIB)', isAdmin() ? 'Ubah template jam untuk jadwal baru. Jadwal ujian yang sudah dibuat tetap tersimpan.' : 'Template slot tersedia saat membuat jadwal ujian. Hubungi admin untuk mengubah template.')}
      <div class="staff-grid-wide">${dash.slots.map((slot) => `<article class="staff-card staff-section">
        ${isAdmin() ? `<form class="staff-form" data-form="slot" data-id="${esc(slot.id)}">
          <h3>Slot ${esc(slot.id)}</h3>
          ${field('Nama slot', `<input name="label" value="${esc(slot.label)}" maxlength="50" required>`)}
          <div class="staff-grid">
            ${field('Mulai (WIB)', `<input name="start_time" type="time" value="${esc(slot.start_time.slice(0, 5))}" required>`)}
            ${field('Selesai (WIB)', `<input name="end_time" type="time" value="${esc(slot.end_time.slice(0, 5))}" required>`)}
          </div>
          ${field('Status slot', `<select name="is_active">${opt('true', 'Aktif', String(slot.is_active))}${opt('false', 'Nonaktif', String(slot.is_active))}</select>`)}
          <div>${submit('Simpan slot')}</div>
        </form>` : `<h3>${esc(slot.label)}</h3><p>${esc(slot.start_time.slice(0, 5))}–${esc(slot.end_time.slice(0, 5))} WIB</p>
          ${badge(slot.is_active ? 'Aktif' : 'Nonaktif', slot.is_active ? 'ready' : 'quiet')}`}
      </article>`).join('')}</div>
    </section>`;
  }

  function access() {
    const staff = dash.staff ?? [];
    const row = staff.find((person) => person.user_id === editingStaffId);
    return `<section class="staff-panel staff-section">
      ${title('Akses staf', 'Buat akun di Supabase Auth terlebih dahulu. Tetapkan peran dan kelasnya di sini.')}
      <div class="staff-list">${staff.map((person) => `<article class="staff-card staff-item">
        <div class="staff-item-top"><h3>${esc(person.display_name)}</h3>${badge(person.is_active ? person.role : 'Nonaktif', person.is_active ? 'ready' : 'quiet')}</div>
        <p>${esc(person.email)}</p><small>${person.role === 'admin' ? 'Semua kelas' : esc(person.classes.join(', ') || 'Belum ada penugasan kelas')}</small>
        <div>${btn('staff-edit', 'Edit akses', person.user_id)}</div>
      </article>`).join('') || noRows('Belum ada daftar staf.')}</div>
    </section>
    <section class="staff-panel staff-section" id="staff-access-editor">
      ${title(row ? 'Edit akses staf' : 'Tetapkan akses staf')}
      <form class="staff-form" data-form="access">
        ${field('Email akun Supabase Auth', `<input name="email" type="email" maxlength="254" value="${esc(row?.email)}" ${row ? 'readonly' : 'required'}>`)}
        ${field('Nama tampilan', `<input name="display_name" maxlength="120" value="${esc(row?.display_name)}" required>`)}
        <div class="staff-grid">
          ${field('Peran', `<select name="role">${opt('teacher', 'Guru', row?.role ?? 'teacher')}${opt('admin', 'Admin', row?.role ?? 'teacher')}</select>`)}
          ${field('Status', `<select name="is_active">${opt('true', 'Aktif', String(row?.is_active ?? true))}${opt('false', 'Nonaktif', String(row?.is_active ?? true))}</select>`)}
        </div>
        <fieldset class="staff-checks" data-staff-classes${row?.role === 'admin' ? ' hidden' : ''}><legend>Kelas yang dikelola guru</legend>
          ${classOptions(dash.classes, row?.classes)}</fieldset>
        <div class="staff-actions">${submit('Simpan akses')}${row ? btn('staff-cancel', 'Batal') : ''}</div>
      </form>
    </section>`;
  }

  function render(focus = false) {
    if (!pane.isConnected) return;
    if (!dash || recoveryMode) {
      renderLogin();
      if (focus) pane.querySelector('h1').focus({ preventScroll: true });
      return;
    }
    const tabs = [['home', 'Ringkasan'], ['bank', 'Bank soal'], ['exams', 'Ujian'], ['slots', 'Jadwal']];
    if (isAdmin()) tabs.push(['access', 'Akses staf']);
    pane.innerHTML = `<div class="staff-head">
      <div class="staff-title"><span class="staff-kicker">Ruang staf · ${esc(label(dash.profile.role))}</span>
        <h1 tabindex="-1">Portal guru</h1>
        <p>${esc(dash.profile.display_name)}</p></div>
      <div>${btn('logout', 'Keluar')}</div>
    </div>
    <nav class="staff-nav" aria-label="Menu portal guru">
      ${tabs.map(([id, text]) => `<button type="button" class="staff-btn" data-act="tab" data-id="${id}"${tab === id ? ' aria-current="page"' : ''}>${text}</button>`).join('')}
    </nav>
    ${noticeMarkup()}
    ${({ home, bank, exams, slots, access })[tab]()}
    `;
    if (focus) pane.querySelector('h1').focus({ preventScroll: true });
  }

  async function loadDashboard() {
    const next = await call('dashboard');
    if (!next?.profile || !['admin', 'teacher'].includes(next.profile.role)) throw new Error('access_denied');
    dash = next;
    dash.subjects ??= [];
    dash.classes ??= [];
    dash.slots ??= [];
    dash.exams ??= [];
  }

  async function loadBank(subject) {
    const nextRows = subject ? await call('bank', { subject_id: subject }) : [];
    bankSubject = subject;
    bankRows = nextRows;
    questionId = null;
  }

  async function loadExam(id, resetClass = false) {
    const next = await call('exam_detail', { exam_id: id });
    const questions = next.exam.status === 'draft' ? await call('bank', { subject_id: next.exam.subject_id }) : [];
    publishRows = questions.filter((question) => question.review_status === 'approved');
    detail = next;
    examId = id;
    examMode = 'detail';
    if (resetClass) selectedClass = '';
  }

  async function setTab(next) {
    if (next === 'bank' && !bankSubject) await loadBank(dash.subjects[0]?.id || '');
    if (next !== 'exams') shownTokens = [];
    tab = next;
  }

  function focusEditor(id) {
    requestAnimationFrame(() => pane.querySelector(`#${id} :is(input:not([type="hidden"]), textarea, select, button)`)?.focus());
  }

  function schedule(data) {
    const opensAt = absoluteWib(data.get('opens_at'));
    const closesAt = absoluteWib(data.get('closes_at'));
    const duration = Number(data.get('duration_minutes'));
    if (localWib(opensAt).slice(0, 10) !== localWib(closesAt).slice(0, 10) ||
      Date.parse(closesAt) - Date.parse(opensAt) < duration * 60000) {
      throw new Error('invalid_schedule');
    }
    return { opens_at: opensAt, closes_at: closesAt, duration_minutes: duration };
  }

  function existingQuestion(row, reviewStatus) {
    return {
      id: row.id,
      subject_id: bankSubject,
      grade_scope: row.grade_scope,
      prompt: row.prompt,
      options: row.options,
      correct_option: row.correct_option,
      review_status: reviewStatus,
      weight: row.weight ?? 1,
      image_url: row.image_url ?? null,
    };
  }

  async function updateTokens(ids, mode) {
    const result = await call('tokens', { exam_id: examId, right_ids: ids, mode });
    shownTokens = Array.isArray(result) ? result : [];
    render();
    try { await loadExam(examId); } catch { notice = { message: 'Token diproses. Muat ulang daftar peserta untuk memperbarui status.', kind: 'info' }; }
    if (shownTokens.length) focusEditor('staff-token-panel');
  }

  async function processAction(action, id) {
    switch (action) {
      case 'logout':
        await api.signOut();
        dash = null;
        detail = null;
        bankRows = [];
        publishRows = [];
        bankSubject = '';
        questionId = null;
        examId = '';
        examMode = 'list';
        selectedClass = '';
        makeupId = '';
        participantEdit = null;
        editingStaffId = '';
        shownTokens = [];
        tab = 'home';
        return;
      case 'reset-mode':
      case 'login-mode':
        resetEmail = pane.querySelector('[name="email"]')?.value || '';
        loginMode = action === 'reset-mode' ? 'reset' : 'login';
        return;
      case 'tab':
        await setTab(id);
        return;
      case 'subject':
        await loadBank(id);
        await setTab('bank');
        return;
      case 'question-add':
      case 'question-edit':
        questionId = action === 'question-add' ? '' : id;
        focusEditor('staff-question-editor');
        return;
      case 'question-cancel':
        questionId = null;
        return;
      case 'question-approve':
      case 'question-archive': {
        const row = bankRows.find((item) => item.id === id);
        if (!row) return;
        if (action === 'question-archive' && !confirm('Pensiunkan soal ini dari pilihan naskah baru?')) return false;
        await call('question_save', existingQuestion(row, action === 'question-approve' ? 'approved' : 'archived'));
        await loadBank(bankSubject);
        flash(action === 'question-approve' ? 'Soal disetujui.' : 'Soal dipensiunkan.');
        return;
      }
      case 'new-exam':
        tab = 'exams';
        examMode = 'create';
        shownTokens = [];
        return;
      case 'exam-cancel':
        examMode = examMode === 'edit' ? 'detail' : 'list';
        return;
      case 'exam-list':
        examMode = 'list';
        detail = null;
        shownTokens = [];
        makeupId = '';
        participantEdit = null;
        return;
      case 'exam-open':
        await loadExam(id, true);
        shownTokens = [];
        makeupId = '';
        participantEdit = null;
        return;
      case 'exam-edit':
        examMode = 'edit';
        return;
      case 'reload':
        await loadDashboard();
        flash('Data diperbarui.');
        return;
      case 'reload-exam':
        await loadExam(examId);
        flash('Data ujian diperbarui.');
        return;
      case 'select-first': {
        const inputs = [...pane.querySelectorAll('input[name="question_ids"]')];
        inputs.forEach((input, i) => { input.checked = i < detail.exam.question_count; });
        updateSelection();
        return false;
      }
      case 'close-exam':
        if (!confirm('Tutup ujian sekarang dan finalisasi jawaban yang sudah tersimpan?')) return false;
        await call('close', { exam_id: examId });
        await loadDashboard();
        await loadExam(examId);
        flash('Ujian ditutup. Muat ulang untuk memeriksa finalisasi.');
        return;
      case 'participant-remove':
        if (!confirm('Keluarkan peserta dari ujian ini?')) return false;
        await call('participants', { exam_id: examId, student_ids: [id], enabled: false });
        await loadExam(examId);
        flash('Peserta dikeluarkan.');
        return;
      case 'tokens-issue-missing': {
        const ids = detail.participants.filter((p) => !p.has_token && !p.submitted_at && (!selectedClass || p.class_code === selectedClass)).map((p) => p.right_id);
        if (!ids.length) return false;
        await updateTokens(ids, 'issue');
        return;
      }
      case 'token-issue':
      case 'token-rotate':
      case 'token-revoke': {
        const mode = action.slice('token-'.length);
        if (mode !== 'issue' && !confirm(mode === 'rotate'
          ? 'Ganti token dan cabut sesi lama siswa ini?'
          : 'Cabut token dan akses siswa ini sampai token baru dibuat?')) return false;
        await updateTokens([id], mode);
        if (mode === 'revoke') flash('Token dicabut.');
        return;
      }
      case 'tokens-hide':
        shownTokens = [];
        return;
      case 'token-copy':
        if (!shownTokens[Number(id)]?.token) return false;
        await navigator.clipboard.writeText(shownTokens[Number(id)].token);
        flash('Token disalin.');
        return false;
      case 'makeup-open':
        makeupId = id;
        participantEdit = null;
        focusEditor('staff-makeup-editor');
        return;
      case 'makeup-cancel':
        makeupId = '';
        return;
      case 'extend-open':
      case 'official-open':
        makeupId = '';
        participantEdit = { id, mode: action.replace('-open', '') };
        focusEditor('staff-participant-editor');
        return;
      case 'participant-cancel':
        participantEdit = null;
        return;
      case 'finalize': {
        const result = await call('finalize', { exam_id: examId });
        await loadExam(examId);
        flash(`${result.count} percobaan difinalisasi.`);
        return;
      }
      case 'release':
        if (!confirm('Tampilkan nilai versi saat ini kepada siswa?')) return false;
        await call('release', { exam_id: examId });
        await loadDashboard();
        await loadExam(examId);
        flash('Nilai dirilis.');
        return;
      case 'export':
        exportCsv(detail.participants.filter((p) => !selectedClass || p.class_code === selectedClass));
        flash('Rekap CSV disiapkan untuk diunduh.');
        return false;
      case 'staff-edit':
        editingStaffId = id;
        focusEditor('staff-access-editor');
        return;
      case 'staff-cancel':
        editingStaffId = '';
        return;
      default:
        return false;
    }
  }

  async function processForm(form, data, intent) {
    const value = (key) => String(data.get(key) ?? '').trim();
    switch (form.dataset.form) {
      case 'login': {
        loginDenied = false;
        try {
          await api.signIn(value('email'), String(data.get('password')));
          await loadDashboard();
        } catch (error) {
          loginDenied = true;
          dash = null;
          await api.signOut().catch(() => {});
          form.elements.password.value = '';
          throw error;
        }
        return;
      }
      case 'reset':
        resetEmail = value('email');
        await api.resetPassword(resetEmail);
        loginMode = 'login';
        flash('Jika email terdaftar, tautan pemulihan sudah dikirim. Buka tautan di browser ini.');
        return;
      case 'recover': {
        const password = String(data.get('password'));
        if (password !== data.get('confirm_password')) {
          flash('Kedua isian kata sandi harus sama.', 'error');
          return false;
        }
        await api.updatePassword(password);
        recoveryMode = false;
        try {
          await loadDashboard();
          flash('Kata sandi baru disimpan.');
        } catch {
          dash = null;
          await api.signOut().catch(() => {});
          flash('Kata sandi baru disimpan. Periksa penugasan akun Anda sebelum masuk kembali.');
        }
        return;
      }
      case 'question': {
        await call('question_save', {
          id: questionId || undefined,
          subject_id: bankSubject,
          grade_scope: value('grade_scope'),
          prompt: value('prompt'),
          options: Object.fromEntries(OPTION_KEYS.map((key) => [key, value(`option_${key}`)])),
          correct_option: value('correct_option'),
          review_status: value('review_status'),
          weight: Number(value('weight')),
          image_url: value('image_url') || null,
        });
        await loadBank(bankSubject);
        flash('Soal disimpan.');
        return;
      }
      case 'slot': {
        await call('slot_save', {
          id: Number(form.dataset.id),
          label: value('label'),
          start_time: value('start_time'),
          end_time: value('end_time'),
          is_active: value('is_active') === 'true',
        });
        await loadDashboard();
        flash('Slot jadwal disimpan.');
        return;
      }
      case 'exam': {
        const exam = examMode === 'edit' ? detail.exam : null;
        const locked = exam?.status === 'published';
        const classes = locked ? exam.classes : data.getAll('classes');
        if (!classes.length) {
          flash('Pilih setidaknya satu kelas untuk ujian.', 'error');
          return false;
        }
        const saved = await call('exam_save', {
          id: exam?.id,
          title: locked ? exam.title : value('title'),
          subject_id: locked ? exam.subject_id : value('subject_id'),
          grade_level: locked ? exam.grade_level : Number(value('grade_level')),
          classes,
          question_count: locked ? exam.question_count : Number(value('question_count')),
          makeup_only: locked ? exam.makeup_only : value('package_kind') === 'makeup',
          slot_id: value('slot_id') ? Number(value('slot_id')) : null,
          ...schedule(data),
        });
        await loadDashboard();
        await loadExam(saved.id, true);
        flash('Ujian disimpan.');
        return;
      }
      case 'publish': {
        const ids = data.getAll('question_ids');
        if (ids.length !== detail.exam.question_count) {
          flash(`Pilih tepat ${detail.exam.question_count} soal.`, 'error');
          return false;
        }
        if (!confirm('Terbitkan paket dan kunci versi naskah sekarang?')) return false;
        await call('publish', { exam_id: examId, question_ids: ids });
        await loadDashboard();
        await loadExam(examId);
        flash('Ujian diterbitkan. Token peserta dapat dibuat dari daftar peserta.');
        return;
      }
      case 'participant-add':
        await call('participants', { exam_id: examId, student_ids: [value('student_id')], enabled: true });
        await loadExam(examId);
        flash('Peserta ditambahkan.');
        return;
      case 'makeup': {
        const person = detail.participants.find((participant) => participant.right_id === makeupId);
        if (!person) return false;
        const result = await call('makeup', {
          regular_id: makeupId,
          exam_id: value('exam_id'),
          reason: value('reason'),
          ...schedule(data),
        });
        shownTokens = result.token ? [{ ...person, token: result.token }] : [];
        makeupId = '';
        flash(result.token ? 'Susulan ditugaskan. Bagikan token baru secara pribadi.' : 'Susulan sudah ditugaskan. Kelola token di paket susulan.');
        if (result.token) focusEditor('staff-token-panel');
        return;
      }
      case 'extend':
      case 'official': {
        const person = detail.participants.find((participant) => participant.right_id === participantEdit?.id);
        if (!person) return false;
        const mode = form.dataset.form;
        const result = await call(mode, {
          exam_id: examId,
          right_id: person.right_id,
          reason: value('reason'),
          ...(mode === 'extend' ? { extra_minutes: Number(value('extra_minutes')) }
            : { is_makeup_official: person.official_result !== 'susulan' }),
        });
        participantEdit = null;
        await loadExam(examId);
        flash(mode === 'extend' ? `Tenggat diperbarui menjadi ${stamp(result.deadline)}.` : 'Hasil resmi diperbarui.');
        return;
      }
      case 'correct': {
        if (!value('position') || !value('correct_option')) {
          flash('Pilih nomor soal dan kunci penilaian baru.', 'error');
          return false;
        }
        const correction = {
          exam_id: examId,
          position: Number(value('position')),
          correct_option: value('correct_option') === 'cancel' ? null : value('correct_option'),
          reason: value('reason'),
          expected_version: detail.exam.grading_version,
        };
        if (intent === 'preview') {
          const result = await call('correction_preview', correction);
          form.querySelector('[data-correction-preview]').textContent =
            `${result.affected} dari ${result.finalized} nilai akan berubah. ${result.review} hasil perlu ditinjau.`;
          return false;
        }
        if (!confirm('Simpan koreksi, hitung ulang nilai, dan cabut rilis versi sebelumnya?')) return false;
        await call('correct', correction);
        await loadDashboard();
        await loadExam(examId);
        flash('Koreksi disimpan. Periksa hasil sebelum merilis nilai.');
        return;
      }
      case 'access':
        if (value('role') === 'teacher' && !data.getAll('classes').length) {
          flash('Tetapkan setidaknya satu kelas untuk akun guru.', 'error');
          return false;
        }
        await call('staff_save', {
          email: value('email'),
          display_name: value('display_name'),
          role: value('role'),
          classes: value('role') === 'teacher' ? data.getAll('classes') : [],
          is_active: value('is_active') === 'true',
        });
        await loadDashboard();
        editingStaffId = '';
        if (!isAdmin()) tab = 'home';
        flash('Akses staf disimpan.');
        return;
      default:
        return false;
    }
  }

  async function operate(handler, trigger, focus = false) {
    if (busy) return;
    busy = true;
    if (trigger) trigger.disabled = true;
    pane.setAttribute('aria-busy', 'true');
    flash('');
    try {
      const shouldRender = await handler();
      if (shouldRender !== false) render(focus);
    } catch (error) {
      flash(loginDenied ? 'Gagal masuk. Periksa email, kata sandi, atau penugasan akun.' : explainError(error), 'error');
      loginDenied = false;
    } finally {
      busy = false;
      if (trigger) trigger.disabled = false;
      pane.removeAttribute('aria-busy');
    }
  }

  function updateSelection() {
    const count = pane.querySelector('[data-selected-count]');
    if (count) count.textContent = `${pane.querySelectorAll('input[name="question_ids"]:checked').length} dipilih dari ${detail.exam.question_count} soal`;
  }

  pane.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const { act, id } = button.dataset;
    void operate(() => processAction(act, id), button, ['tab', 'subject', 'exam-open', 'exam-list', 'reset-mode', 'login-mode', 'logout'].includes(act));
  });
  pane.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    void operate(() => processForm(event.target, data, event.submitter?.value), event.submitter,
      ['login', 'reset', 'recover'].includes(event.target.dataset.form));
  });
  pane.addEventListener('change', (event) => {
    const input = event.target;
    const name = input.name;
    if (name === 'bank_subject') {
      const previous = bankSubject;
      void operate(async () => {
        try { await loadBank(input.value); } catch (error) { input.value = previous; throw error; }
      }, input);
    }
    if (name === 'grade_level') {
      input.form.querySelector('[data-class-options]').innerHTML = classOptions(dash.classes, [], input.value);
    }
    if (name === 'slot_id' && input.value) {
      const slot = activeSlots().find((row) => String(row.id) === input.value);
      const start = input.form.elements.opens_at;
      const end = input.form.elements.closes_at;
      const date = start.value.slice(0, 10) || localWib(new Date()).slice(0, 10);
      start.value = `${date}T${slot.start_time.slice(0, 5)}`;
      end.value = `${date}T${slot.end_time.slice(0, 5)}`;
    }
    if (name === 'exam_id' && input.form?.dataset.form === 'makeup' && input.value) {
      const selected = dash.exams.find((item) => item.id === input.value);
      input.form.elements.opens_at.value = localWib(selected.opens_at);
      input.form.elements.closes_at.value = localWib(selected.closes_at);
      input.form.elements.duration_minutes.value = selected.duration_minutes;
    }
    if (name === 'participant_class' && !busy) {
      selectedClass = input.value;
      render();
      pane.querySelector('[name="participant_class"]').focus();
    }
    if (input.form?.dataset.form === 'correct' && ['position', 'correct_option'].includes(name)) {
      input.form.querySelector('[data-correction-preview]').textContent = '';
    }
    if (name === 'question_ids') updateSelection();
    if (name === 'role' && input.form?.dataset.form === 'access') {
      input.form.querySelector('[data-staff-classes]').hidden = input.value === 'admin';
    }
  });

  pane.innerHTML = '<p class="staff-panel" role="status">Memeriksa sesi guru…</p>';
  const stopRecovery = api.onRecovery?.(() => {
    if (!pane.isConnected) return;
    recoveryMode = true;
    notice = null;
    shownTokens = [];
    render(true);
  });
  void (async () => {
    try {
      const session = await api.getSession();
      recoveryMode ||= Boolean(api.isRecovery?.());
      if (session && !recoveryMode) await loadDashboard();
    } catch {
      dash = null;
      notice = { kind: 'error', message: 'Sesi guru belum dapat digunakan. Silakan masuk kembali.' };
    }
    render();
  })();
  return () => {
    stopRecovery?.();
    pane.remove();
  };
}

