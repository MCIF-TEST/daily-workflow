/**
 * app.js
 * MCIF Compact Scheduler — Full Feature Implementation (Verbatim plan)
 * - Single-file JS that builds UI (if needed), persists everything locally,
 *   and implements all features described in the plan.
 *
 * Author: Your MCIF Dev (generated)
 * Date: 2025-12-05
 *
 * How to use:
 * 1. Include <div id="app"></div> in your HTML (optional — script will create it).
 * 2. Include this script at the end of the body or with defer.
 *
 * This file expects no backend. All data is stored in localStorage.
 */

/* =========================
   Utilities & Constants
   ========================= */

const MCIF = (function () {
  // Basic constants
  const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const START_HOUR = 6;
  const END_HOUR = 22;
  const MS = 1000;
  const STORAGE_PREFIX = 'mcif_compact_v2';
  const SETTINGS_KEY = `${STORAGE_PREFIX}_settings`;
  const TASKS_KEY = `${STORAGE_PREFIX}_tasks`;
  const TEMPLATES_KEY = `${STORAGE_PREFIX}_templates`;
  const ARCHIVES_KEY = `${STORAGE_PREFIX}_archives`;
  const SESSIONS_KEY = `${STORAGE_PREFIX}_sessions`;
  const UNDO_LIMIT = 40;
  const MAX_ARCHIVE_ENTRIES = 128;

  // Helpers
  const uid = (p = 'id') => `${p}_${Math.random().toString(36).slice(2,10)}`;
  const now = () => Date.now();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function ymd(d = new Date()){
    const z = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`;
  }
  function niceDate(d = new Date()){
    return d.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
  }

  // ISO week key (Monday-first)
  function getISOWeekKey(d = new Date()){
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay()||7));
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
    const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1)/7);
    return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2,'0')}`;
  }
  function startOfISOWeek(d = new Date()){
    const day = new Date(d);
    const isoDay = (day.getDay() + 6) % 7; // 0=Mon
    return new Date(day.getFullYear(), day.getMonth(), day.getDate() - isoDay);
  }
  function weekRangeText(d = new Date()){
    const mon = startOfISOWeek(d);
    const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    const opts = { month:'short', day:'numeric' };
    if (mon.getFullYear() === sun.getFullYear()){
      return `${mon.toLocaleDateString(undefined,opts)} – ${sun.toLocaleDateString(undefined,opts)}, ${sun.getFullYear()}`;
    }
    return `${mon.toLocaleDateString(undefined,opts)} ${mon.getFullYear()} – ${sun.toLocaleDateString(undefined,opts)} ${sun.getFullYear()}`;
  }

  /* Storage wrapper with defensive JSON handling */
  const storage = {
    save(key, value){
      try { localStorage.setItem(key, JSON.stringify(value)); } catch(e){ console.warn('Storage save failed', e); }
    },
    load(key, fallback = null){
      try {
        const v = localStorage.getItem(key);
        if (!v) return fallback;
        return JSON.parse(v);
      } catch(e){ console.warn('Storage load failed', e); return fallback; }
    },
    remove(key){ try { localStorage.removeItem(key); } catch(e){} }
  };

  /* Toast / notification */
  function createToastsContainer(){
    let el = document.getElementById('mcif_toasts');
    if (!el){
      el = document.createElement('div');
      el.id = 'mcif_toasts';
      el.style.position = 'fixed';
      el.style.right = '12px';
      el.style.bottom = '14px';
      el.style.display = 'flex';
      el.style.flexDirection = 'column';
      el.style.gap = '8px';
      el.style.zIndex = 9999;
      document.body.appendChild(el);
    }
    return el;
  }
  function toast(msg, options = { time: 3000 }){
    const c = createToastsContainer();
    const t = document.createElement('div');
    t.className = 'mcif_toast';
    t.style.background = 'rgba(0,0,0,0.6)';
    t.style.color = '#fff';
    t.style.padding = '10px 12px';
    t.style.borderRadius = '10px';
    t.style.fontWeight = '700';
    t.style.boxShadow = '0 8px 30px rgba(0,0,0,0.6)';
    t.style.maxWidth = '320px';
    t.style.wordBreak = 'break-word';
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(()=> { t.style.opacity = '0'; t.addEventListener('transitionend', ()=> t.remove()); }, options.time);
  }

  /* simple CSV/text export helper */
  function exportJSON(name, obj){
    const data = JSON.stringify(obj, null, 2);
    const url = "data:text/json;charset=utf-8," + encodeURIComponent(data);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* debounce */
  function debounce(fn, ms=250){ let t; return (...a)=>{ clearTimeout(t); t = setTimeout(()=>fn(...a), ms); }; }

  /* =========================
     UI Builder (creates DOM if missing)
     ========================= */
  function ensureAppShell(){
    let app = document.getElementById('app');
    if (app) return app;

    app = document.createElement('div');
    app.id = 'app';
    document.body.appendChild(app);
  }

  /* Small CSS injection for necessary classes used by JS-created UI */
  function injectCoreStyles(){
    if (document.getElementById('mcif_core_styles')) return;
    const css = `
    :root{ --mcif-bg:#071423; --mcif-card:#0c1722; --mcif-text:#e6f6f7; --mcif-muted:#9fb0bf; --mcif-accent:#56d6b4; --mcif-accent2:#5fa8ff; --mcif-radius:12px; font-family:-apple-system,BlinkMacSystemFont,Inter,Arial,sans-serif; color-scheme:dark; }
    #app{max-width:980px;margin:0 auto;padding:12px;}
    .mcif_header{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}
    .mcif_logo{width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,var(--mcif-accent),var(--mcif-accent2));display:grid;place-items:center;color:#032427;font-weight:800}
    .mcif_card{background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0.03));padding:10px;border-radius:var(--mcif-radius);border:1px solid rgba(255,255,255,0.03);box-shadow:0 12px 40px rgba(0,0,0,0.4)}
    .mcif_row{display:flex;gap:8px;align-items:center}
    .mcif_input{padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,0.03);background:transparent;color:var(--mcif-text);outline:none;flex:1}
    .mcif_btn{padding:8px 12px;border-radius:999px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.03);color:var(--mcif-accent);font-weight:700;cursor:pointer}
    .mcif_btn.ghost{background:transparent;color:var(--mcif-muted)}
    .mcif_task{display:flex;gap:8px;align-items:center;padding:8px;border-radius:10px;background:rgba(255,255,255,0.01);border:1px solid rgba(255,255,255,0.02);cursor:grab}
    .mcif_task .mcif_title{font-weight:700}
    .mcif_task .mcif_time{min-width:64px;color:var(--mcif-muted);font-weight:800}
    .mcif_grid{display:grid;grid-template-columns:repeat(7,1fr);gap:8px}
    .mcif_day{padding:8px;border-radius:10px;min-height:140px;background:transparent}
    .mcif_toast{transition:opacity .25s ease}
    .mcif_modal_backdrop{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.4);z-index:1200}
    .mcif_modal_backdrop.show{display:flex}
    .mcif_modal{background:var(--mcif-card);padding:12px;border-radius:12px;width:92%;max-width:540px;border:1px solid rgba(255,255,255,0.03)}
    @media (max-width:520px){ .mcif_grid{grid-template-columns:repeat(2,1fr)} .mcif_input{font-size:16px} }
    `;
    const s = document.createElement('style');
    s.id = 'mcif_core_styles';
    s.innerHTML = css;
    document.head.appendChild(s);
  }

  /* =========================
     Core App State & Persistence
     ========================= */

  const DEFAULT_SETTINGS = {
    theme: "Midnight Glass",
    autoReset: true,
    autoSort: true,
    dingerEnabled: true,
    dingerInterval: 15,
    vibrateDinger: true,
    recallMode: 'random', // 'off', 'random', 'triple'
    recallMin: 5,
    recallMax: 20,
    lastThemeAppliedAt: null,
    lastPlayInteraction: null
  };

  let STATE = {
    date: new Date(), // current selected date
    weekKey: getISOWeekKey(new Date()),
    tasks: {}, // { 'YYYY-MM-DD': [task,...] }
    templates: {}, // { name: [ {time,title,notes} ] }
    archives: [], // list of week keys
    sessions: [], // reading sessions
    settings: { ...DEFAULT_SETTINGS },
    undoStack: []
  };

  function loadState(){
    const tasks = storage.load(TASKS_KEY, {});
    const templates = storage.load(TEMPLATES_KEY, {});
    const archives = storage.load(ARCHIVES_KEY, []);
    const sessions = storage.load(SESSIONS_KEY, []);
    const settings = storage.load(SETTINGS_KEY, null);
    if (tasks) STATE.tasks = tasks;
    if (templates) STATE.templates = templates;
    if (archives) STATE.archives = archives;
    if (sessions) STATE.sessions = sessions;
    if (settings) STATE.settings = { ...DEFAULT_SETTINGS, ...settings };
  }
  function persistAll(){
    storage.save(TASKS_KEY, STATE.tasks);
    storage.save(TEMPLATES_KEY, STATE.templates);
    storage.save(ARCHIVES_KEY, STATE.archives);
    storage.save(SESSIONS_KEY, STATE.sessions);
    storage.save(SETTINGS_KEY, STATE.settings);
  }

  /* Undo snapshot */
  function pushUndo(){
    try {
      const snap = JSON.stringify({ tasks: STATE.tasks });
      STATE.undoStack.push(snap);
      if (STATE.undoStack.length > UNDO_LIMIT) STATE.undoStack.shift();
    } catch(e){}
  }
  function popUndo(){
    const s = STATE.undoStack.pop();
    if (!s) return false;
    try {
      const obj = JSON.parse(s);
      STATE.tasks = obj.tasks || {};
      persistAll();
      UIManager.refreshAll();
      toast('Undone');
      return true;
    } catch(e){ return false; }
  }

  /* =========================
     Audio Engine
     ========================= */

  const AudioEngine = (function(){
    // Two audio elements (binaural + ambient)
    const binaural = new Audio();
    const ambient = new Audio();
    binaural.loop = true; ambient.loop = true;
    // iOS: playsinline & preload attributes
    [binaural, ambient].forEach(a=>{ a.setAttribute('playsinline',''); a.preload='auto'; });

    // Track sources are either blob URLs (user files) or data URLs
    function setBinauralSource(src){
      if (!src) { binaural.removeAttribute('src'); binaural.load(); return; }
      binaural.src = src;
      binaural.load();
    }
    function setAmbientSource(src){
      if (!src) { ambient.removeAttribute('src'); ambient.load(); return; }
      ambient.src = src;
      ambient.load();
    }

    async function playAll(){
      try {
        await binaural.play().catch(()=>{});
        await ambient.play().catch(()=>{});
      } catch(e){}
    }
    function pauseAll(){ try{ binaural.pause(); ambient.pause(); }catch(e){} }

    function setVolumes(bv, av){
      binaural.volume = clamp(Number(bv), 0, 1);
      ambient.volume = clamp(Number(av), 0, 1);
    }

    // Media Session integration
    function registerMediaSession(){
      try {
        if ('mediaSession' in navigator){
          navigator.mediaSession.metadata = new MediaMetadata({ title: 'MCIF Reading Session', artist: 'MCIF' });
          navigator.mediaSession.setActionHandler('play', playAll);
          navigator.mediaSession.setActionHandler('pause', pauseAll);
          // skip handlers can be added if needed
        }
      } catch(e){}
    }

    return {
      binaural, ambient, setBinauralSource, setAmbientSource, playAll, pauseAll, setVolumes, registerMediaSession
    };
  })();

  /* =========================
     Dinger & WebAudio soft chime
     ========================= */
  function playSoftBeep(freq = 880, ms = 120, gain = 0.0015){
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.value = gain;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      setTimeout(()=>{ try{ o.stop(); ctx.close(); } catch(e){} }, ms);
    } catch(e){}
  }

  /* =========================
     Reading Session Manager (recall prompts, triple retention, logging)
     ========================= */

  const ReadingManager = (function(){

    let running = false;
    let session = null;
    let dingerIntervalId = null;
    let recallTimeoutId = null;
    let recallSequence = []; // for triple mode
    let lastInteractionTs = 0;

    function createSession(){
      const s = {
        id: uid('sess'),
        startedAt: now(),
        endedAt: null,
        binauralSrc: AudioEngine.binaural.src || null,
        ambientSrc: AudioEngine.ambient.src || null,
        binauralVol: AudioEngine.binaural.volume || 0.7,
        ambientVol: AudioEngine.ambient.volume || 0.5,
        recallMode: STATE.settings.recallMode,
        recallMin: Number(STATE.settings.recallMin),
        recallMax: Number(STATE.settings.recallMax),
        dingerInterval: Number(STATE.settings.dingerInterval),
        dingerEnabled: !!STATE.settings.dingerEnabled,
        vibrateDinger: !!STATE.settings.vibrateDinger,
        summaries: [],
        events: []
      };
      STATE.sessions.unshift(s);
      persistAll();
      return s;
    }

    function start(){
      if (running) { toast('Reading already running'); return; }
      session = createSession();
      running = true;
      lastInteractionTs = now();
      // start audio if present (play user must have interacted)
      AudioEngine.playAll().catch(()=>{});
      AudioEngine.registerMediaSession();

      // start dinger if enabled
      if (session.dingerEnabled){
        scheduleDinger(session.dingerInterval);
      }
      // schedule recalls
      scheduleNextRecall();

      toast('Reading session started');
      UIManager.onReadingStart(session);
    }

    function stop(){
      if (!running) { toast('Reading not active'); return; }
      running = false;
      session.endedAt = now();
      session.duration = session.endedAt - session.startedAt;
      persistAll();
      // clear timers
      if (dingerIntervalId) { clearInterval(dingerIntervalId); dingerIntervalId = null; }
      if (recallTimeoutId) { clearTimeout(recallTimeoutId); recallTimeoutId = null; }
      recallSequence = [];
      session = null;
      // optionally pause audio? keep as user's choice
      toast('Reading session ended');
      UIManager.onReadingStop();
    }

    function scheduleDinger(mins){
      if (dingerIntervalId) clearInterval(dingerIntervalId);
      const ms = Math.max(1, mins) * 60 * 1000;
      dingerIntervalId = setInterval(()=>{
        playDingerMoment();
      }, ms);
    }

    function playDingerMoment(){
      playSoftBeep(880, 120, 0.0016);
      if (STATE.settings.vibrateDinger && navigator.vibrate) navigator.vibrate(150);
      if (session) session.events.push({ type:'dinger', ts: now() });
      persistAll();
    }

    function scheduleNextRecall(){
      if (!running) return;
      if (recallTimeoutId) clearTimeout(recallTimeoutId);
      const mode = STATE.settings.recallMode;
      if (!mode || mode === 'off') return;
      if (mode === 'random'){
        const min = Math.max(1, Number(STATE.settings.recallMin));
        const max = Math.max(min, Number(STATE.settings.recallMax));
        const mins = Math.floor(Math.random() * (max - min + 1)) + min;
        recallTimeoutId = setTimeout(()=> { triggerRecallPrompt(); }, mins * 60 * 1000);
      } else if (mode === 'triple'){
        // triple: immediate -> mid -> final
        if (!recallSequence.length){
          recallSequence = ['immediate','mid','final'];
          recallTimeoutId = setTimeout(()=> triggerRecallPrompt(), 2 * 60 * 1000); // 2 minutes for the immediate one
        } else {
          recallTimeoutId = setTimeout(()=> triggerRecallPrompt(), 8 * 60 * 1000); // 8 minutes between subsequent prompts
        }
      }
    }

    function triggerRecallPrompt(){
      if (!running || !session) return;
      // Build prompt UI modal (non-blocking fallback to prompt only if necessary)
      UIManager.showRecallPrompt({
        onAnswer: (text, stage = null) => {
          session.summaries.push({ stage: stage || (STATE.settings.recallMode === 'random' ? 'random' : 'recall'), ts: now(), text: text });
          session.events.push({ type:'recall', ts: now(), stage: stage || null });
          persistAll();
          toast('Summary saved');
          scheduleNextRecall();
        },
        onCancel: () => {
          session.events.push({ type:'recall_cancel', ts: now() }); persistAll(); scheduleNextRecall();
        },
        stage: recallSequence.length ? recallSequence.shift() : null
      });
    }

    function immediateSummary(text){
      if (!session) return;
      session.summaries.push({ stage:'immediate', ts: now(), text });
      persistAll();
    }

    function exportSessions(){
      exportJSON('mcif_sessions.json', STATE.sessions);
    }

    function getSessions(){ return STATE.sessions; }

    return {
      start, stop, scheduleDinger, triggerRecallPrompt, immediateSummary, exportSessions, getSessions
    };
  })();

  /* =========================
     UI Manager: builds UI, binds events, handles updates
     ========================= */

  const UIManager = (function(){

    // We'll build the entire compact iPhone UI inside #app if not present.
    let root = null;
    let elements = {};

    function buildShell(){
      ensureAppShell();
      injectCoreStyles();
      root = document.getElementById('app');

      // top header
      const header = document.createElement('div');
      header.className = 'mcif_header';
      header.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px">
          <div class="mcif_logo" aria-hidden="true">MCIF</div>
          <div>
            <div style="font-weight:800;font-size:16px">MCIF Scheduler</div>
            <div style="font-size:12px;color:var(--mcif-muted)">Compact • iPhone-optimized • Local-first</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <div class="mcif_kbd" id="mcif_weekBadge" style="background:rgba(255,255,255,0.02);padding:6px 10px;border-radius:8px;color:var(--mcif-muted);font-weight:800"></div>
          <button class="mcif_btn" id="mcif_todayBtn">Today</button>
          <button class="mcif_btn" id="mcif_settingsBtn">Settings</button>
        </div>
      `;
      root.appendChild(header);

      // main content container
      const main = document.createElement('div');
      main.id = 'mcif_main';
      main.style.display = 'grid';
      main.style.gridTemplateColumns = '1fr';
      main.style.gap = '12px';
      root.appendChild(main);

      // daily card
      const dailyCard = document.createElement('div'); dailyCard.className = 'mcif_card';
      dailyCard.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div id="mcif_dateLabel" style="font-weight:900;"></div>
            <div id="mcif_tzLabel" style="font-size:12px;color:var(--mcif-muted)"></div>
          </div>
          <div style="font-size:12px;color:var(--mcif-muted)">Auto-save • Weekly archive</div>
        </div>
        <div style="height:8px"></div>
        <div class="mcif_row">
          <input id="mcif_taskInput" class="mcif_input" placeholder="New task — type and press Add" aria-label="Task title" />
          <input id="mcif_timeInput" class="mcif_input" type="time" style="width:120px" />
          <button id="mcif_addBtn" class="mcif_btn">Add</button>
        </div>
        <div style="height:8px"></div>
        <div id="mcif_taskList" class="mcif_task_list" style="display:flex;flex-direction:column;gap:8px;max-height:360px;overflow:auto;-webkit-overflow-scrolling:touch"></div>
      `;
      main.appendChild(dailyCard);

      // week grid
      const weekCard = document.createElement('div'); weekCard.className = 'mcif_card';
      weekCard.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div id="mcif_weekRange" style="font-weight:900"></div>
          <div>
            <button id="mcif_prevWeek" class="mcif_btn mcif_ghost">◀</button>
            <button id="mcif_nextWeek" class="mcif_btn mcif_ghost">▶</button>
          </div>
        </div>
        <div style="height:8px"></div>
        <div id="mcif_weekGrid" class="mcif_grid"></div>
      `;
      main.appendChild(weekCard);

      // bottom row: timeline + reading controls
      const bottomRow = document.createElement('div'); bottomRow.style.display='flex'; bottomRow.style.gap='8px'; bottomRow.style.alignItems='flex-start';
      bottomRow.innerHTML = `
        <div id="mcif_timeline" class="mcif_card" style="flex:1;min-height:120px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div style="font-weight:800">Timeline (06:00–22:00)</div>
            <div style="font-size:12px;color:var(--mcif-muted)">Tap day cell to open timeline</div>
          </div>
          <div id="mcif_timeBars" style="margin-top:8px;color:var(--mcif-muted)">Tap a day to show its timeline here.</div>
        </div>
        <div id="mcif_readingCard" class="mcif_card" style="width:340px;max-width:44vw">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div style="font-weight:800">Reading Mode</div>
            <div style="font-size:12px;color:var(--mcif-muted)">Audio • Recall • Sessions</div>
          </div>
          <div style="height:6px"></div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <label class="small" style="color:var(--mcif-muted)">Binaural (upload)</label>
            <input id="mcif_binauralFile" type="file" accept="audio/*" />
            <div style="display:flex;gap:8px;align-items:center">
              <button id="mcif_binauralPlay" class="mcif_btn mcif_ghost">Play</button>
              <input id="mcif_binauralVol" type="range" min="0" max="1" step="0.01" value="0.7" style="flex:1" />
            </div>

            <label class="small" style="color:var(--mcif-muted)">Ambient soundtrack</label>
            <input id="mcif_ambientFile" type="file" accept="audio/*" />
            <div style="display:flex;gap:8px;align-items:center">
              <button id="mcif_ambientPlay" class="mcif_btn mcif_ghost">Play</button>
              <input id="mcif_ambientVol" type="range" min="0" max="1" step="0.01" value="0.5" style="flex:1" />
            </div>

            <div style="display:flex;gap:8px;align-items:center;justify-content:space-between">
              <div style="display:flex;gap:8px;align-items:center">
                <label class="small" style="color:var(--mcif-muted)">Dinger (mins)</label>
                <input id="mcif_dingerInterval" type="number" min="1" max="180" value="${STATE.settings.dingerInterval}" style="width:92px" />
              </div>
              <div style="display:flex;gap:8px;align-items:center">
                <label style="display:flex;gap:6px;align-items:center;color:var(--mcif-muted)"><input id="mcif_vibrateDinger" type="checkbox" ${STATE.settings.vibrateDinger ? 'checked' : ''} />Vibrate</label>
              </div>
            </div>

            <div style="display:flex;gap:8px;align-items:center">
              <button id="mcif_startReading" class="mcif_btn">Start</button>
              <button id="mcif_stopReading" class="mcif_btn mcif_ghost">Stop</button>
            </div>

            <div style="display:flex;flex-direction:column;gap:6px">
              <label class="small" style="color:var(--mcif-muted)">Memory recall</label>
              <div style="display:flex;gap:8px;align-items:center">
                <select id="mcif_recallMode" class="mcif_input" style="width:160px">
                  <option value="off">Off</option>
                  <option value="random">Randomized Prompts</option>
                  <option value="triple">Ultimate Retention (3 prompts)</option>
                </select>
                <div style="font-size:12px;color:var(--mcif-muted)">Range</div>
                <input id="mcif_recallMin" type="number" min="1" value="${STATE.settings.recallMin}" style="width:64px" />
                <input id="mcif_recallMax" type="number" min="1" value="${STATE.settings.recallMax}" style="width:64px" />
              </div>
            </div>

            <div style="display:flex;gap:8px">
              <button id="mcif_openSessions" class="mcif_btn mcif_ghost">Session Log</button>
              <button id="mcif_exportSessions" class="mcif_btn mcif_ghost">Export Log</button>
            </div>
          </div>
        </div>
      `;
      root.appendChild(bottomRow);

      // hidden audio elements appended to body (for more control)
      const audioContainer = document.createElement('div');
      audioContainer.style.display = 'none';
      audioContainer.innerHTML = `
        <audio id="mcif_audio_binaural" loop playsinline></audio>
        <audio id="mcif_audio_ambient" loop playsinline></audio>
      `;
      document.body.appendChild(audioContainer);

      // modals: recall prompt, edit task, settings, sessions log
      const modalBackdrop = document.createElement('div');
      modalBackdrop.className = 'mcif_modal_backdrop';
      modalBackdrop.id = 'mcif_modal';
      modalBackdrop.innerHTML = `<div class="mcif_modal" id="mcif_modal_inner"></div>`;
      document.body.appendChild(modalBackdrop);

      // sessions log modal
      const logModal = document.createElement('div');
      logModal.className = 'mcif_modal_backdrop';
      logModal.id = 'mcif_log_modal';
      logModal.innerHTML = `<div class="mcif_modal" style="max-height:80vh;overflow:auto"><div style="display:flex;justify-content:space-between;align-items:center"><strong>Session Log</strong><button id="mcif_closeLog" class="mcif_btn mcif_ghost">Close</button></div><div id="mcif_sessions_area" style="margin-top:8px"></div></div>`;
      document.body.appendChild(logModal);

      // settings modal (themes + templates)
      const settingsModal = document.createElement('div');
      settingsModal.className = 'mcif_modal_backdrop';
      settingsModal.id = 'mcif_settings_modal';
      settingsModal.innerHTML = `<div class="mcif_modal"><div style="display:flex;justify-content:space-between;align-items:center"><strong>Settings</strong><button id="mcif_closeSettingsModal" class="mcif_btn mcif_ghost">Close</button></div><div style="margin-top:8px"><div><strong>Theme</strong><div id="mcif_theme_chips" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"></div></div><div style="margin-top:12px"><strong>Templates</strong><div style="display:flex;gap:8px;margin-top:8px"><input id="mcif_newTemplateName" class="mcif_input" placeholder="Template name"><input id="mcif_newTemplateBody" class="mcif_input" placeholder='Lines: "HH:MM — Title"'><button id="mcif_saveTemplate" class="mcif_btn">Save</button></div><div id="mcif_templates_list" style="margin-top:8px"></div></div></div></div>`;
      document.body.appendChild(settingsModal);

      // put references to elements into 'elements' map
      elements = {
        weekBadge: document.getElementById('mcif_weekBadge'),
        todayBtn: document.getElementById('mcif_todayBtn'),
        settingsBtn: document.getElementById('mcif_settingsBtn'),
        dateLabel: document.getElementById('mcif_dateLabel'),
        tzLabel: document.getElementById('mcif_tzLabel'),
        taskInput: document.getElementById('mcif_taskInput'),
        timeInput: document.getElementById('mcif_timeInput'),
        addBtn: document.getElementById('mcif_addBtn'),
        taskList: document.getElementById('mcif_taskList'),
        weekGrid: document.getElementById('mcif_weekGrid'),
        weekRange: document.getElementById('mcif_weekRange'),
        prevWeek: document.getElementById('mcif_prevWeek'),
        nextWeek: document.getElementById('mcif_nextWeek'),
        timeline: document.getElementById('mcif_timeBars'),
        binauralFile: document.getElementById('mcif_binauralFile'),
        ambientFile: document.getElementById('mcif_ambientFile'),
        binauralPlay: document.getElementById('mcif_binauralPlay'),
        ambientPlay: document.getElementById('mcif_ambientPlay'),
        binauralVol: document.getElementById('mcif_binauralVol'),
        ambientVol: document.getElementById('mcif_ambientVol'),
        dingerInterval: document.getElementById('mcif_dingerInterval'),
        vibrateDinger: document.getElementById('mcif_vibrateDinger'),
        startReading: document.getElementById('mcif_startReading'),
        stopReading: document.getElementById('mcif_stopReading'),
        recallMode: document.getElementById('mcif_recallMode'),
        recallMin: document.getElementById('mcif_recallMin'),
        recallMax: document.getElementById('mcif_recallMax'),
        openSessions: document.getElementById('mcif_openSessions'),
        exportSessions: document.getElementById('mcif_exportSessions'),
        audioBinauralEl: document.getElementById('mcif_audio_binaural'),
        audioAmbientEl: document.getElementById('mcif_audio_ambient'),
        modal: document.getElementById('mcif_modal'),
        modalInner: document.getElementById('mcif_modal_inner'),
        logModal: document.getElementById('mcif_log_modal'),
        sessionsArea: document.getElementById('mcif_sessions_area'),
        closeLogBtn: document.getElementById('mcif_closeLog'),
        settingsModal: document.getElementById('mcif_settings_modal'),
        closeSettingsModal: document.getElementById('mcif_closeSettingsModal'),
        themeChips: document.getElementById('mcif_theme_chips'),
        newTemplateName: document.getElementById('mcif_newTemplateName'),
        newTemplateBody: document.getElementById('mcif_newTemplateBody'),
        saveTemplateBtn: document.getElementById('mcif_saveTemplate'),
        templatesList: document.getElementById('mcif_templates_list'),
      };

      // set initial UI texts
      elements.weekBadge.textContent = STATE.weekKey;
      elements.dateLabel.textContent = niceDate(STATE.date);
      elements.tzLabel.textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';

      // attach audio elements to AudioEngine
      // use audio element provided in DOM to keep consistent behavior
      AudioEngine.setBinauralSource(elements.audioBinauralEl.src || '');
      AudioEngine.setAmbientSource(elements.audioAmbientEl.src || '');
      // replace audio engine elements with the real DOM ones
      AudioEngine.binaural = elements.audioBinauralEl;
      AudioEngine.ambient = elements.audioAmbientEl;
      elements.audioBinauralEl.loop = true; elements.audioAmbientEl.loop = true;
    }

    /* populate themes chips */
    const THEMES = {
      "Graphite Minimal": { '--mcif-bg':'#0b0b0b','--mcif-card':'#111111','--mcif-text':'#e6eef6','--mcif-accent':'#6ee7b7' },
      "Cerulean Blueprint": { '--mcif-bg':'#071029','--mcif-card':'#07192a','--mcif-text':'#eaf6ff','--mcif-accent':'#5fa8ff' },
      "Ivory Stone": { '--mcif-bg':'#fbf8f5','--mcif-card':'#ffffff','--mcif-text':'#0b0b0b','--mcif-accent':'#d4b35e' },
      "Zen Ice": { '--mcif-bg':'#f6fbfe','--mcif-card':'#ffffff','--mcif-text':'#052033','--mcif-accent':'#8fd3ff' },
      "Neon Focus": { '--mcif-bg':'#071428','--mcif-card':'#071827','--mcif-text':'#eaf0ff','--mcif-accent':'#39f' },
      "Sandstone Mode": { '--mcif-bg':'#f5efe6','--mcif-card':'#fffaf5','--mcif-text':'#1b160f','--mcif-accent':'#c89b6c' },
      "Polished Steel": { '--mcif-bg':'#0b1013','--mcif-card':'#07101a','--mcif-text':'#dfeeff','--mcif-accent':'#7fb2ff' },
      "Midnight Glass": { '--mcif-bg':'#03060a','--mcif-card':'#071019','--mcif-text':'#e6f6f3','--mcif-accent':'#4de1c4' },
      "Aurora Pulse": { '--mcif-bg':'#031021','--mcif-card':'#071822','--mcif-text':'#eaf0ff','--mcif-accent':'#7a6bff' },
      "Paper White Classic": { '--mcif-bg':'#ffffff','--mcif-card':'#ffffff','--mcif-text':'#0b0b0b','--mcif-accent':'#2b6ea3' }
    };

    function populateThemeChips(){
      elements.themeChips.innerHTML = '';
      for (const name of Object.keys(THEMES)){
        const chip = document.createElement('div');
        chip.className = 'mcif_theme_chip';
        chip.style.display = 'inline-flex';
        chip.style.alignItems = 'center';
        chip.style.gap = '8px';
        chip.style.padding = '6px 8px';
        chip.style.borderRadius = '999px';
        chip.style.cursor = 'pointer';
        chip.style.border = '1px solid rgba(255,255,255,0.03)';
        chip.innerHTML = `<div style="width:36px;height:18px;border-radius:6px;background:linear-gradient(90deg, ${THEMES[name]['--mcif-accent'] || '#fff'}, ${THEMES[name]['--mcif-accent2'] || '#000'})"></div><div style="font-size:13px">${name}</div>`;
        chip.addEventListener('click', ()=> applyTheme(name));
        elements.themeChips.appendChild(chip);
      }
    }

    function applyTheme(name){
      const t = THEMES[name] || THEMES['Midnight Glass'];
      for (const k of Object.keys(t)) document.documentElement.style.setProperty(k, t[k]);
      STATE.settings.theme = name;
      STATE.settings.lastThemeAppliedAt = now();
      storage.save(SETTINGS_KEY, STATE.settings);
      toast(`Theme applied: ${name}`);
    }

    /* render templates area */
    function renderTemplates(){
      elements.templatesList.innerHTML = '';
      for (const key of Object.keys(STATE.templates || {})){
        const el = document.createElement('div');
        el.style.display = 'flex'; el.style.justifyContent = 'space-between'; el.style.alignItems='center'; el.style.marginBottom='6px';
        el.innerHTML = `<div><strong>${esc(key)}</strong><div style="font-size:12px;color:var(--mcif-muted)">${STATE.templates[key].length} tasks</div></div><div style="display:flex;gap:8px"><button class="mcif_btn mcif_ghost" data-apply="${esc(key)}">Apply</button><button class="mcif_btn mcif_ghost" data-delete="${esc(key)}">Delete</button></div>`;
        elements.templatesList.appendChild(el);
      }
      // bind
      elements.templatesList.querySelectorAll('[data-apply]').forEach(b=>{
        b.addEventListener('click', ()=>{
          const nm = b.getAttribute('data-apply');
          applyTemplate(nm);
        });
      });
      elements.templatesList.querySelectorAll('[data-delete]').forEach(b=>{
        b.addEventListener('click', ()=>{
          const nm = b.getAttribute('data-delete');
          if (confirm('Delete template?')) { delete STATE.templates[nm]; persistAll(); renderTemplates(); populateTemplateSelect(); toast('Template deleted'); }
        });
      });
      populateTemplateSelect();
    }

    function populateTemplateSelect(){
      const sel = document.getElementById('mcif_template_select') || null;
      // if not present, create small select under main controls
      if (!sel){
        // we avoid changing DOM too much; but if user wants select in UI, they can add
        return;
      }
      sel.innerHTML = '<option value="">Templates</option>';
      for (const k of Object.keys(STATE.templates || {})){
        const v = encodeURIComponent(k);
        sel.innerHTML += `<option value="${v}">${k}</option>`;
      }
    }

    /* =========================
       Task rendering & interactions
       ========================= */

    function renderHeader(){
      const wk = getISOWeekKey(STATE.date);
      STATE.weekKey = wk;
      elements.weekBadge.textContent = wk;
      elements.dateLabel.textContent = niceDate(STATE.date);
      elements.tzLabel.textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
      elements.weekRange.textContent = weekRangeText(STATE.date);
    }

    function renderTasksForDate(dateKey){
      // dateKey = 'YYYY-MM-DD'
      const list = elements.taskList;
      list.innerHTML = '';
      const arr = STATE.tasks[dateKey] || [];
      if (STATE.settings.autoSort) arr.sort((a,b)=> (a.time||'').localeCompare(b.time||'') || a.createdAt - b.createdAt);
      if (!arr.length){
        const hint = document.createElement('div'); hint.className = 'mcif_task'; hint.style.opacity = '0.6'; hint.textContent = 'No tasks for this day.';
        list.appendChild(hint); return;
      }
      arr.forEach((t, idx)=>{
        const node = document.createElement('div');
        node.className = 'mcif_task';
        node.draggable = true;
        node.dataset.id = t.id;
        node.dataset.date = dateKey;
        node.innerHTML = `<div class="mcif_time">${esc(t.time||'—')}</div><div style="flex:1"><div class="mcif_title">${esc(t.title)}</div><div class="mcif_meta" style="font-size:12px;color:var(--mcif-muted)">${esc(t.notes||'')}</div></div><div style="display:flex;gap:8px"><button class="mcif_btn mcif_ghost" data-act="edit">✎</button><button class="mcif_btn mcif_ghost" data-act="dup">⤷</button><button class="mcif_btn mcif_ghost" data-act="del">🗑</button></div>`;
        // drag handlers
        node.addEventListener('dragstart', (e)=>{
          node.classList.add('dragging');
          try { e.dataTransfer.setData('text/mcif_task', t.id); e.dataTransfer.effectAllowed = 'move'; } catch(e){}
        });
        node.addEventListener('dragend', ()=> node.classList.remove('dragging'));
        // actions
        node.querySelector('[data-act="edit"]').addEventListener('click', (ev)=> { ev.stopPropagation(); openEditTaskModal(t, dateKey); });
        node.querySelector('[data-act="dup"]').addEventListener('click', (ev)=> { ev.stopPropagation(); duplicateTask(t, dateKey); });
        node.querySelector('[data-act="del"]').addEventListener('click', (ev)=> { ev.stopPropagation(); removeTaskConfirm(t.id, dateKey); });
        node.addEventListener('click', ()=> openEditTaskModal(t, dateKey));
        list.appendChild(node);
      });
    }

    function renderWeekGrid(){
      const grid = elements.weekGrid;
      grid.innerHTML = '';
      const mon = startOfISOWeek(STATE.date);
      for (let i=0;i<7;i++){
        const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
        const key = ymd(d);
        const col = document.createElement('div');
        col.className = 'mcif_day';
        col.dataset.day = key;
        col.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><div style="font-weight:800">${DAYS[i]}</div><div style="font-size:12px;color:var(--mcif-muted)">${d.toLocaleDateString(undefined,{month:'short',day:'numeric'})}</div></div><div class="mcif_day_tasks" style="display:flex;flex-direction:column;gap:6px;min-height:80px"></div>`;
        // drop handlers
        const taskList = col.querySelector('.mcif_day_tasks');
        taskList.addEventListener('dragover', (e)=>{ e.preventDefault(); taskList.style.outline='2px dashed rgba(255,255,255,0.03)'; });
        taskList.addEventListener('dragleave', ()=> { taskList.style.outline='none'; });
        taskList.addEventListener('drop', (e)=>{
          e.preventDefault(); taskList.style.outline='none';
          try {
            const id = e.dataTransfer.getData('text/mcif_task');
            if (id) moveTaskToDate(id, key);
          } catch(e){}
        });
        // clicking day sets main date and renders tasks
        col.addEventListener('click', (ev)=>{
          if (ev.target.closest('.mcif_task')) return;
          STATE.date = new Date(d);
          renderHeader();
          renderTasksForDate(key);
        });
        grid.appendChild(col);
      }
      // fill day columns with tasks
      fillWeekColumns();
    }

    function fillWeekColumns(){
      const mon = startOfISOWeek(STATE.date);
      for (let i=0;i<7;i++){
        const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
        const key = ymd(d);
        const col = elements.weekGrid.querySelector(`.mcif_day[data-day="${key}"]`);
        const taskList = col.querySelector('.mcif_day_tasks');
        taskList.innerHTML = '';
        const arr = STATE.tasks[key] || [];
        if (STATE.settings.autoSort) arr.sort((a,b)=> (a.time||'').localeCompare(b.time||'') || a.createdAt - b.createdAt);
        if (!arr.length) {
          const hint = document.createElement('div'); hint.className='mcif_task'; hint.style.opacity=0.6; hint.textContent='No tasks';
          taskList.appendChild(hint); continue;
        }
        for (const t of arr){
          const n = document.createElement('div'); n.className = 'mcif_task'; n.style.padding='6px'; n.innerHTML = `<div style="min-width:56px;font-weight:800;color:var(--mcif-muted)">${esc(t.time||'—')}</div><div style="flex:1;font-weight:700">${esc(t.title)}</div>`;
          n.addEventListener('click', ()=> openEditTaskModal(t, key));
          taskList.appendChild(n);
        }
      }
    }

    /* Create task added from UI */
    function addTaskFromUI(){
      const title = elements.taskInput.value.trim();
      const time = elements.timeInput.value || '';
      if (!title){ toast('Task title required'); return; }
      const key = ymd(STATE.date);
      pushUndo();
      STATE.tasks[key] = STATE.tasks[key] || [];
      STATE.tasks[key].push({ id: uid('t'), title, notes: '', time, createdAt: now(), updatedAt: now(), complete:false });
      persistAll();
      elements.taskInput.value = '';
      elements.timeInput.value = '';
      renderTasksForDate(key);
      fillWeekColumns();
      toast('Task added');
    }

    function removeTaskConfirm(id, dateKey){
      if (!confirm('Delete task? This cannot be undone.')) return;
      snapshotAndRemoveTask(id, dateKey);
    }

    function snapshotAndRemoveTask(id, dateKey){
      pushUndo();
      const arr = STATE.tasks[dateKey] || [];
      const idx = arr.findIndex(x=>x.id === id);
      if (idx >= 0) { arr.splice(idx,1); persistAll(); renderTasksForDate(dateKey); fillWeekColumns(); toast('Task deleted'); }
    }

    function duplicateTask(task, dateKey){
      pushUndo();
      const copy = { ...task, id: uid('t'), createdAt: now(), updatedAt: now() };
      STATE.tasks[dateKey] = STATE.tasks[dateKey] || [];
      STATE.tasks[dateKey].push(copy);
      persistAll();
      renderTasksForDate(dateKey); fillWeekColumns(); toast('Task duplicated');
    }

    function moveTaskToDate(id, destDateKey){
      pushUndo();
      // find task
      for (const k of Object.keys(STATE.tasks)){
        const arr = STATE.tasks[k] || [];
        const idx = arr.findIndex(x=>x.id===id);
        if (idx >= 0){
          const [t] = arr.splice(idx,1);
          t.dayMoved = { from: k, to: destDateKey, at: now() };
          STATE.tasks[destDateKey] = STATE.tasks[destDateKey] || [];
          STATE.tasks[destDateKey].push(t);
          if (STATE.settings.autoSort) STATE.tasks[destDateKey].sort((a,b)=> (a.time||'').localeCompare(b.time||''));
          persistAll();
          renderTasksForDate(ymd(STATE.date));
          fillWeekColumns();
          toast('Task moved');
          return;
        }
      }
    }

    /* Edit modal */
    function openEditTaskModal(task, dateKey){
      const modal = elements.modal;
      const inner = elements.modalInner;
      inner.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center"><strong>Edit Task</strong><button id="mcif_closeModal" class="mcif_btn mcif_ghost">Close</button></div>
        <div style="height:8px"></div>
        <div><label class="small" style="color:var(--mcif-muted)">Title</label><input id="mcif_editTitle" class="mcif_input" value="${esc(task.title)}" /></div>
        <div style="height:8px"></div>
        <div style="display:flex;gap:8px"><select id="mcif_editDay" class="mcif_input" style="flex:1"></select><input id="mcif_editTime" class="mcif_input" type="time" style="width:120px" value="${esc(task.time || '')}" /></div>
        <div style="height:8px"></div>
        <div><label class="small" style="color:var(--mcif-muted)">Notes</label><textarea id="mcif_editNotes" class="mcif_input" rows="3">${esc(task.notes || '')}</textarea></div>
        <div style="height:8px"></div>
        <div style="display:flex;justify-content:flex-end;gap:8px"><button id="mcif_deleteModal" class="mcif_btn mcif_ghost">Delete</button><button id="mcif_saveModal" class="mcif_btn">Save</button></div>
      `;
      // populate day options for this week
      const sel = inner.querySelector('#mcif_editDay');
      sel.innerHTML = generateDayOptions(dateKey);
      // attach events
      inner.querySelector('#mcif_closeModal').addEventListener('click', ()=> hideModal());
      inner.querySelector('#mcif_deleteModal').addEventListener('click', ()=>{
        if (confirm('Delete task?')) { snapshotAndRemoveTask(task.id, dateKey); hideModal(); }
      });
      inner.querySelector('#mcif_saveModal').addEventListener('click', ()=>{
        const newTitle = inner.querySelector('#mcif_editTitle').value.trim();
        const newTime = inner.querySelector('#mcif_editTime').value || '';
        const newNotes = inner.querySelector('#mcif_editNotes').value || '';
        const newDay = inner.querySelector('#mcif_editDay').value || dateKey;
        // remove from original
        pushUndo();
        const arr = STATE.tasks[dateKey] || [];
        const idx = arr.findIndex(x=>x.id === task.id);
        if (idx >= 0) arr.splice(idx,1);
        const updated = { ...task, title: newTitle, time: newTime, notes: newNotes, updatedAt: now() };
        STATE.tasks[newDay] = STATE.tasks[newDay] || [];
        STATE.tasks[newDay].push(updated);
        if (STATE.settings.autoSort) STATE.tasks[newDay].sort((a,b)=> (a.time||'').localeCompare(b.time||''));
        persistAll();
        renderTasksForDate(ymd(STATE.date));
        fillWeekColumns();
        hideModal();
        toast('Task saved');
      });
      showModal();
    }

    function showModal(){
      elements.modal.classList.add('show'); elements.modal.style.display = 'flex';
      elements.modal.setAttribute('aria-hidden','false');
    }
    function hideModal(){
      elements.modal.classList.remove('show'); elements.modal.style.display = 'none';
      elements.modal.setAttribute('aria-hidden','true');
    }

    function generateDayOptions(selected){
      const mon = startOfISOWeek(STATE.date);
      let html = '';
      for (let i=0;i<7;i++){
        const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
        const k = ymd(d);
        html += `<option value="${k}" ${k === selected ? 'selected':''}>${DAYS[i]} ${d.getMonth()+1}/${d.getDate()}</option>`;
      }
      return html;
    }

    /* timeline view for a day */
    function openTimelineForDay(dateKey){
      const dateParts = dateKey.split('-'); const d = new Date(dateParts[0], Number(dateParts[1])-1, Number(dateParts[2]));
      elements.timeline.textContent = '';
      const arr = STATE.tasks[dateKey] || [];
      // build simple rows
      for (let h = START_HOUR; h <= END_HOUR; h++){
        const row = document.createElement('div'); row.style.display='flex'; row.style.alignItems='center'; row.style.gap='8px'; row.style.marginBottom='6px';
        const label = document.createElement('div'); label.textContent = `${String(h).padStart(2,'0')}:00`; label.style.minWidth='56px'; label.style.color='var(--mcif-muted)'; label.style.fontWeight='800';
        const slot = document.createElement('div'); slot.style.flex='1'; slot.style.minHeight='36px'; slot.style.borderRadius='8px'; slot.style.padding='6px'; slot.style.border='1px dashed rgba(255,255,255,0.03)';
        // fill tasks whose hour matches h
        const tasksHere = arr.filter(t => t.time && Number(t.time.split(':')[0]) === h);
        for (const t of tasksHere){
          const tn = document.createElement('div'); tn.className = 'mcif_task'; tn.style.marginBottom='6px'; tn.innerHTML = `<div style="min-width:56px;color:var(--mcif-muted);font-weight:800">${esc(t.time)}</div><div style="flex:1;font-weight:700">${esc(t.title)}</div>`;
          tn.addEventListener('click', ()=> openEditTaskModal(t, dateKey));
          slot.appendChild(tn);
        }
        row.appendChild(label); row.appendChild(slot);
        elements.timeline.appendChild(row);
      }
    }

    /* sessions modal rendering */
    function openSessionsLog(){
      const modal = elements.logModal;
      const area = elements.sessionsArea;
      area.innerHTML = '';
      for (const s of STATE.sessions.slice(0,100)){
        const el = document.createElement('div'); el.style.marginBottom = '10px';
        el.innerHTML = `<div style="display:flex;justify-content:space-between"><strong>Session ${s.id}</strong><div style="font-size:12px;color:var(--mcif-muted)">${new Date(s.startedAt).toLocaleString()} ${s.endedAt?(' – '+new Date(s.endedAt).toLocaleString()):''}</div></div><div style="font-size:12px;color:var(--mcif-muted);margin-top:6px">Summaries: ${s.summaries?.length || 0}</div>`;
        if (s.summaries && s.summaries.length){
          for (const su of s.summaries) el.innerHTML += `<div style="margin-top:6px;padding:6px;border-radius:8px;background:rgba(255,255,255,0.01)">${new Date(su.ts).toLocaleTimeString()} – ${esc(su.text)}</div>`;
        }
        area.appendChild(el);
      }
      modal.classList.add('show'); modal.style.display = 'flex'; modal.setAttribute('aria-hidden','false');
    }
    function closeSessionsLog(){ elements.logModal.classList.remove('show'); elements.logModal.style.display = 'none'; elements.logModal.setAttribute('aria-hidden','true'); }

    /* export sessions */
    function exportSessions(){
      exportJSON(`mcif_sessions_${new Date().toISOString()}.json`, STATE.sessions);
    }

    /* Template save */
    function saveNewTemplate(){
      const name = elements.newTemplateName.value.trim();
      const body = elements.newTemplateBody.value.trim();
      if (!name || !body) { toast('Template name + body required'); return; }
      const lines = body.split('\n').map(l=>l.trim()).filter(Boolean);
      const items = lines.map(l=>{
        const m = l.match(/^(\d{1,2}:\d{2})\s*[—-]\s*(.+)$/);
        if (m) return { time: m[1], title: m[2] };
        return { time:'', title: l };
      });
      STATE.templates[name] = items;
      persistAll();
      elements.newTemplateName.value = ''; elements.newTemplateBody.value = '';
      renderTemplates(); toast('Template saved');
    }

    function applyTemplate(name){
      const n = decodeURIComponent(name);
      if (!STATE.templates[n]) { toast('Template missing'); return; }
      const key = ymd(STATE.date);
      pushUndo();
      STATE.tasks[key] = STATE.tasks[key] || [];
      for (const item of STATE.templates[n]) {
        STATE.tasks[key].push({ id: uid('t'), title: item.title, notes:'', time: item.time||'', createdAt: now(), updatedAt: now(), complete:false });
      }
      persistAll();
      renderTasksForDate(key); fillWeekColumns(); toast(`Template "${n}" applied`);
    }

    /* template select population (if any select exists) */
    function populateTemplateSelectIfExists(){
      const sel = document.getElementById('mcif_template_select');
      if (!sel) return;
      sel.innerHTML = '<option value="">Templates</option>';
      for (const k of Object.keys(STATE.templates || {})) sel.innerHTML += `<option value="${encodeURIComponent(k)}">${k}</option>`;
    }

    /* archives: simple UI in settings could list archives; for now persist only */
    function archiveCurrentWeek(){
      // store current week under key
      const wk = getISOWeekKey(STATE.date);
      storage.save(`${STORAGE_PREFIX}_archive_${wk}`, { key: wk, tasks: STATE.tasks, archivedAt: now() });
      STATE.archives.unshift(wk);
      if (STATE.archives.length > MAX_ARCHIVE_ENTRIES) STATE.archives.pop();
      persistAll();
    }

    /* weekly rollover check - archives previous week and clears tasks when settings.autoReset */
    function runWeeklyRolloverCheck(){
      setInterval(()=>{
        const newKey = getISOWeekKey(new Date());
        if (newKey !== STATE.weekKey){
          if (STATE.settings.autoReset){
            // archive previous week
            archiveCurrentWeek();
            // reset tasks for new week
            STATE.date = new Date();
            STATE.weekKey = newKey;
            STATE.tasks = {};
            persistAll();
            renderHeader();
            renderTasksForDate(ymd(STATE.date));
            renderWeekGrid();
            toast('Week changed — archived previous week and reset tasks');
          } else {
            // just switch weekKey and attempt load
            STATE.weekKey = newKey;
            renderHeader();
            renderWeekGrid();
            renderTasksForDate(ymd(STATE.date));
            toast('Week changed; autoReset is off');
          }
        }
      }, 30 * 1000);
    }

    /* public refresh */
    function refreshAll(){
      renderHeader();
      renderTasksForDate(ymd(STATE.date));
      renderWeekGrid();
      populateTemplateSelectIfExists();
      renderTemplates();
    }

    /* event wiring */
    function bindEvents(){
      // add task
      elements.addBtn.addEventListener('click', addTaskFromUI);
      elements.taskInput.addEventListener('keydown', (e)=> { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') addTaskFromUI(); });
      elements.todayBtn.addEventListener('click', ()=> { STATE.date = new Date(); STATE.weekKey = getISOWeekKey(STATE.date); renderHeader(); refreshAll(); });
      elements.prevWeek.addEventListener('click', ()=> { STATE.date.setDate(STATE.date.getDate() - 7); STATE.weekKey = getISOWeekKey(STATE.date); renderHeader(); refreshAll(); });
      elements.nextWeek.addEventListener('click', ()=> { STATE.date.setDate(STATE.date.getDate() + 7); STATE.weekKey = getISOWeekKey(STATE.date); renderHeader(); refreshAll(); });
      elements.settingsBtn.addEventListener('click', ()=> { elements.settingsModal.classList.add('show'); elements.settingsModal.style.display='flex'; elements.settingsModal.setAttribute('aria-hidden','false'); populateTemplateSelectIfExists(); renderTemplates(); });
      elements.closeSettingsModal.addEventListener('click', ()=> { elements.settingsModal.classList.remove('show'); elements.settingsModal.style.display='none'; elements.settingsModal.setAttribute('aria-hidden','true'); });
      // file uploads for audio
      elements.binauralFile.addEventListener('change', (e)=>{
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const url = URL.createObjectURL(f);
        elements.audioBinauralEl.src = url;
        AudioEngine.setBinauralSource(url);
        STATE.settings.lastPlayInteraction = now();
        persistAll();
        toast('Binaural track loaded (tap play)');
      });
      elements.ambientFile.addEventListener('change', (e)=>{
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const url = URL.createObjectURL(f);
        elements.audioAmbientEl.src = url;
        AudioEngine.setAmbientSource(url);
        STATE.settings.lastPlayInteraction = now();
        persistAll();
        toast('Ambient track loaded (tap play)');
      });
      elements.binauralPlay.addEventListener('click', async ()=>{
        try { await elements.audioBinauralEl.play(); elements.audioBinauralEl.volume = Number(elements.binauralVol.value); elements.audioAmbientEl.volume = Number(elements.ambientVol.value); AudioEngine.registerMediaSession(); toast('Binaural playing'); } catch(e){ toast('Playback blocked — tap screen then try again'); }
      });
      elements.ambientPlay.addEventListener('click', async ()=> {
        try { await elements.audioAmbientEl.play(); elements.audioAmbientEl.volume = Number(elements.ambientVol.value); AudioEngine.registerMediaSession(); toast('Ambient playing'); } catch(e){ toast('Playback blocked — tap screen then try again'); }
      });
      elements.binauralVol.addEventListener('input', (e)=> { elements.audioBinauralEl.volume = Number(e.target.value); STATE.settings.binauralVol = e.target.value; persistAll(); });
      elements.ambientVol.addEventListener('input', (e)=> { elements.audioAmbientEl.volume = Number(e.target.value); STATE.settings.ambientVol = e.target.value; persistAll(); });
      elements.startReading.addEventListener('click', ()=> { ReadingManager.start(); });
      elements.stopReading.addEventListener('click', ()=> { ReadingManager.stop(); });
      elements.dingerInterval.addEventListener('change', (e)=> { STATE.settings.dingerInterval = Number(e.target.value); persistAll(); });
      elements.vibrateDinger.addEventListener('change', (e)=> { STATE.settings.vibrateDinger = e.target.checked; persistAll(); });
      elements.recallMode.addEventListener('change', (e)=> { STATE.settings.recallMode = e.target.value; persistAll(); });
      elements.recallMin.addEventListener('change', (e)=> { STATE.settings.recallMin = Number(e.target.value); persistAll(); });
      elements.recallMax.addEventListener('change', (e)=> { STATE.settings.recallMax = Number(e.target.value); persistAll(); });
      elements.openSessions.addEventListener('click', ()=> { openSessionsLog(); });
      elements.closeLogBtn.addEventListener('click', ()=> closeSessionsLog());
      elements.exportSessions.addEventListener('click', ()=> { ReadingManager.exportSessions(); });
      elements.saveTemplateBtn.addEventListener('click', saveNewTemplate);
      // modal close on backdrop click
      document.querySelectorAll('.mcif_modal_backdrop').forEach(m => m.addEventListener('click', (e)=> { if (e.target === m) { m.classList.remove('show'); m.style.display='none'; m.setAttribute('aria-hidden','true'); } }));
      // undo via keyboard
      document.addEventListener('keydown', (e)=> { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { popUndo(); } if (e.key === 'Escape') { document.querySelectorAll('.mcif_modal_backdrop').forEach(m=>{ m.classList.remove('show'); m.style.display='none'; m.setAttribute('aria-hidden','true'); }); } });
    }

    return {
      buildShell,
      populateThemeChips,
      applyTheme,
      renderHeader,
      renderTasksForDate,
      renderWeekGrid,
      fillWeekColumns,
      refreshAll,
      bindEvents,
      showRecallPrompt: function({ onAnswer, onCancel, stage }){
        // build recall modal with a textarea prompt
        const inner = elements.modalInner;
        const stageLabel = stage ? ` — ${stage}` : '';
        inner.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><strong>Recall Prompt${stageLabel}</strong><button id="mcif_closeModal2" class="mcif_btn mcif_ghost">Close</button></div>
          <div style="height:8px"></div>
          <div><p style="margin:0 0 6px 0;color:var(--mcif-muted)">Type a 1–2 sentence summary of what you just read.</p>
          <textarea id="mcif_recall_input" rows="4" class="mcif_input"></textarea></div>
          <div style="height:8px"></div>
          <div style="display:flex;justify-content:flex-end;gap:8px"><button id="mcif_cancelRecall" class="mcif_btn mcif_ghost">Cancel</button><button id="mcif_saveRecall" class="mcif_btn">Save</button></div>`;
        elements.modal.classList.add('show'); elements.modal.style.display='flex'; elements.modal.setAttribute('aria-hidden','false');
        document.getElementById('mcif_closeModal2').addEventListener('click', ()=> { elements.modal.classList.remove('show'); elements.modal.style.display='none'; elements.modal.setAttribute('aria-hidden','true'); onCancel && onCancel(); });
        document.getElementById('mcif_cancelRecall').addEventListener('click', ()=> { elements.modal.classList.remove('show'); elements.modal.style.display='none'; elements.modal.setAttribute('aria-hidden','true'); onCancel && onCancel(); });
        document.getElementById('mcif_saveRecall').addEventListener('click', ()=> {
          const val = document.getElementById('mcif_recall_input').value.trim();
          if (!val) { toast('Please type a short summary.'); return; }
          elements.modal.classList.remove('show'); elements.modal.style.display='none'; elements.modal.setAttribute('aria-hidden','true');
          onAnswer && onAnswer(val, stage || null);
        });
      },
      onReadingStart: function(sess){ /* UI reactions on reading start */ elements.startReading.disabled = true; elements.stopReading.disabled = false; },
      onReadingStop: function(){ elements.startReading.disabled = false; elements.stopReading.disabled = true; }
    };
  })();

  /* =========================
     Initialization
     ========================= */

  function init(){
    loadState();
    UIManager.buildShell();
    UIManager.populateThemeChips();
    UIManager.refreshAll();
    UIManager.bindEvents();
    // set initial audio volumes if any stored
    if (STATE.settings.binauralVol) document.getElementById('mcif_binauralVol').value = STATE.settings.binauralVol;
    if (STATE.settings.ambientVol) document.getElementById('mcif_ambientVol').value = STATE.settings.ambientVol;
    // add listeners for uploads to set audio engine
    const binauralEl = document.getElementById('mcif_audio_binaural');
    const ambientEl = document.getElementById('mcif_audio_ambient');
    // wire audio engine to DOM elements
    AudioEngine.binaural = binauralEl; AudioEngine.ambient = ambientEl;
    // restore last session settings into audio elements
    if (STATE.sessions && STATE.sessions.length){
      const last = STATE.sessions[0];
      if (last && last.binauralSrc) { binauralEl.src = last.binauralSrc; }
      if (last && last.ambientSrc) { ambientEl.src = last.ambientSrc; }
    }
    // weekly rollover check
    (function weeklyRollover(){ setInterval(()=>{
      const newKey = getISOWeekKey(new Date());
      if (newKey !== STATE.weekKey){
        if (STATE.settings.autoReset){
          // archive & reset
          storage.save(`${STORAGE_PREFIX}_archive_${STATE.weekKey}`, { key: STATE.weekKey, tasks: STATE.tasks, archivedAt: now() });
          STATE.archives.unshift(STATE.weekKey);
          if (STATE.archives.length > MAX_ARCHIVE_ENTRIES) STATE.archives.pop();
          // reset tasks
          STATE.tasks = {}; persistAll();
          STATE.date = new Date();
          STATE.weekKey = newKey;
          UIManager.refreshAll();
          toast('ISO week changed — archived previous week and reset tasks');
        } else {
          STATE.weekKey = newKey; UIManager.renderHeader();
        }
      }
    }, 30 * 1000); })();

    // autosave on visibility change before unload
    window.addEventListener('beforeunload', ()=> persistAll());
    document.addEventListener('visibilitychange', ()=> { if (document.visibilityState === 'hidden') persistAll(); });
    // expose MCIF object for console
    window.MCIF = {
      STATE, pushUndo, popUndo, exportJSON, exportSessions: () => UIManager.exportSessions, ReadingManager
    };
    // initial UI state
    UIManager.renderHeader();
    UIManager.renderTasksForDate(ymd(STATE.date));
    UIManager.renderWeekGrid();
    UIManager.fillWeekColumns();
    UIManager.renderTemplates && UIManager.renderTemplates();
    toast('MCIF Scheduler ready');
  }

  /* expose init */
  return { init, storage, STATE, AudioEngine, ReadingManager, UIManager };
})();

/* Auto-init when script loads */
document.addEventListener('DOMContentLoaded', ()=> { MCIF.init(); });