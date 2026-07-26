import { SYMPTOMS, intensityWord, type Flash, type Sketch, type Symptom } from '@tempra/shared';
// Fonts are bundled, not fetched from a CDN. Offline is load-bearing here, and
// the typography is part of the design, not a progressive enhancement.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import './style.css';
import sprite from './_sprite.html?raw';
import {
  cachedState,
  projectState,
  endFlash,
  fetchState,
  flushOutbox,
  login,
  pendingCount,
  startFlash,
  updateFlash,
  Unauthorized,
  type AppState,
  type PendingFlash,
} from './api.js';
import { renderSketch, SketchPad } from './draw.js';

// ---------------------------------------------------------------- vocabulary

const ICON: Record<Symptom, string> = {
  sweating: 'i-sweat',
  chills: 'i-chills',
  palpitations: 'i-heart',
  anxiety: 'i-anxiety',
  flushing: 'i-flush',
  mood: 'i-mood',
  nausea: 'i-nausea',
  dizziness: 'i-dizzy',
  headache: 'i-headache',
};

const TILE_LABEL: Record<Symptom, string> = {
  sweating: 'Sweating',
  chills: 'Chills',
  palpitations: 'Heart<br>racing',
  anxiety: 'Anxiety',
  flushing: 'Flushing',
  mood: 'Mood<br>changes',
  nausea: 'Nausea',
  dizziness: 'Dizziness',
  headache: 'Headache',
};

const PRIMARY_COUNT = 6;

// ------------------------------------------------------------------ helpers

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

const clock = (iso: string): string => timeFmt.format(new Date(iso));
const dayKey = (iso: string): string => new Date(iso).toDateString();

