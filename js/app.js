/* =====================================================================
   Flow router — walks the experiment tree exported from Gorilla.

   The order is fixed for everyone; the only per-participant variation is
   the handedness branch, decided by the participant's own answer. That
   means no shared server state is needed and the whole study runs as a
   static site. (Gorilla's two `Order` nodes are latin squares that were
   never wired into the tree, so they never ran — see SPEC.md.)
   ===================================================================== */
"use strict";

const CACHE = {};
async function loadJSON(path){
  if (!CACHE[path]) CACHE[path] = (await fetch(path + "?v=" + ASSET_VERSION)).json();
  return CACHE[path];
}

const state = {
  flow: null,
  queue: [],        // resolved list of nodes for this participant
  at: 0,
  arm: null,
};
window.__state = state;

function say(html, buttons){
  const p = $page();
  stageOn(false);
  p.innerHTML = "";
  const col = document.createElement("div");
  col.className = "col";
  col.innerHTML = html;
  const actions = document.createElement("div");
  actions.className = "actions";
  (buttons || []).forEach(b => {
    const el = document.createElement("button");
    el.textContent = b.label;
    if (b.ghost) el.className = "ghost";
    el.onclick = b.onClick;
    actions.appendChild(el);
  });
  if (buttons && buttons.length) col.appendChild(actions);
  p.appendChild(col);
  scrollTo(0, 0);
  const first = p.querySelector("button");
  if (first) first.focus({ preventScroll: true });
}

/* Gorilla blocks phones and tablets on this experiment; responses are
   keyboard-only, so a touch-only device could not take part anyway. */
function keyboardLikely(){
  if (!window.matchMedia) return true;
  return matchMedia("(any-pointer: fine)").matches || matchMedia("(any-hover: hover)").matches;
}

function buildQueue(){
  const f = state.flow;
  const arms = f.branch.arms;
  const answer = PARTICIPANT[f.branch.property];
  let armName = Object.keys(arms).find(k => arms[k].value === answer);
  if (!armName) armName = Object.keys(arms).find(k => arms[k].default);
  state.arm = armName;
  return f.before_branch.concat(arms[armName].chain, f.after_branch);
}

async function runNode(node){
  NODE_ROWS = [];
  if (node.kind === "questionnaire"){
    const q = await loadJSON(`data/questionnaires/${node.slug}.json`);
    await renderQuestionnaire(q, { nodeKey: node.node });
  } else if (node.kind === "task"){
    const t = await loadJSON(`data/tasks/${node.slug}.json`);
    await runTask(t, { nodeKey: node.node });
  }
  await finishNode(node);
}

/* Snapshot after every task, so an abandoned session still leaves the work
   the participant actually did. The questionnaires either side ride along
   in the next snapshot rather than each costing a file of their own. */
function isCheckpoint(node){ return node.kind === "task"; }

async function finishNode(node){
  save(state);
  if (!isCheckpoint(node) || !DATA.length) return;
  state.part = (state.part || 0) + 1;
  const name = `${SESSION.pid}__p${String(state.part).padStart(2, "0")}.csv`;
  const res = await upload(name, DATA);
  if (res.ok) state.uploaded = state.part;
  else if (CFG.PILOT) console.warn("snapshot", name, "failed —", res.reason);
  save(state);
}

async function step(){
  for (;;){
    /* Resolve the branch the moment the pre-branch chain is done, before
       reading the next node — until then the queue only holds the four
       nodes that precede it. */
    if (state.at >= state.flow.before_branch.length && !state.arm){
      state.queue = buildQueue();
      save(state);
    }
    if (state.at >= state.queue.length) break;

    const node = state.queue[state.at];
    if (node.kind === "finish") break;

    await runNode(node);
    state.at++;
    save(state);
  }
  await finish();
}

function sonaCreditURL(){
  const code = encodeURIComponent(SESSION.pid);
  const u = CFG.SONA_CREDIT_URL;
  return u.includes("XXXX") ? u.replace("XXXX", code) : u + code;
}

/* ------------------------------------------------------------- scores
   Shown on the last screen only; nothing here is uploaded. LexEn and
   LexTALE use the LexTALE rule (Lemhoefer & Broersma, 2012): the mean of
   % correct on real words and % correct on made-up words, test trials
   only (no practice, no attention checks; a timeout counts as wrong).
   The OQPT is the number of the 60 questions answered with the keyed
   option (data/oqpt-key.json). */
function balancedPercent(rows){
  const groups = {};
  rows.forEach(r => { (groups[r.answer] = groups[r.answer] || []).push(+r.correct || 0); });
  const means = Object.values(groups).map(g => g.reduce((a, b) => a + b, 0) / g.length);
  return means.length ? Math.round(100 * means.reduce((a, b) => a + b, 0) / means.length) : null;
}

