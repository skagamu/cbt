const escape = (value = '') => String(value ?? '').replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const wib = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' });
const clock = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', timeStyle: 'medium' });
const storageKey = 'skagamu-student';
const letters = ['A', 'B', 'C', 'D'];
const date = (value) => value ? `${wib.format(new Date(value))} WIB` : '—';
const read = (storage, key) => {
  try { return JSON.parse(window[storage].getItem(key)); } catch { return null; }
};
const write = (storage, key, value) => {
  try {
    if (value === null) window[storage].removeItem(key);
    else window[storage].setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
};

export function mountStudent(root, rpc) {
  const lifetime = new AbortController();
  let credentials = read('sessionStorage', storageKey);
  let device = credentials?.device || crypto.randomUUID();
  let session = credentials?.session;
  let unlock;
  let state;
  let pending = {};
  let storageAvailable = true;
  let question = 1;
  let offset = 0;
  let busy = false;
  let saveTimer;
  let retry = 0;
  let finalizing = false;
  let queuedSubmit = false;
  let autoCheckAfter = 0;
  let uncertain = false;
  let notice = '';
  let noticeKind = '';
  let init = true;
  const scope = lifetime.signal;

  function draftKey(current = state) {
    return current ? `${storageKey}:draft:${current.right_id}:${device}:${current.write_epoch}` : '';
  }
  function persist() {
    if (state?.status !== 'active') return;
    storageAvailable = write('localStorage', draftKey(), { answers: pending, question });
  }
  function releaseDraft(current) {
    if (current?.status === 'active') write('localStorage', draftKey(current), null);
  }
  function sessionRecord() {
    storageAvailable = write('sessionStorage', storageKey, { device, session }) && storageAvailable;
  }
  function clearSave() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  function reset(message) {
    releaseDraft(state);
    pending = {};
    session = undefined;
    state = undefined;
    retry = 0;
    uncertain = false;
    queuedSubmit = false;
    clearSave();
    sessionRecord();
    show(message, message ? 'warning' : '');
  }
  function show(message = '', kind = '') {
    notice = message;
    noticeKind = kind;
    render();
  }
  function secondsLeft() {
    return state?.deadline ? Math.max(0, Math.ceil((Date.parse(state.deadline) - Date.now() - offset) / 1000)) : 0;
  }
  function countdown() {
    const seconds = secondsLeft();
    const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
    return `${mins}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function ownAnswer(position) {
    return pending[position] || state?.answers?.[position];
  }
  function hasPending() {
    return Object.keys(pending).length > 0;
  }
  function canEdit() {
    return state?.writable && secondsLeft() > 0 && !finalizing && !uncertain;
  }
  function saveText() {
    if (uncertain) return 'Menunggu konfirmasi';
    if (!state?.writable) return 'Hanya lihat';
    if (busy) return 'Menyimpan…';
    if (hasPending()) return storageAvailable ? 'Draf di HP ini' : 'Belum tersimpan';
    return state?.saved_at ? `Tersimpan • ${clock.format(new Date(state.saved_at))} WIB` : 'Siap menyimpan';
  }
  function updateIndicators() {
    const time = root.querySelector('[data-timer]');
    if (time) {
      time.textContent = countdown();
      time.classList.toggle('timer-urgent', secondsLeft() <= 300);
    }
    const indicator = root.querySelector('[data-save-status]');
    if (indicator && indicator.textContent !== saveText()) {
      indicator.textContent = saveText();
      indicator.dataset.pending = String(hasPending() || uncertain);
    }
    for (const item of root.querySelectorAll('[data-needs-connection]')) item.disabled = busy || !navigator.onLine;
    for (const item of root.querySelectorAll('[data-editable]')) {
      item.disabled = !canEdit() || (item.hasAttribute('data-submit-open') && (busy || !navigator.onLine));
    }
  }

  function accept(next, { restore = false, drop = false } = {}) {
    const previous = state;
    offset = Date.parse(next.server_now) - Date.now();
    const sameLease = previous?.right_id === next.right_id && previous?.write_epoch === next.write_epoch;
    state = sameLease && next.status === 'active' ? { ...previous, ...next } : next;
    if (state.status !== 'active') {
      releaseDraft(previous);
      if (state.status === 'final') write('localStorage', draftKey(state), null);
      pending = {};
      uncertain = false;
      clearSave();
      return;
    }
    if (!sameLease || drop) {
      if (previous && (!sameLease || drop)) releaseDraft(previous);
      pending = {};
    }
    if (restore) {
      const draft = read('localStorage', draftKey());
      pending = state.writable && draft?.answers ? draft.answers : {};
      question = Math.max(1, Math.min(Number(draft?.question) || 1, state.questions.length));
    }
    let conflict = false;
    for (const [position, answer] of Object.entries(pending)) {
      const server = state.answers?.[position];
      if (server && server.revision >= answer.revision) {
        conflict ||= server.revision >= answer.revision &&
          (server.option !== answer.option || server.flagged !== answer.flagged);
        delete pending[position];
      }
    }
    if (conflict) {
      notice = 'Draf berubah di sesi lain. Jawaban terkonfirmasi dari server sudah dimuat.';
      noticeKind = 'warning';
    }
    persist();
    if (hasPending() && state.writable) scheduleSave(250);
  }

  function scheduleSave(delay = 850 + Math.random() * 450) {
    if (saveTimer || !hasPending() || !canEdit() || !navigator.onLine) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void operation('save');
    }, delay);
  }
  async function operation(action, { sync = false } = {}) {
    if (!session || scope.aborted) return;
    if (action === 'submit' && !navigator.onLine) {
      show('Koneksi terputus. Hubungkan kembali untuk mengirim ujian.', 'warning');
      return;
    }
    if (busy) {
      if (action === 'submit') {
        queuedSubmit = true;
        uncertain = true;
        updateIndicators();
      }
      return;
    }
    if (!navigator.onLine) return;
    busy = true;
    if (action === 'submit') uncertain = true;
    updateIndicators();
    const payload = { device };
    if (['save', 'submit', 'claim'].includes(action)) payload.epoch = state?.write_epoch;
    if (['save', 'submit'].includes(action)) payload.answers = { ...pending };
    let rerender = action !== 'save';
    let followUp;
    try {
      const next = await rpc('cbt_student', { p_session: session, p_action: action, p_data: payload }, scope);
      if (scope.aborted) return;
      if (!next.ok) {
        if (next.code === 'login_required') {
          reset('Sesi berakhir. Masuk kembali dengan token ujian yang berlaku.');
        } else if (['lease_conflict', 'stale_revision'].includes(next.code)) {
          if (state) state.writable = false;
          uncertain = false;
          notice = next.code === 'lease_conflict'
            ? 'Perangkat lain sedang memegang akses tulis. Muat status terbaru sebelum mengambil alih.'
            : 'Terjadi benturan simpan. Jawaban terakhir dari server akan dimuat.';
          noticeKind = 'warning';
          followUp = { sync: next.code === 'stale_revision' };
        } else {
          uncertain = false;
          notice = 'Ujian berubah status. Perbarui informasi lalu coba lagi.';
          noticeKind = 'warning';
          if (action !== 'state') followUp = {};
        }
        rerender = true;
        return;
      }
      if (next.status !== state?.status) rerender = true;
      if (action === 'state' && uncertain && next.status === 'active') {
        uncertain = false;
        notice = 'Server belum menerima pengiriman. Periksa jawaban dan kirim kembali.';
        noticeKind = 'warning';
      }
      if (action === 'claim') {
        notice = 'Akses tulis sudah pindah ke perangkat ini. Jawaban yang tersimpan di server dimuat.';
        noticeKind = 'success';
      }
      accept(next, { restore: action === 'state' && !state, drop: sync || action === 'claim' });
      if (state.status === 'final') {
        notice = '';
        finalizing = false;
      }
      retry = 0;
    } catch {
      if (scope.aborted) return;
      retry = Math.min(retry + 1, 5);
      rerender ||= !state;
      if (action === 'submit') {
        notice = 'Pengiriman belum dapat dikonfirmasi. Periksa status saat tersambung.';
        noticeKind = 'warning';
      } else if (action !== 'save') {
        notice = 'Layanan ujian belum bisa dijangkau. Periksa koneksi, lalu coba lagi.';
        noticeKind = 'warning';
      }
    } finally {
      busy = false;
      if (!scope.aborted) {
        if (rerender) render();
        else updateIndicators();
        if (followUp) {
          queuedSubmit = false;
          void operation('state', followUp);
        } else if (queuedSubmit) {
          queuedSubmit = false;
          if (state?.status === 'active' && state.writable) void operation('submit');
        } else scheduleSave(retry ? 1000 * 2 ** retry : undefined);
      }
    }
  }

  function change(position, changeTo) {
    if (!canEdit()) return;
    const old = ownAnswer(position) || { option: null, flagged: false, revision: 0 };
    pending[position] = { ...old, ...changeTo, revision: old.revision + 1 };
    persist();
    if (!storageAvailable) notice = 'Penyimpanan HP tidak tersedia. Biarkan halaman terbuka sampai jawaban dikonfirmasi server.';
    scheduleSave();
    updateIndicators();
  }
  function go(position) {
    question = position;
    persist();
    render();
    root.querySelector('#question-heading')?.focus();
  }
  async function signOut() {
    if (busy || (hasPending() && !confirm('Ada jawaban yang belum dikonfirmasi server. Keluar dan hapus draf dari HP ini?'))) return;
    if (session && navigator.onLine) {
      // Local logout is immediate even when revocation cannot reach the server.
      void rpc('cbt_student', { p_session: session, p_action: 'revoke', p_data: { device } }, scope).catch(() => {});
    }
    reset('');
  }

  function alertMarkup() {
    return notice ? `<p class="student-notice ${noticeKind}" role="status">${escape(notice)}</p>` : '';
  }
  function loginMarkup() {
    return `<section class="entry">
      <div class="entry-intro">
        <p class="overline"><span></span> SISTEM UJIAN SEKOLAH</p>
        <h1>Portal Ujian<br>Berbasis Komputer</h1>
        <p>Masuk dengan identitas dan token yang dibagikan guru. Jawaban tersimpan otomatis selama ujian.</p>
        <div class="entry-meta"><span>SMK Gajah Mungkur 1 Wuryantoro</span><span>Waktu Indonesia Barat</span></div>
      </div>
      <div class="entry-card">
        <p class="overline">PORTAL SISWA</p>
        <h2>Masuk ke ujian</h2>
        <p>Gunakan token pribadi untuk memulai, melanjutkan, atau melihat bukti kirim.</p>
        ${alertMarkup()}
        <form id="student-login">
          <label for="identity">NIS atau nama lengkap</label>
          <input id="identity" name="identity" maxlength="120" required placeholder="Sesuai daftar peserta" autocomplete="off">
          <label for="token">Token ujian</label>
          <div class="token-field"><input id="token" name="token" type="password" maxlength="64" required placeholder="Masukkan token dari guru" autocomplete="off" autocapitalize="none" spellcheck="false">
          <button type="button" class="button subtle" data-show-token aria-label="Lihat token" aria-pressed="false">Lihat</button></div>
          <button class="button primary entry-submit" type="submit" ${busy || init ? 'disabled' : ''}>Masuk ke ujian <span aria-hidden="true">→</span></button>
        </form>
        <p class="entry-help">Butuh bantuan? Hubungi guru atau pengawas ujian.</p>
      </div>
    </section>`;
  }
  function preflightMarkup() {
    const ready = state.status === 'ready';
    const waiting = state.status === 'waiting';
    return `<section class="student-panel">
      <p class="overline">PERSIAPAN UJIAN</p>
      <h1>${escape(state.title)}</h1>
      <p class="student-name">${escape(state.student_name)} · ${escape(state.class_code)}</p>
      ${alertMarkup()}
      <div class="student-facts">
        <div><span>Buka</span><strong>${date(state.opens_at)}</strong></div>
        <div><span>Tutup</span><strong>${date(state.closes_at)}</strong></div>
        <div><span>Durasi ujian</span><strong>${state.duration_minutes} menit</strong></div>
      </div>
      <h2>Sebelum mulai</h2>
      <ul class="student-rules">
        <li>Waktu dimulai saat menekan Mulai ujian dan berakhir paling lambat saat sesi ditutup.</li>
        <li>Jawaban disimpan ke HP saat diubah, lalu dikirim otomatis saat terhubung. Timer tetap berjalan saat koneksi putus.</li>
        <li>Saat selesai, tekan Kirim ujian dan simpan ID bukti yang tampil.</li>
      </ul>
      <div class="student-actions">
        ${ready ? '<button class="button primary" data-action="start" data-needs-connection>Mulai ujian</button>'
          : `<p class="student-notice" role="status">${waiting ? 'Jadwal ujian belum dimulai.' : 'Sesi ujian sudah ditutup.'}</p>
             <button class="button primary" data-action="state" data-needs-connection>Cek status</button>`}
        <button class="button subtle" data-sign-out>Keluar</button>
      </div>
    </section>`;
  }
  function receiptMarkup() {
    const why = { timeout: 'Waktu ujian berakhir', closed: 'Sesi ditutup pengawas', manual: 'Dikirim oleh siswa' };
    return `<section class="student-panel receipt">
      <div class="receipt-check" aria-hidden="true">✓</div>
      <p class="overline">BUKTI KIRIM</p>
      <h1>Ujian terkirim</h1>
      <p>${escape(state.title)} · ${escape(state.student_name)} · ${escape(state.class_code)}</p>
      ${alertMarkup()}
      <div class="receipt-id"><span>ID bukti</span><strong>${escape(state.receipt)}</strong></div>
      <p>${date(state.submitted_at)} · ${escape(why[state.submit_reason])}</p>
      <p class="student-notice">${state.score !== null && state.score !== undefined
        ? `Nilai <strong>${new Intl.NumberFormat('id-ID').format(state.score)}</strong>`
        : state.score_released ? 'Nilai perlu ditinjau guru.' : 'Nilai tersedia setelah dirilis oleh guru.'}</p>
      <div class="student-actions">
        <button class="button primary" data-action="state" data-needs-connection>Cek nilai</button>
        <button class="button subtle" data-sign-out>Keluar</button>
      </div>
    </section>`;
  }
  function navigatorMarkup() {
    return state.questions.map(({ position }) => {
      const answer = ownAnswer(position);
      const label = answer?.flagged ? 'Ragu' : answer?.option ? 'Terjawab' : 'Kosong';
      return `<button class="number-button ${label.toLowerCase()}" type="button" data-question="${position}"
        aria-label="Soal ${position}, ${label.toLowerCase()}" ${position === question ? 'aria-current="step"' : ''}>${position}</button>`;
    }).join('');
  }
  function examMarkup() {
    const item = state.questions?.[question - 1];
    if (!item) return '<section class="student-panel"><h1>Memuat soal</h1><button class="button primary" data-action="state" data-needs-connection>Cek status</button></section>';
    const answer = ownAnswer(question);
    const total = state.questions.length;
    const empty = state.questions.filter(({ position }) => !ownAnswer(position)?.option).length;
    const flagged = state.questions.filter(({ position }) => ownAnswer(position)?.flagged).length;
    return `<section class="exam-layout">
      <div class="exam-top">
        <div><p class="overline">UJIAN BERLANGSUNG</p><h1>${escape(state.title)}</h1><p class="student-name">${escape(state.student_name)} · ${escape(state.class_code)}</p></div>
        <div class="exam-time"><span>Sisa waktu</span><strong data-timer role="timer" aria-label="Sisa waktu">${countdown()}</strong>
          <small data-save-status role="status">${saveText()}</small></div>
      </div>
      ${alertMarkup()}
      ${!navigator.onLine ? '<p class="student-notice warning" role="status">Koneksi terputus. Draf tetap di HP ini jika penyimpanan tersedia. Timer tetap berjalan.</p>' : ''}
      ${!state.writable ? '<p class="student-notice warning">Akses tulis ada di sesi lain. Ambil alih untuk melanjutkan dengan simpanan terakhir dari server.</p><button class="button primary take-over" data-action="claim" data-needs-connection>Ambil alih di perangkat ini</button>' : ''}
      ${finalizing || uncertain ? '<p class="student-notice warning" role="status">Menunggu konfirmasi dari server.</p><button class="button primary take-over" data-action="state" data-needs-connection>Cek status pengiriman</button>' : ''}
      <div class="exam-grid">
        <article class="question-card">
          <p class="overline">SOAL ${question} DARI ${total}</p>
          <h2 id="question-heading" tabindex="-1">${escape(item.prompt)}</h2>
          ${/^https:\/\//i.test(item.image_url ?? '') ? '<button class="button subtle" type="button" data-image>Buka gambar soal</button>' : ''}
          <fieldset class="choices"><legend>Pilih satu jawaban</legend>
            ${letters.map((letter) => `<label class="choice"><input data-editable name="choice" type="radio" value="${letter}" ${answer?.option === letter ? 'checked' : ''}>
              <span aria-hidden="true" class="choice-letter">${letter}</span><span><span class="sr-only">${letter}. </span>${escape(item.options[letter])}</span></label>`).join('')}
          </fieldset>
          <div class="question-actions">
            <button class="button subtle" data-question="${question - 1}" ${question <= 1 ? 'disabled' : ''}>Sebelumnya</button>
            <button class="button subtle" data-flag data-editable aria-pressed="${Boolean(answer?.flagged)}">Ragu</button>
            <button class="button primary" data-question="${question + 1}" ${question >= total ? 'disabled' : ''}>Berikutnya</button>
          </div>
        </article>
        <aside class="question-card question-nav">
          <h2>Daftar soal</h2>
          <p data-summary>${empty} kosong · ${flagged} ragu</p>
          <div class="number-grid" data-number-grid>${navigatorMarkup()}</div>
          <button class="button primary" data-submit-open data-editable>Kirim ujian</button>
        </aside>
      </div>
      <button class="button subtle exit-exam" data-sign-out>Keluar dari portal</button>
    </section>`;
  }

  function render() {
    if (scope.aborted) return;
    root.innerHTML = !state ? (
      session ? `<section class="student-panel"><h1>Memulihkan sesi</h1>${alertMarkup()}<div class="student-actions">
        <button class="button primary" data-action="state" data-needs-connection>Coba lagi</button>
        <button class="button subtle" data-sign-out>Masuk ulang</button></div></section>` : loginMarkup()
    ) : state.status === 'active' ? examMarkup() : state.status === 'final' ? receiptMarkup() : preflightMarkup();
    updateIndicators();
  }
  function refreshProgress() {
    const grid = root.querySelector('[data-number-grid]');
    const summary = root.querySelector('[data-summary]');
    if (!grid || !summary) return;
    grid.innerHTML = navigatorMarkup();
    const empty = state.questions.filter(({ position }) => !ownAnswer(position)?.option).length;
    const flagged = state.questions.filter(({ position }) => ownAnswer(position)?.flagged).length;
    summary.textContent = `${empty} kosong · ${flagged} ragu`;
  }

  function dialog(markup, opener) {
    const element = document.createElement('dialog');
    element.className = 'student-dialog';
    element.setAttribute('aria-labelledby', 'dialog-title');
    element.innerHTML = markup;
    root.append(element);
    const id = crypto.randomUUID();
    history.pushState({ cbtDialog: id }, '');
    const onBack = () => element.close();
    window.addEventListener('popstate', onBack, { once: true, signal: scope });
    element.addEventListener('close', () => {
      window.removeEventListener('popstate', onBack);
      if (history.state?.cbtDialog === id) history.back();
      element.remove();
      if (opener.isConnected) opener.focus();
    }, { once: true });
    element.showModal();
    return element;
  }

  root.addEventListener('submit', async (event) => {
    if (event.target.id !== 'student-login') return;
    event.preventDefault();
    if (busy || init) return;
    const form = event.target;
    const data = new FormData(form);
    const identity = String(data.get('identity')).trim();
    const token = String(data.get('token')).trim();
    busy = true;
    form.querySelector('[type=submit]').disabled = true;
    try {
      const result = await rpc('cbt_student_login', {
        p_identity: identity, p_token: token, p_device: device,
      }, scope);
      if (scope.aborted) return;
      if (!result.ok) {
        show('Identitas atau token tidak dapat digunakan. Periksa isian atau hubungi pengawas.', 'warning');
        const input = root.querySelector('#identity');
        input.value = identity;
        root.querySelector('#token').focus();
        return;
      }
      session = result.session;
      sessionRecord();
      accept(result, { restore: true });
      show();
      root.querySelector('h1')?.setAttribute('tabindex', '-1');
      root.querySelector('h1')?.focus();
    } catch {
      if (!scope.aborted) {
        show('Gagal terhubung ke layanan ujian. Periksa jaringan lalu coba lagi.', 'warning');
        root.querySelector('#identity').value = identity;
      }
    } finally {
      busy = false;
      const button = root.querySelector('#student-login [type=submit]');
      if (button) button.disabled = false;
    }
  }, { signal: scope });

  root.addEventListener('change', (event) => {
    if (event.target.name !== 'choice') return;
    change(question, { option: event.target.value });
    refreshProgress();
  }, { signal: scope });

  root.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-show-token')) {
      const field = root.querySelector('#token');
      const visible = field.type === 'password';
      field.type = visible ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(visible));
      button.setAttribute('aria-label', visible ? 'Sembunyikan token' : 'Lihat token');
      button.textContent = visible ? 'Tutup' : 'Lihat';
    } else if (button.hasAttribute('data-sign-out')) {
      void signOut();
    } else if (button.dataset.action) {
      if (button.dataset.action === 'claim' && !confirm('Pindahkan akses tulis ke perangkat ini? Draf yang belum dikonfirmasi pada perangkat lain tidak ikut pindah.')) return;
      void operation(button.dataset.action);
    } else if (button.dataset.question) {
      go(Number(button.dataset.question));
    } else if (button.hasAttribute('data-flag')) {
      const flagged = !ownAnswer(question)?.flagged;
      change(question, { flagged });
      button.setAttribute('aria-pressed', String(flagged));
      refreshProgress();
    } else if (button.hasAttribute('data-submit-open')) {
      const counts = root.querySelector('[data-summary]').textContent;
      const modal = dialog(`<h2 id="dialog-title">Kirim ujian?</h2><p>${escape(counts)}. Setelah dikirim, jawaban dikunci.</p>
        <form method="dialog" class="student-actions"><button class="button subtle" value="back" autofocus>Periksa lagi</button>
        <button class="button primary" value="submit">Ya, kirim ujian</button></form>`, button);
      modal.addEventListener('close', () => {
        if (modal.returnValue === 'submit') void operation('submit');
      }, { once: true });
    } else if (button.hasAttribute('data-image')) {
      const item = state.questions[question - 1];
      dialog(`<h2 id="dialog-title">Gambar soal ${question}</h2><div class="question-image"><img src="${escape(item.image_url)}"
        alt="Ilustrasi untuk soal ${question}" referrerpolicy="no-referrer"></div>
        <form method="dialog"><button class="button subtle" autofocus>Tutup gambar</button></form>`, button);
    }
  }, { signal: scope });

  function pulse() {
    updateIndicators();
    if (!state || busy || !navigator.onLine || root.querySelector('dialog[open]')) return;
    const due = state.status === 'active' && secondsLeft() === 0;
    const open = state.status === 'waiting' && Date.parse(state.opens_at) <= Date.now() + offset;
    if ((due || open) && Date.now() >= autoCheckAfter) {
      autoCheckAfter = Date.now() + 5000;
      finalizing = due;
      void operation('state');
    }
  }
  window.addEventListener('online', () => {
    render();
    if (session) void operation('state');
  }, { signal: scope });
  window.addEventListener('offline', render, { signal: scope });
  window.addEventListener('pageshow', pulse, { signal: scope });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pulse();
    else if (hasPending() && canEdit()) {
      clearSave();
      void operation('save');
    }
  }, { signal: scope });
  const ticker = setInterval(pulse, 1000);

  async function lockDevice() {
    if (!navigator.locks) return true;
    return new Promise((resolve) => {
      navigator.locks.request(`${storageKey}:${device}`, { ifAvailable: true }, (lock) => {
        if (!lock || scope.aborted) return resolve(false);
        return new Promise((done) => {
          unlock = done;
          resolve(true);
        });
      }).catch(() => resolve(false));
    });
  }
  void (async () => {
    render();
    if (!await lockDevice() && !scope.aborted) {
      device = crypto.randomUUID();
      session = undefined;
      await lockDevice();
    }
    if (scope.aborted) return;
    sessionRecord();
    init = false;
    render();
    if (session) await operation('state');
  })();

  return () => {
    root.querySelector('dialog[open]')?.close();
    lifetime.abort();
    unlock?.();
    clearInterval(ticker);
    clearTimeout(saveTimer);
  };
}
