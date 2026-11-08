import { createClient } from '@supabase/supabase-js';
import { mountStaff } from './staff.js';
import { mountStudent } from './student.js';
import './style.css';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const main = document.querySelector('main');
const schoolRoot = new URL(import.meta.env.BASE_URL, location.origin);
let recovery = false;
let recoveryHandler;

const unwrap = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};

if (!url || !key) {
  main.innerHTML = '<div class="system-note"><h1>Portal belum terhubung</h1><p>Hubungi pengelola sekolah untuk konfigurasi layanan CBT.</p></div>';
} else {
  const supabase = createClient(url, key, {
    auth: { flowType: 'pkce', storageKey: 'skagamu-staff-auth' },
  });

  const staffApi = {
    rpc: async (name, args) => unwrap(await supabase.rpc(name, args)),
    signIn: async (email, password) => unwrap(await supabase.auth.signInWithPassword({ email, password })),
    signOut: async () => unwrap(await supabase.auth.signOut({ scope: 'local' })),
    getSession: async () => unwrap(await supabase.auth.getSession()).session,
    resetPassword: async (email) => unwrap(await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: schoolRoot.href,
    })),
    updatePassword: async (password) => {
      unwrap(await supabase.auth.updateUser({ password }));
      recovery = false;
    },
    isRecovery: () => recovery,
    onRecovery: (handler) => {
      recoveryHandler = handler;
      if (recovery) queueMicrotask(handler);
      return () => { if (recoveryHandler === handler) recoveryHandler = undefined; };
    },
  };

  // Anonymous student calls never carry an Auth session from the staff portal.
  async function studentRpc(name, args, signal) {
    const response = await fetch(new URL(`/rest/v1/rpc/${name}`, url), {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('STUDENT_RPC_FAILED');
    return response.json();
  }

  let route;
  let cleanup;
  function showRoute() {
    if (location.hash === '#konten') return;
    const next = location.hash === '#guru' ? 'guru' : 'siswa';
    if (next === route) return;
    cleanup?.();
    const initial = !route;
    route = next;
    const section = document.createElement('div');
    main.replaceChildren(section);
    for (const link of document.querySelectorAll('[data-route]')) {
      if (link.dataset.route === next) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    cleanup = next === 'guru' ? mountStaff(section, staffApi) : mountStudent(section, studentRpc);
    if (!initial) main.focus();
  }

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') {
      recovery = true;
      if (location.hash !== '#guru') location.hash = 'guru';
      else queueMicrotask(() => recoveryHandler?.());
    }
  });
  window.addEventListener('hashchange', showRoute);
  showRoute();
}