async function scores(){
  const out = [];
  const trials = t => DATA.filter(r => r.task === t && r.display === "trial");
  const tasks = [...new Set(DATA.map(r => r.task))];

  tasks.filter(t => /^LexEn /.test(t)).forEach(t => {
    const p = balancedPercent(trials(t));
    if (p !== null) out.push([t.replace(/\s*-\s*(Left|Right)$/, ""), `${p}%`]);
  });

  try {
    const [q, key] = await Promise.all([
      loadJSON("data/questionnaires/oqpt.json"), loadJSON("data/oqpt-key.json")]);
    const items = q.pages.flat().filter(i => i.kind === "choice");
    const answered = new Map(DATA.filter(r => r.task === q.title && r.display === "question")
                                 .map(r => [r.question, r.response]));
    if (answered.size){
      let right = 0;
      items.forEach((it, n) => {
        const label = (it.log_label || it.label || "").replace(/<[^>]+>/g, "").trim();
        if (answered.get(label) === it.options[key.correct[n] - 1]) right++;
      });
      out.push(["Oxford Quick Placement Test", `${right} / ${items.length}`]);
    }
  } catch (e) { /* no score rather than a wrong one */ }

  const lt = tasks.find(t => /^LexTALE/.test(t));
  const p = lt ? balancedPercent(trials(lt)) : null;
  if (p !== null) out.push(["LexTALE", `${p}%`]);
  return out;
}

async function finish(){
  /* Where the participant goes back to, if anywhere: Prolific to register
     the submission, SONA to grant the student's credit. */
  const back = SESSION.recruitment === "prolific" && CFG.COMPLETION_URL
      ? { url: CFG.COMPLETION_URL, why: "register your participation" }
    : SESSION.recruitment === "sona" && CFG.SONA_CREDIT_URL
      ? { url: sonaCreditURL(), why: "receive your credit" }
    : null;
  state.part = (state.part || 0) + 1;
  const all = `${SESSION.pid}__p${String(state.part).padStart(2, "0")}_complete.csv`;
  markCompletedHere();
  const res = await upload(all, DATA);
  const ok = res.ok;
  if (ok) clearSaved();

  const contact = CFG.CONTACT
    ? `<a href="mailto:${CFG.CONTACT}">${CFG.CONTACT}</a>`
    : "the researcher who sent you this link";

  const sc = await scores();

  say(`
    <h4>Thank you — the study is complete</h4>
    <p>In this study you took several English vocabulary tests. In most of
       them you decided whether a string of letters was a real English word.
       Some were real words; others were made-up words designed to look like
       English. We are developing a new vocabulary test, LexEn, and comparing
       it with two established measures, LexTALE and the Oxford Quick
       Placement Test. Your answers help us find out how well the new test
       measures vocabulary knowledge.</p>
    ${sc.length ? `
    <h4>Your scores</h4>
    <table class="tasks scores"><tbody>
      ${sc.map(([name, v]) => `<tr><td>${name}</td><td class="num">${v}</td></tr>`).join("")}
    </tbody></table>
    <p>These scores are for your interest only. They are not a grade and do
       not affect your credit.</p>` : ""}
    <p>Your answers are stored only under your anonymous ID:
       <strong class="mono">${SESSION.pid}</strong>. If you want to withdraw
       your data, or have any questions, contact Dr Adel Chaouch-Orozco
       (<a href="mailto:adel.chaouchorozco@cityu.edu.hk">adel.chaouchorozco@cityu.edu.hk</a>)
       or Dr Eloi Puig-Mayenco
       (<a href="mailto:e.puig-mayenco@kcl.ac.uk">e.puig-mayenco@kcl.ac.uk</a>),
       quoting this ID.</p>
    <p>Please don't discuss the tests with other students who may still take part.</p>
    <p>${back
      ? `Press <strong>Finish</strong> to ${back.why}.`
      : "You can now close this tab."}</p>
    ${ok ? "" : `<p class="err">We could not send your responses automatically.
       Please download the file below and send it to ${contact}.</p>`}
    ${CFG.PILOT ? `<p class="note">Pilot mode: ${DATA.length} rows recorded,
       arm "${state.arm}", ${state.part} snapshot(s) uploaded.
       Set CFG.PILOT = false before running participants.</p>` : ""}
  `, [
    ...(back ? [{ label: "Finish", onClick: () => location.href = back.url }] : []),
    ...(!ok || CFG.PILOT ? [{ label: "Download my data (CSV)", ghost: ok,
        onClick: () => downloadCSV(DATA, `${SESSION.pid}__ALL.csv`) }] : []),
  ]);
}

/* ---------------------------------------------------------------------
   Preview mode: ?task=<slug> runs one task on its own, with no
   questionnaires and no branch. For piloting only — it never uploads,
   so a preview run cannot land in the real dataset. The data is still
   collected and can be downloaded at the end.
   --------------------------------------------------------------------- */
const TASK_SLUGS = [
  "lexen-fair-left", "lexen-fair-right",
  "lexen-irt-left", "lexen-irt-right",
  "lexen-triple-left", "lexen-triple-right",
  "lextale",
];