const elapsed = (fromIso: string): string => {
  const secs = Math.max(0, Math.floor((Date.now() - Date.parse(fromIso)) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

// -------------------------------------------------------------------- state

type Tab = 'log' | 'history' | 'export';

interface Draft {
  intensity: number;
  symptoms: Set<Symptom>;
  note: string;
  sketch: Sketch | null;
  showAll: boolean;
  mode: 'write' | 'draw';
}

const blankDraft = (): Draft => ({
  intensity: 4,
  symptoms: new Set(),
  note: '',
  sketch: null,
  showAll: false,
  mode: 'write',
});

/**
 * While a flash is running the log screen edits *that* flash, so the controls
 * must start from what was actually recorded. Leaving them at the blank
 * defaults meant tapping "Save these details" silently rewrote the intensity to
 * 4 — replacing something the user observed with something nobody chose.
 */
const draftFrom = (f: PendingFlash): Draft => ({
  intensity: f.intensity ?? 4,
  symptoms: new Set(f.symptoms),
  note: f.note ?? '',
  sketch: f.sketch,
  // Keep the extra symptoms revealed if any of them are already selected,
  // otherwise they would look unselected while quietly being set.
  showAll: f.symptoms.some((s) => SYMPTOMS.indexOf(s) >= PRIMARY_COUNT),
  mode: f.sketch ? 'draw' : 'write',
});

/**
 * `serverState` is what the server last told us. `state` is what the user sees:
 * the same thing with any queued offline writes replayed on top. Rendering the
 * server's view alone would make an offline log look like it failed.
 */
let serverState: AppState = cachedState();
let state: AppState = projectState(serverState);
let tab: Tab = 'log';
let draft: Draft = blankDraft();
let ending = false;
let endMinutes = 0;
let endNote = '';
let authed = true;
let online = navigator.onLine;
let viewing: Flash | null = null;

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('missing #app');

document.body.insertAdjacentHTML('afterbegin', sprite);

// -------------------------------------------------------------------- toast

let toastTimer: number | undefined;
const toast = (msg: string): void => {
  let el = document.querySelector<HTMLDivElement>('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  window.clearTimeout(toastTimer);
  const node = el;
  toastTimer = window.setTimeout(() => node.classList.remove('show'), 2600);
};

// ------------------------------------------------------------------- render

const tabsHtml = (): string => `
  <nav class="tabs">
    <a class="${tab === 'log' ? 'on' : ''}" data-tab="log" href="#log"><svg><use href="#i-log"/></svg>Log</a>
    <a class="${tab === 'history' ? 'on' : ''}" data-tab="history" href="#history"><svg><use href="#i-history"/></svg>History</a>
    <a class="${tab === 'export' ? 'on' : ''}" data-tab="export" href="#export"><svg><use href="#i-export"/></svg>Export</a>
  </nav>
  <div class="homebar"><i></i></div>
`;

const bannersHtml = (): string => {
  const bits: string[] = [];
  const pending = pendingCount();
  if (!online || pending > 0) {
    bits.push(
      `<div class="banner sync-bar">${
        online
          ? `<span>Catching up — <b>${pending}</b> waiting to sync</span>`
          : `<span>Offline. Everything still saves${pending ? ` — <b>${pending}</b> queued` : ''}.</span>`
      }</div>`,
    );
  }
  if (state.insecure) {
    bits.push(
      `<div class="banner insecure-bar"><span>No passphrase set — this app is open to anyone with the link.</span></div>`,
    );
  }
  return bits.join('');
};

const symptomsHtml = (selected: Set<Symptom>, showAll: boolean): string => {
  const tiles = SYMPTOMS.map((s, i) => {
    const hidden = !showAll && i >= PRIMARY_COUNT ? ' hidden' : '';
    const on = selected.has(s) ? ' on' : '';
    return `<button type="button" class="sym${on}${hidden}" data-sym="${s}" aria-pressed="${selected.has(s)}"><svg><use href="#${ICON[s]}"/></svg>${TILE_LABEL[s]}</button>`;
  }).join('');
  const more = showAll
    ? ''
    : `<button class="more" type="button" data-more="1">${SYMPTOMS.length - PRIMARY_COUNT} more +</button>`;
  return `<div class="symptoms">${tiles}${more}</div>`;
};

const noteHtml = (d: Draft): string => `
  <div class="panel">
    <p class="lab">
      A note
      <span class="seg" role="group" aria-label="Note format">
        <button type="button" data-mode="write" aria-pressed="${d.mode === 'write'}">
          <svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h14M5 17h8"/></svg>Write
        </button>
        <button type="button" data-mode="draw" aria-pressed="${d.mode === 'draw'}">
          <svg viewBox="0 0 24 24"><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z"/></svg>Draw
        </button>
      </span>
    </p>
    <div class="write${d.mode === 'draw' ? ' off' : ''}">
      <textarea class="field" id="note" rows="2" placeholder="Woke up warm, second coffee…">${esc(d.note)}</textarea>
    </div>
    <div class="pad${d.mode === 'draw' ? ' on' : ''}">
      <button type="button" class="padslot${d.sketch ? ' filled' : ''}">
        ${
          d.sketch
            ? `<canvas class="slot-canvas"></canvas><span class="txt"><b>Sketch saved</b><span>Tap to change it</span></span>`
            : `<span class="quill"><svg viewBox="0 0 24 24"><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z"/><path d="M14 7l3 3"/></svg></span>
               <span class="txt"><b>Draw how it feels</b><span>Opens a full page to sketch on</span></span>`
        }
      </button>
    </div>
  </div>
`;

const drawoverHtml = (): string => `
  <div class="drawover" role="dialog" aria-modal="true" aria-label="Draw how it feels">
    <div class="drawbar">
      <button type="button" class="cancel">Cancel</button>
      <span class="ttl">How it feels</span>
      <button type="button" class="done">Done</button>
    </div>
    <div class="canvas-wrap">
      <canvas aria-label="Sketch how the flash feels"></canvas>
      <div class="canvas-hint">Draw where it starts,<br>how it moves, what shape it has</div>
    </div>
    <div class="inkbar">
      <button class="ink" data-ink="#B33F66" aria-pressed="true" aria-label="Berry"><i style="background:#B33F66"></i></button>
      <button class="ink" data-ink="#8A6A22" aria-pressed="false" aria-label="Gold"><i style="background:#8A6A22"></i></button>
      <button class="ink" data-ink="#3D6B4A" aria-pressed="false" aria-label="Green"><i style="background:#3D6B4A"></i></button>
      <button class="ink" data-ink="#5E3A4C" aria-pressed="false" aria-label="Plum"><i style="background:#5E3A4C"></i></button>
      <span class="spacer"></span>
      <button class="penbtn undo" disabled>Undo</button>
      <button class="penbtn clear" disabled>Clear</button>
    </div>
    <div class="homebar"><i></i></div>
  </div>
`;

const logView = (): string => {
  const active = state.active;
  const d = draft;
  const pct = ((d.intensity - 1) / 9) * 100;

  const ribbon = active
    ? `<div class="ribbon">
         <span class="pulse"></span>
         <span><b class="t ribbon-clock">${elapsed(active.startedAt)}</b>
           <span class="s">Active since ${clock(active.startedAt)}${active.intensity ? ` · Intensity ${active.intensity}` : ''}${
             active.pending ? ' · Saved on this phone' : ''
           }</span></span>
         <button class="end" data-act="open-end">End</button>
       </div>`
    : `<div class="empty-ribbon"><p>Nothing running right now</p></div>`;

  return `
    <div class="stage">
      ${bannersHtml()}
      ${ribbon}

      <div class="scroll">
        <div class="hd">
          <p class="kicker">${active ? 'Happening now' : 'New entry'}</p>
          <h2 class="h1">${active ? 'How is <em>it going?</em>' : 'How does this <em>one feel?</em>'}</h2>
        </div>
        <div class="panel warm intensity">
          <div class="gauge">
            <span class="val">${d.intensity}<small>/10</small></span>
            <span class="gauge-txt">
              <span class="lab">Intensity</span>
              <span class="word">${intensityWord(d.intensity)}</span>
            </span>
          </div>
          <input class="slider" type="range" min="1" max="10" step="1" value="${d.intensity}"
                 aria-label="Intensity from 1 to 10" style="--pct:${pct}%">
          <div class="key"><span>Barely there</span><span>Overwhelming</span></div>
        </div>

        <div class="panel">
          <p class="lab">What came with it ${d.symptoms.size ? `<u>${d.symptoms.size} chosen</u>` : ''}</p>
          ${symptomsHtml(d.symptoms, d.showAll)}
        </div>

        ${noteHtml(d)}
      </div>

      <div class="cta">
        <button class="btn btn-primary" data-act="${active ? 'save' : 'begin'}">
          ${active ? 'Save these details' : `Begin flash · ${clock(new Date().toISOString())}`}
        </button>
      </div>

      ${tabsHtml()}
      ${drawoverHtml()}
    </div>
  `;
};

const endView = (): string => {
  const active = state.active;
  if (!active) return logView();
  const pct = ((endMinutes - 1) / 89) * 100;
  const endsAt = new Date(Date.parse(active.startedAt) + endMinutes * 60_000).toISOString();
  return `
    <div class="stage">
      <div class="sheetbar">
        <button class="x" aria-label="Close" data-act="cancel-end">✕</button>
        <span>Ending this flash</span>
      </div>
      <div class="scroll">
        <div class="hd">
          <p class="kicker">Started ${clock(active.startedAt)}</p>
          <h2 class="h1">How long did <em>it last?</em></h2>
        </div>
        <div class="panel warm">
          <p class="lab">Duration <u>measured</u></p>
          <div class="gauge">
            <span class="val dur-val">${endMinutes}<small>min</small></span>
            <span class="word dur-end">ends ${clock(endsAt)}</span>
          </div>
          <input class="slider dur" type="range" min="1" max="90" step="1" value="${endMinutes}"
                 aria-label="Duration in minutes, 1 to 90" style="--pct:${pct}%">
          <div class="key"><span>1 min</span><span>90 min</span></div>
          <p class="hintline">We timed ${endMinutes} minutes. Drag only if that's not right.</p>
        </div>
        <div class="panel">
          <p class="lab">Add a closing note</p>
          <textarea class="field" id="endnote" rows="2" placeholder="Passed after opening a window…">${esc(endNote)}</textarea>
        </div>
      </div>
      <div class="cta">
        <button class="btn btn-primary" data-act="confirm-end">Confirm end · ${endMinutes} min</button>
        <button class="btn btn-quiet" style="margin-top:6px" data-act="cancel-end">Cancel — leave it running</button>
      </div>
      ${tabsHtml()}
    </div>
  `;
};

const entryHtml = (f: PendingFlash): string => {
  const calm = (f.intensity ?? 5) <= 4 ? ' calm' : '';
  const when =
    f.endedAt && f.durationMin !== null
      ? `${clock(f.startedAt)} → ${clock(f.endedAt)}`
      : clock(f.startedAt);
  const bits: string[] = [];
  if (f.intensity) bits.push(`Intensity ${f.intensity}`);
  if (f.symptoms.length) {
    bits.push(f.symptoms.map((s) => TILE_LABEL[s].replace('<br>', ' ')).join(', '));
  }
  const src =
    f.source === 'homekit'
      ? '<span class="src">Bedside</span>'
      : f.source === 'shortcut'
        ? '<span class="src">Shortcut</span>'
        : '';

  const rail =
    f.status === 'ended' && f.durationMin !== null
      ? `<span class="pill">${f.durationMin} min</span>`
      : f.status === 'active'
        ? `<span class="pill">Running</span>`
        : `<span class="pill none">No end</span>`;

  // Notes and sketches are shown as themselves. A badge saying "has a sketch"
  // makes the reader open it just to find out what it was.
  const note = f.note ? `<p class="note">${esc(f.note)}</p>` : '';
  const thumb = f.sketch
    ? `<button class="thumb" data-view="${f.id}" aria-label="Open sketch"><canvas data-sketch="${f.id}"></canvas></button>`
    : '';

  return `
    <div class="entry" data-entry="${f.id}">
      <span class="stem${calm}"></span>
      <div>
        <p class="when">${when}${
          f.pending
            ? '<span class="pending-dot" role="img" aria-label="Not synced yet"></span>'
            : ''
        }</p>
        <p class="meta">${bits.join(' · ') || 'No details'} ${src}</p>
        ${note}
      </div>
      <div class="rail">${rail}${thumb}</div>
    </div>
  `;
};

const historyView = (): string => {
  const flashes = state.recent;
  const today = flashes.filter((f) => dayKey(f.startedAt) === new Date().toDateString());
  const timed = flashes.filter((f) => f.durationMin !== null);
  const withIntensity = flashes.filter((f) => f.intensity !== null);
  const avgPeak = withIntensity.length
    ? (withIntensity.reduce((a, f) => a + (f.intensity ?? 0), 0) / withIntensity.length).toFixed(1)
    : '—';
  const avgDur = timed.length
    ? Math.round(timed.reduce((a, f) => a + (f.durationMin ?? 0), 0) / timed.length)
    : null;

  const groups = new Map<string, Flash[]>();
  for (const f of flashes) {
    const k = dayKey(f.startedAt);
    const list = groups.get(k);
    if (list) list.push(f);
    else groups.set(k, [f]);
  }

  const overnight = today.filter((f) => new Date(f.startedAt).getHours() < 5).length;

  const body = flashes.length
    ? [...groups.entries()]
        .map(
          ([key, list]) => `
          <div class="panel daygroup">
            <p class="dayhead">${dayFmt.format(new Date(key))}</p>
            ${list.map(entryHtml).join('')}
          </div>`,
        )
        .join('')
    : `<div class="panel"><p class="empty-note">Nothing logged yet.<br>When one arrives, tap <b>Begin flash</b> — the details can wait until after.</p></div>`;

  return `
    <div class="stage">
      ${bannersHtml()}
      <div class="scroll">
        <div class="hd">
          <p class="kicker">${dayFmt.format(new Date())}</p>
          <h2 class="h1">${
            today.length
              ? `${today.length} today,<br><em>${overnight || 'none'} overnight</em>`
              : 'A quiet day <em>so far</em>'
          }</h2>
        </div>
        <div class="stats">
          <div class="stat"><b>${today.length}</b><span>Today</span></div>
          <div class="stat"><b>${avgPeak}</b><span>Avg peak</span></div>
          <div class="stat"><b>${avgDur ?? '—'}${avgDur ? '<em>m</em>' : ''}</b><span>Avg of ${timed.length} timed</span></div>
        </div>
        ${body}
      </div>
      ${tabsHtml()}
    </div>
  `;
};

const exportView = (): string => {
  const b = state.bedside;
  const bedsideLine =
    b.health === 'ok'
      ? `<span class="pill">Heartbeat ${clock(b.lastHeartbeatAt ?? '')}</span>`
      : b.health === 'stale'
        ? `<span class="pill none">Silent since ${clock(b.lastHeartbeatAt ?? '')}</span>`
        : `<span class="pill none">No heartbeat set up</span>`;

  return `
    <div class="stage">
      ${bannersHtml()}
      <div class="scroll">
        <div class="hd">
          <p class="kicker">Your data</p>
          <h2 class="h1">Take it <em>with you</em></h2>
        </div>
        <div class="panel">
          <p class="lab">Download</p>
          <a class="btn btn-primary" href="/api/export.csv" download>Spreadsheet (CSV)</a>
          <a class="btn btn-quiet" style="margin-top:8px" href="/api/export.json" download>Everything (JSON)</a>
          <p class="hintline">CSV opens in Numbers or Excel. JSON keeps each sketch as the strokes you drew, so nothing is flattened.</p>
        </div>

        <div class="panel gilt">
          <p class="lab">Bedside button</p>
          <div class="entry" style="border:0;padding:0">
            <span class="stem calm"></span>
            <div>
              <p class="when">${b.lastPressAt ? `Last press ${clock(b.lastPressAt)}` : 'No presses recorded'}</p>
              <p class="meta">Presses arrive from Hubitat over the internet.</p>
            </div>
            <div class="rail">${bedsideLine}</div>
          </div>
          <p class="hintline">Nothing here can prove the button is reachable — it talks to us, never the other way round. A heartbeat rule is the only thing that makes silence mean something.</p>
        </div>

        <div class="panel">
          <p class="lab">This build</p>
          <p class="hintline" style="margin-top:0">Version <b>${esc(state.commit)}</b>. ${pendingCount()} change(s) waiting to sync.</p>
          <button class="btn btn-quiet" data-act="logout">Sign out</button>
        </div>
      </div>
      ${tabsHtml()}
    </div>
  `;
};

const loginView = (msg = ''): string => `
  <div class="login">
    <p class="wordmark">Tempra</p>
    <p>A quiet record of how you feel. Enter your passphrase to continue.</p>
    <input type="password" id="pass" autocomplete="current-password" placeholder="Passphrase" />
    <p class="err">${esc(msg)}</p>
    <button class="btn btn-primary" data-act="login">Unlock</button>
  </div>
`;

const viewerHtml = (f: Flash): string => `
  <div class="viewer open" role="dialog" aria-modal="true">
    <div class="drawbar">
      <button type="button" class="cancel" data-act="close-viewer">Close</button>
      <span class="ttl">${clock(f.startedAt)}</span>
      <span style="width:64px"></span>
    </div>
    <div class="canvas-wrap"><canvas id="viewer-canvas"></canvas></div>
    ${f.note ? `<p class="viewer-note">${esc(f.note)}</p>` : ''}
    <div class="homebar"><i></i></div>
  </div>
`;

const paintSketches = (): void => {
  for (const canvas of root.querySelectorAll<HTMLCanvasElement>('canvas[data-sketch]')) {
    const id = canvas.dataset.sketch;
    const flash = state.recent.find((f) => f.id === id);
    const sketch = flash?.sketch;
    if (sketch) requestAnimationFrame(() => renderSketch(canvas, sketch, 3));
  }
  const slot = root.querySelector<HTMLCanvasElement>('.slot-canvas');
  const drafted = draft.sketch;
  if (slot && drafted) requestAnimationFrame(() => renderSketch(slot, drafted, 2));
};

const render = (): void => {
  if (!authed) {
    root.innerHTML = loginView();
    root.querySelector<HTMLInputElement>('#pass')?.focus();
    return;
  }

  const screen =
    ending && state.active
      ? endView()
      : tab === 'history'
        ? historyView()
        : tab === 'export'
          ? exportView()
          : logView();

  root.innerHTML = `<div class="screen">${screen}${viewing ? viewerHtml(viewing) : ''}</div>`;

  paintSketches();
  wireDrawing();

  const seen = viewing?.sketch;
  if (seen) {
    const c = root.querySelector<HTMLCanvasElement>('#viewer-canvas');
    if (c) requestAnimationFrame(() => renderSketch(c, seen, 8));
  }
};

// ------------------------------------------------------------------ drawing

let pad: SketchPad | null = null;

const wireDrawing = (): void => {
  const over = root.querySelector<HTMLElement>('.drawover');
  const canvas = over?.querySelector('canvas');
  if (!over || !canvas) {
    pad = null;
    return;
  }

  const wrap = over.querySelector<HTMLElement>('.canvas-wrap');
  const undo = over.querySelector<HTMLButtonElement>('.undo');
  const clear = over.querySelector<HTMLButtonElement>('.clear');

  pad = new SketchPad(canvas, (hasInk) => {
    wrap?.classList.toggle('inked', hasInk);
    if (undo) undo.disabled = !hasInk;
    if (clear) clear.disabled = !hasInk;
  });

  for (const b of over.querySelectorAll<HTMLButtonElement>('.ink')) {
    b.addEventListener('click', () => {
      pad?.setInk(b.dataset.ink ?? '#B33F66');
      for (const x of over.querySelectorAll('.ink')) {
        x.setAttribute('aria-pressed', String(x === b));
      }
    });
  }
  undo?.addEventListener('click', () => pad?.undo());
  clear?.addEventListener('click', () => pad?.clear());

  over.querySelector('.cancel')?.addEventListener('click', () => {
    pad?.restore();
    over.classList.remove('open');
  });
  over.querySelector('.done')?.addEventListener('click', () => {
    draft.sketch = pad?.value() ?? null;
    over.classList.remove('open');
    render();
  });
};

const openDrawover = (): void => {
  const over = root.querySelector<HTMLElement>('.drawover');
  if (!over || !pad) return;
  pad.load(draft.sketch);
  pad.snapshot();
  over.classList.add('open');
  requestAnimationFrame(() => pad?.fit());
};

// ------------------------------------------------------------------ actions

/**
 * Which flash the on-screen controls are currently editing. Reseeding only when
 * this changes means a periodic refresh can never wipe edits in progress.
 */
let draftFor: string | null = null;

const syncDraftToActive = (): void => {
  const active = state.active;
  const id = active?.id ?? null;
  if (id === draftFor) return;
  draftFor = id;
  draft = active ? draftFrom(active) : blankDraft();
};

const refresh = async (): Promise<void> => {
  try {
    serverState = await fetchState();
    authed = true;
  } catch (err) {
    // Being offline is not an error here: the cached state is still the truth
    // as far as this device knows.
    if (err instanceof Unauthorized) authed = false;
  }
  state = projectState(serverState);
  syncDraftToActive();
  render();
};

const beginFlash = async (): Promise<void> => {
  const ok = await startFlash({
    startedAt: new Date().toISOString(),
    intensity: draft.intensity,
    symptoms: [...draft.symptoms],
    note: draft.note || null,
    sketch: draft.sketch,
    source: 'app',
  });
  // The draft is reseeded from whatever becomes active; syncDraftToActive owns
  // it so there is only one place that decides what the controls show.
  toast(ok ? 'Flash started' : 'Saved — will sync when back online');
  await refresh();
};

const saveDetails = async (): Promise<void> => {
  const active = state.active;
  if (!active) return;
  const ok = await updateFlash(active.id, {
    intensity: draft.intensity,
    symptoms: [...draft.symptoms],
    note: draft.note || null,
    sketch: draft.sketch,
  });
  toast(ok ? 'Saved' : 'Saved — will sync when back online');
  await refresh();
};

const confirmEnd = async (): Promise<void> => {
  const active = state.active;
  if (!active) return;
  const endedAt = new Date(Date.parse(active.startedAt) + endMinutes * 60_000).toISOString();
  if (endNote.trim()) await updateFlash(active.id, { note: endNote.trim() });
  const ok = await endFlash(active.id, { endedAt });
  ending = false;
  endNote = '';
  toast(ok ? `Ended · ${endMinutes} min` : 'Saved — will sync when back online');
  await refresh();
};

// ------------------------------------------------------------------- events

root.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const btn = target.closest<HTMLElement>(
    '[data-act],[data-tab],[data-sym],[data-more],[data-mode],[data-view],.padslot',
  );
  if (!btn) return;

  if (btn.dataset.tab) {
    e.preventDefault();
    tab = btn.dataset.tab as Tab;
    ending = false;
    render();
    return;
  }

  if (btn.classList.contains('padslot')) {
    openDrawover();
    return;
  }

  if (btn.dataset.mode) {
    draft.mode = btn.dataset.mode as Draft['mode'];
    render();
    return;
  }

  if (btn.dataset.more) {
    draft.showAll = true;
    render();
    return;
  }

  if (btn.dataset.sym) {
    const s = btn.dataset.sym as Symptom;
    if (draft.symptoms.has(s)) draft.symptoms.delete(s);
    else draft.symptoms.add(s);
    render();
    return;
  }

  if (btn.dataset.view) {
    viewing = state.recent.find((f) => f.id === btn.dataset.view) ?? null;
    render();
    return;
  }

  switch (btn.dataset.act) {
    case 'login': {
      const value = root.querySelector<HTMLInputElement>('#pass')?.value ?? '';
      void login(value).then(async (ok) => {
        if (ok) {
          authed = true;
          await refresh();
        } else {
          root.innerHTML = loginView('That passphrase did not match.');
          root.querySelector<HTMLInputElement>('#pass')?.focus();
        }
      });
      break;
    }
    case 'logout':
      void fetch('/api/session', { method: 'DELETE' }).then(() => {
        authed = false;
        render();
      });
      break;
    case 'open-end': {
      const active = state.active;
      if (!active) break;
      endMinutes = Math.max(
        1,
        Math.min(90, Math.round((Date.now() - Date.parse(active.startedAt)) / 60_000)),
      );
      ending = true;
      render();
      break;
    }
    case 'cancel-end':
      ending = false;
      render();
      break;
    case 'confirm-end':
      void confirmEnd();
      break;
    case 'begin':
      void beginFlash();
      break;
    case 'save':
      void saveDetails();
      break;
    case 'close-viewer':
      viewing = null;
      render();
      break;
  }
});

root.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement | HTMLTextAreaElement;

  if (el.id === 'note') {
    draft.note = el.value;
    return;
  }
  if (el.id === 'endnote') {
    endNote = el.value;
    return;
  }

  if (el.classList.contains('dur')) {
    endMinutes = Number(el.value);
    const active = state.active;
    el.style.setProperty('--pct', `${((endMinutes - 1) / 89) * 100}%`);
    const val = root.querySelector('.dur-val');
    if (val) val.innerHTML = `${endMinutes}<small>min</small>`;
    const ends = root.querySelector('.dur-end');
    if (ends && active) {
      ends.textContent = `ends ${clock(
        new Date(Date.parse(active.startedAt) + endMinutes * 60_000).toISOString(),
      )}`;
    }
    const cta = root.querySelector('[data-act="confirm-end"]');
    if (cta) cta.textContent = `Confirm end · ${endMinutes} min`;
    const hint = root.querySelector('.hintline');
    if (hint) hint.textContent = `We timed ${endMinutes} minutes. Drag only if that's not right.`;
    return;
  }

  if (el.classList.contains('slider')) {
    draft.intensity = Number(el.value);
    // Patch in place: a full re-render would steal focus from the slider
    // mid-drag and drop the gesture.
    el.style.setProperty('--pct', `${((draft.intensity - 1) / 9) * 100}%`);
    const val = root.querySelector('.gauge .val');
    if (val) val.innerHTML = `${draft.intensity}<small>/10</small>`;
    const word = root.querySelector('.gauge .word');
    if (word) word.textContent = intensityWord(draft.intensity);
  }
});

root.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.target as HTMLElement).id === 'pass') {
    root.querySelector<HTMLElement>('[data-act="login"]')?.click();
  }
});

// The ribbon is a clock; it has to tick without redrawing the form under it.
window.setInterval(() => {
  const el = root.querySelector('.ribbon-clock');
  if (el && state.active) el.textContent = elapsed(state.active.startedAt);
}, 1000);

const goOnline = async (): Promise<void> => {
  online = navigator.onLine;
  if (online) {
    const sent = await flushOutbox();
    if (sent > 0) toast(`Synced ${sent} change${sent === 1 ? '' : 's'}`);
  }
  await refresh();
};

window.addEventListener('online', () => void goOnline());
window.addEventListener('offline', () => {
  online = false;
  render();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void goOnline();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}

render();
void goOnline();
