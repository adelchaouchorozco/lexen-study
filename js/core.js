/* =====================================================================
   Core: timing, keyboard, participant session, data buffer, upload.

   The timing rules here are the ones that matter scientifically, and
   they are the product of measurement rather than assumption:

   * Durations are frame-locked while the page is visible, with a
     setTimeout backstop. requestAnimationFrame stops firing entirely in
     a hidden or occluded window, so a pure rAF loop freezes the task the
     moment a participant switches away and never recovers.
   * The rAF refinement of a screen's onset is accepted only if it lands
     promptly. A frame that arrives hundreds of ms late would otherwise
     move the reference and make the recorded duration meaningless — it
     reported 5 ms for a 300 ms fixation before this guard.
   * Keys are matched on e.code as well as e.key, so a participant with a
     non-Latin keyboard layout active can still respond.
   ===================================================================== */
"use strict";

/* Bump this whenever anything under data/ or js/ changes, and keep the
   ?v= on the script tags in index.html in step. Browsers cache both the
   code and the generated task data aggressively; a participant running a
   stale mixture of the two is the kind of bug that is invisible until the
   data comes back wrong. */
const ASSET_VERSION = "2026-10-09a";

const CFG = {
  /* Where the data goes. DataPipe (pipe.jspsych.org) writes each snapshot
     into a folder in your Google Drive and costs nothing. (It used to write
     to OSF; OSF support ends 16 November 2026.) Empty = local download only. */
  DATAPIPE_ID: "93ZZudMPGhHX",

  /* Second sink: a Cloudflare Worker that mirrors every snapshot to R2 and
     answers "has this participant already finished?". Empty = neither the
     mirror nor the repeat check is active. See worker/README.md. */
  MIRROR_URL: "",          // e.g. "https://lexen-study-data.<you>.workers.dev"

  CONTACT: "adel.chaouchorozco@cityu.edu.hk",
  COMPLETION_URL: "",

  /* SONA credit granting. Paste the "client-side completion URL" SONA shows
     in the study's settings (it ends in survey_code=XXXX); the XXXX is
     replaced with the student's survey code. In SONA, set the study URL to
     https://adelchaouchorozco.github.io/lexen-study/?sona=%SURVEY_CODE%
     Empty = SONA students are not sent back for credit. */
  SONA_CREDIT_URL: "https://cityuhk-lt.sona-systems.com/webstudy_credit.aspx?experiment_id=14&credit_token=b2edc59fdba0432c919e757711eea389&survey_code=XXXX",
  PILOT: false,
};

/* ---------------------------------------------------------------- session */
const params = new URLSearchParams(location.search);

function resolvePid(){
  const fromURL = params.get("PROLIFIC_PID") || params.get("sona")
                || params.get("participant") || params.get("pid");
  if (fromURL) return fromURL;
  const fresh = "anon-" + Math.random().toString(36).slice(2, 9);
  try {
    let v = localStorage.getItem("lexen:anon-id");
    if (!v){ v = fresh; localStorage.setItem("lexen:anon-id", v); }
    return v;
  } catch (e) { return fresh; }
}

/* How this participant arrived. The same study runs on an open link now
   and through Prolific later; this keeps the two cohorts separable in the
   data without relying on the shape of an id. */
const RECRUITMENT = params.get("PROLIFIC_PID") ? "prolific"
                  : params.get("sona") ? "sona"
                  : (params.get("participant") || params.get("pid")) ? "link-with-id"
                  : "open-link";

const SESSION = {
  pid: resolvePid(),
  recruitment: RECRUITMENT,
  study: params.get("STUDY_ID") || "",
  session: params.get("SESSION_ID") || "",
  started: new Date().toISOString(),
  ua: navigator.userAgent,
};
const STORE = "lexen:" + SESSION.pid;

const viewport = () => innerWidth + "x" + innerHeight;
const screenSize = () => screen.width + "x" + screen.height;

/* ---------------------------------------------------------------- timing */
let hiddenSeen = false;
document.addEventListener("visibilitychange", () => { if (document.hidden) hiddenSeen = true; });
const FRAME_GRACE_MS = 50;

function showFor(ms, paint){
  return new Promise(resolve => {
    if (paint) paint();
    const tPaint = performance.now();
    let t0 = tPaint, done = false;
    const finish = () => { if (done) return; done = true; resolve(performance.now() - t0); };
    requestAnimationFrame(() => {
      if (done) return;
      const now = performance.now();
      if (now - tPaint < FRAME_GRACE_MS) t0 = now;
      requestAnimationFrame(function loop(){
        if (done) return;
        if (performance.now() - t0 >= ms) finish(); else requestAnimationFrame(loop);
      });
    });
    (function backstop(){
      if (done) return;
      const elapsed = performance.now() - t0;
      if (elapsed >= ms) finish(); else setTimeout(backstop, Math.max(4, ms - elapsed));
    })();
  });
}