/* A contents page for the preview mode: what each task is, at a glance. */
async function previewIndex(){
  const rows = [];
  for (const slug of TASK_SLUGS){
    const t = await loadJSON(`data/tasks/${slug}.json`);
    const rs = t.rows;
    const n = d => rs.filter(r => r.display === d).length;
    const words = rs.filter(r => r.display === "trial" && r.type === "word").length;
    const non = rs.filter(r => r.display === "trial" && r.type === "nonword").length;
    const kb = Object.values(t.displays).flat()
      .flatMap(sc => sc.zones).find(z => z.type === "response_keyboard");
    const keys = kb ? kb.keys.map(k => `<kbd>${k.key}</kbd> ${k.response === "word" ? "word" : "not a word"}`).join(" · ")
                    : "mouse buttons";
    rows.push(`<tr>
      <td><a href="?task=${slug}"><strong>${t.title}</strong></a></td>
      <td class="num">${n("trial")}</td>
      <td class="num">${words} / ${non}</td>
      <td class="num">${n("check") || "—"}</td>
      <td>${keys}</td>
    </tr>`);
  }
  say(`<h4>The tasks</h4>
    <p>Each link runs that task on its own — no questionnaires, no branch.
       Nothing is uploaded, and you can download the data at the end.</p>
    <table class="tasks">
      <thead><tr><th>Task</th><th class="num">Trials</th><th class="num">Word / non-word</th>
        <th class="num">Checks</th><th>Response</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
    <p class="note"><strong>Left</strong> and <strong>Right</strong> are the same items —
       only the keys differ, following the participant's handedness answer.
       LexTALE is the odd one out: mouse buttons, no fixation cross and no time limit.</p>
    <p class="note">Every other task shows a 300&nbsp;ms fixation cross, then the word for
       up to 5&nbsp;seconds, with 16 practice trials and feedback beforehand.</p>`);
}

async function previewTask(slug){
  if (!TASK_SLUGS.includes(slug)){
    await previewIndex();
    return;
  }
  const t = await loadJSON(`data/tasks/${slug}.json`);
  say(`<h4>${t.title}</h4>
       <p class="note">Preview — this task only, no questionnaires. Nothing is
          uploaded; you can download the data at the end.</p>`,
    [{ label: "Start this task", onClick: async () => {
        NODE_ROWS = [];
        await runTask(t, { nodeKey: "preview-" + slug });
        say(`<h4>${t.title} — finished</h4>
             <p>${NODE_ROWS.filter(r => r.display === "trial").length} trials recorded.
                Nothing was uploaded.</p>`,
          [
            { label: "Download this run (CSV)",
              onClick: () => downloadCSV(NODE_ROWS, `preview_${slug}.csv`) },
            { label: "Run it again", ghost: true, onClick: () => location.reload() },
          ]);
      } }]);
}

async function boot(){
  if (!keyboardLikely()){
    say(`<h4>Please use a computer</h4>
         <p>This study is answered with keys on a keyboard, so it cannot be taken
            on a phone or tablet. Nothing has started yet — please open this same
            link on a laptop or desktop computer.</p>
         <p style="word-break:break-all"><strong>${location.href}</strong></p>`);
    return;
  }

  const only = params.get("task");
  if (only !== null){ await previewTask(only); return; }

  /* Refuse a second run by the same id. Checked before anything is shown,
     and only when the participant has genuinely finished before — an
     interrupted session still resumes normally below. */
  const prior = await alreadyCompleted();
  if (prior.complete){
    say(`<h4>You have already taken part</h4>
         <p>Our records show this study has already been completed
            ${SESSION.recruitment === "prolific" || SESSION.recruitment === "sona" ? "with your participant id" : "on this device"},
            so there is nothing more to do — and please do not take it again,
            as repeated data cannot be used.</p>
         <p>If you believe this is a mistake, please contact
            ${CFG.CONTACT ? `<a href="mailto:${CFG.CONTACT}">${CFG.CONTACT}</a>`
                          : "the researcher who sent you this link"},
            quoting your participant id <strong class="mono">${prior.pid || SESSION.pid}</strong>.</p>`);
    return;
  }

  state.flow = await loadJSON("data/flow.json");
  state.queue = state.flow.before_branch.slice();

  const saved = loadSaved();
  if (saved && saved.state && saved.data && saved.data.length){
    say(`<h4>Welcome back</h4>
         <p>You have already started this study on this computer. You can carry
            on from where you stopped, or start again from the beginning.</p>`,
      [
        { label: "Carry on", onClick: () => {
            SESSION.started = saved.session.started;
            saved.data.forEach(r => DATA.push(r));
            Object.assign(state, saved.state);
            Object.assign(PARTICIPANT, saved.participant || {});
            if (state.arm) state.queue = buildQueue();
            step();
          } },
        { label: "Start again", ghost: true, onClick: () => {
            say(`<h4>Start again from the beginning?</h4>
                 <p class="err">This deletes the answers you have already given.
                    You would have to do the whole study again.</p>`,
              [
                { label: "No — carry on where I stopped", onClick: boot },
                { label: "Yes, delete and start again", ghost: true,
                  onClick: () => { clearSaved(); location.reload(); } },
              ]);
          } },
      ]);
    return;
  }

  step();
}

boot();