function codesFor(ch){
  if (/^[0-9]$/.test(ch)) return ["Digit" + ch, "Numpad" + ch];
  if (/^[a-z]$/i.test(ch)) return ["Key" + ch.toUpperCase()];
  if (ch === " ") return ["Space"];
  return [];
}

/* Resolves {key, rt, timedOut}. `valid` is a list of single characters. */
/* Resolves when `key` is released (or after maxMs, in case the release
   happened elsewhere). The release is swallowed so it cannot activate a
   control that has just appeared. */
function keyReleased(key, maxMs){
  return new Promise(resolve => {
    const done = e => {
      if (e && e.key !== key && e.code !== "Space") return;
      if (e) e.preventDefault();
      document.removeEventListener("keyup", done, true);
      clearTimeout(t);
      resolve();
    };
    document.addEventListener("keyup", done, true);
    const t = setTimeout(() => done(null), maxMs);
  });
}

function waitKey(valid, timeoutMs){
  const codes = {};
  valid.forEach(k => codesFor(k).forEach(c => { codes[c] = k; }));
  return new Promise(resolve => {
    const t0 = performance.now();
    let done = false, timer = null;
    const off = () => {
      document.removeEventListener("keydown", onKey, true);
      if (timer) clearTimeout(timer);
    };
    function onKey(e){
      if (e.repeat) return;
      const k = valid.includes(e.key.toLowerCase()) ? e.key.toLowerCase() : codes[e.code];
      if (!k) return;
      e.preventDefault();
      if (done) return; done = true; off();
      resolve({ key: k, rt: Math.round(performance.now() - t0), timedOut: false });
    }
    document.addEventListener("keydown", onKey, true);
    if (timeoutMs){
      timer = setTimeout(() => {
        if (done) return; done = true; off();
        resolve({ key: null, rt: null, timedOut: true });
      }, timeoutMs);
    }
  });
}

/* ------------------------------------------------------------------ data */
const DATA = [];          // every row, across every node
let NODE_ROWS = [];       // rows for the node currently running

function log(row){
  const full = Object.assign({
    participant: SESSION.pid,
    recruitment: SESSION.recruitment,
    study: SESSION.study,
    session: SESSION.session,
    started: SESSION.started,
    viewport: viewport(),
    screen_size: screenSize(),
  }, row);
  DATA.push(full);
  NODE_ROWS.push(full);
  save();
}

function save(state){
  try {
    localStorage.setItem(STORE, JSON.stringify({
      session: SESSION, data: DATA, state: state || window.__state || null,
      /* Participant properties travel with the save: a resume after the
         handedness question must land in the same branch arm. */
      participant: (typeof PARTICIPANT !== "undefined") ? PARTICIPANT : {},
      savedAt: Date.now(),
    }));
  } catch (e) { /* private mode: the study must still run */ }
}
function loadSaved(){
  try { return JSON.parse(localStorage.getItem(STORE) || "null"); }
  catch (e) { return null; }
}
function clearSaved(){ try { localStorage.removeItem(STORE); } catch (e) {} }

function toCSV(rows){
  if (!rows.length) return "";
  const cols = Object.keys(rows.reduce((a, r) => Object.assign(a, r), {}));
  const esc = v => {
    const s = (v === null || v === undefined) ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(",")]
    .concat(rows.map(r => cols.map(c => esc(r[c])).join(","))).join("\n");
}

/* Uploads are CUMULATIVE SNAPSHOTS, not one file per node.

   Two things have to be true at once for a 40-minute study run at scale:
   a participant who abandons half way must still leave usable data, and
   the archive must not become unmanageable. One file per node gives the
   first and costs the second — 15 files x 3000 participants is 45,000
   files to download and merge.

   So each checkpoint uploads everything collected so far, numbered:
   <participant>__p01.csv, __p02.csv ... The highest-numbered file for a
   participant is their complete session; anyone who dropped out leaves
   their last snapshot. Six files each instead of fifteen, and every one
   of them is self-contained.

   Bodies are gzipped. DataPipe caps a single request at 32 MB and accepts
   Content-Encoding: gzip; a session is ~80 KB of highly repetitive CSV,
   which gzips to a few KB. */
async function gzip(text){
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return await new Response(stream).blob();
  } catch (e) { return null; }
}

/* The mirror is best-effort and never blocks the participant: if it fails,
   DataPipe still has the data, and vice versa. That is the whole point of
   having two. */
async function mirror(filename, csv){
  if (!CFG.MIRROR_URL) return { ok: false, reason: "no mirror configured" };
  try {
    const res = await fetch(CFG.MIRROR_URL.replace(/\/$/, "") + "/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participant: SESSION.pid, filename, data: csv }),
    });
    return res.ok ? { ok: true } : { ok: false, reason: "HTTP " + res.status };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/* Has this id already completed the study? Fails OPEN: if the check itself
   cannot run, the participant is let through. Locking everyone out because
   a service is down is worse than letting a rare duplicate through, and the
   duplicate is still visible in the data afterwards. */
const DONE_KEY = "lexen:completed";

/* Remember, in this browser, that the study was finished. On the open link
   this is the only thing standing between a participant and a second run
   (the server check below needs the mirror), so it is checked for every
   arrival except Prolific and SONA, which block repeats themselves and where
   a shared computer (a lab PC) could otherwise lock out the next person. */
function markCompletedHere(){
  try { localStorage.setItem(DONE_KEY, JSON.stringify({ pid: SESSION.pid, at: new Date().toISOString() })); }
  catch (e) {}
}
function completedHere(){
  if (SESSION.recruitment === "prolific" || SESSION.recruitment === "sona") return null;
  try { return JSON.parse(localStorage.getItem(DONE_KEY) || "null"); }
  catch (e) { return null; }
}

async function alreadyCompleted(){
  const local = completedHere();
  if (local) return { known: true, complete: true, pid: local.pid || SESSION.pid };
  if (!CFG.MIRROR_URL) return { known: false, complete: false };
  try {
    const res = await fetch(CFG.MIRROR_URL.replace(/\/$/, "")
      + "/status?pid=" + encodeURIComponent(SESSION.pid));
    if (!res.ok) return { known: false, complete: false };
    const j = await res.json();
    return { known: true, complete: !!j.complete, parts: j.parts || 0 };
  } catch (e) { return { known: false, complete: false }; }
}

async function upload(filename, rows){
  const csv = toCSV(rows);
  /* Mirror first and in parallel — it is independent of DataPipe. */
  const mirrored = mirror(filename, csv);

  if (!CFG.DATAPIPE_ID){
    const m = await mirrored;
    return m.ok ? { ok: true, via: "mirror only" }
                : { ok: false, reason: "no DataPipe experiment ID configured" };
  }

  const payload = JSON.stringify({ experimentID: CFG.DATAPIPE_ID, filename, data: csv });
  const packed = await gzip(payload);
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++){
    try {
      const headers = { "Content-Type": "application/json", Accept: "*/*" };
      if (packed) headers["Content-Encoding"] = "gzip";
      const res = await fetch("https://pipe.jspsych.org/api/data/", {
        method: "POST", headers, body: packed || payload,
      });
      if (res.ok){ await mirrored; return { ok: true, bytes: (packed ? packed.size : payload.length) }; }
      /* 400 means DataPipe rejected the request itself — retrying will not
         help, and the reason is worth surfacing rather than burning time. */
      if (res.status === 400){
        const why = (await res.text()).slice(0, 140);
        return (await mirrored).ok ? { ok: true, via: "mirror only", reason: why }
                                   : { ok: false, reason: why };
      }
    } catch (e) {
      /* Do not return here: the mirror may well have taken the data, and
         reporting a loss that did not happen sends the participant chasing
         a download they do not need. Fall through to the check below. */
      lastError = e.message;
    }
    await new Promise(r => setTimeout(r, 1200 * attempt));
  }
  /* DataPipe failed. If the mirror took it, the data is not lost. */
  const m = await mirrored;
  if (m.ok) return { ok: true, via: "mirror only" };
  return { ok: false, reason: lastError || "no response after 3 attempts" };
}

function downloadCSV(rows, filename){
  const url = URL.createObjectURL(new Blob(["﻿" + toCSV(rows)],
                                  { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------------- screens */
const $stage = () => document.getElementById("stage");
const $frame = () => document.getElementById("frame");
const $page  = () => document.getElementById("page");


function stageOn(on){
  $stage().classList.toggle("on", on);
  const p = $page();
  p.classList.toggle("on", !on);
  p.inert = on;
  p.setAttribute("aria-hidden", on ? "true" : "false");
}
/* The progress bar is a task zone, not page chrome — see js/task.js. */

/* Percentage insets, exactly as Gorilla lays a screen out. */
function placeZone(el, box){
  el.style.left   = (box.left   || 0) + "%";
  el.style.right  = (box.right  || 0) + "%";
  el.style.top    = (box.top    || 0) + "%";
  el.style.bottom = (box.bottom || 0) + "%";
}
