import { callClaude, estimateCost } from './lib/claude.js';
import { buildSystem, JOB_SCHEMA, jobPrompt, ANSWER_SCHEMA, answerPrompt } from './lib/prompts.js';
import { buildResumeDocx, buildCoverLetterDocx, DOCX_MIME } from './lib/docx.js';
import { extractJobFromPage, autofillContactFields, insertAnswerIntoPage } from './lib/extract.js';
import {
  getSettings, getSources, getLog, saveLog, upsertLog,
  getContext, saveContext, upsertContext, addGapAction, addNote, migrate,
  addActivity, removeActivity,
} from './lib/store.js';
import {
  STAGES, ACTIVE, CLOSED, METHODS, ACTIVITY_TYPES, TYPE_BY_ID, stageLabel, methodLabel, typeLabel,
  normalizeEntry, isDue, followUpCount, lastContact, lastTouched, activityDefaults, stagePatch,
  todayStr, localDate, dateToIso, shortDate, daysAgo, activityLine,
} from './lib/tracking.js';
import { downloadBackup, BACKUP_REMINDER_DAYS } from './lib/backup.js';

const $ = (id) => document.getElementById(id);
const state = { job: null, result: null, logId: null, answerTarget: null };

// ---------- helpers ----------
function setStatus(el, msg, isErr = false) {
  el.innerHTML = '';
  el.classList.toggle('err', isErr);
  if (msg === 'busy') return;
  el.textContent = msg || '';
}
function busy(el, msg) {
  el.classList.remove('err');
  el.innerHTML = `<span class="spinner"></span> ${msg}`;
}
function fillList(ul, items) {
  ul.innerHTML = '';
  for (const t of items && items.length ? items : ['None noted']) {
    const li = document.createElement('li');
    li.textContent = t;
    ul.appendChild(li);
  }
}
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled';

async function targetTab() {
  const param = new URLSearchParams(location.search).get('tabId');
  if (param) return chrome.tabs.get(Number(param));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
async function runInTab(func, args = [], target) {
  const tab = target ? null : await targetTab();
  const t = target || { tabId: tab.id };
  try {
    const [res] = await chrome.scripting.executeScript({ target: t, func, args });
    return res && res.result;
  } catch (e) {
    throw new Error(`Can't access this page (${e.message}). Browser pages (brave://, chrome://, edge://) and extension stores are off limits.`);
  }
}
function usageNote(model, usage) {
  const cached = usage.cache_read_input_tokens ? `, ${Math.round(usage.cache_read_input_tokens / 1000)}k cached` : '';
  return `Done · ~$${estimateCost(model, usage).toFixed(3)}${cached}`;
}
async function persist() {
  await chrome.storage.session.set({ panelState: { job: state.job, result: state.result, logId: state.logId } });
}

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('main > section').forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
  if (name === 'log') renderLog();
  if (name === 'context') renderContext();
}
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

async function checkSetup() {
  const [s, sources] = await Promise.all([getSettings(), getSources()]);
  const missing = [];
  if (!s.apiKey) missing.push('your Claude API key');
  if (!sources.length) missing.push('your career source files');
  if (!s.profile.fullName) missing.push('your name and contact details');
  const b = $('setupBanner');
  b.hidden = !missing.length;
  if (missing.length) {
    b.innerHTML = `Setup needed: add ${missing.join(', ')} in <a href="#" id="setupLink">Options</a>.`;
    $('setupLink').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
  }
}

// ---------- JOB ----------
function renderJob() {
  const j = state.job;
  $('jobCard').hidden = !j;
  if (!j) return;
  $('jobTitle').value = j.title;
  $('jobCompany').value = j.company;
  $('jobLocation').value = j.location;
  $('jobDesc').value = j.description;
  $('descLen').textContent = `${j.description.length.toLocaleString()} chars from ${j.source}`;
}
function readJobFields() {
  Object.assign(state.job, {
    title: $('jobTitle').value.trim(),
    company: $('jobCompany').value.trim(),
    location: $('jobLocation').value.trim(),
    description: $('jobDesc').value.trim(),
  });
}

$('readJob').addEventListener('click', async () => {
  busy($('jobStatus'), 'Reading the posting…');
  try {
    const job = await runInTab(extractJobFromPage);
    if (!job || job.description.length < 100) throw new Error('No job description found on this page. Open the full posting, or paste the description into the box.');
    state.job = job;
    state.result = null;
    state.logId = null;
    $('result').hidden = true;
    renderJob();
    await persist();
    setStatus($('jobStatus'), job.usedFallback
      ? 'Read the whole page (no known job layout). Trim the description if it picked up extra text.'
      : 'Job loaded. Review the fields, then tailor.');
  } catch (e) {
    setStatus($('jobStatus'), e.message, true);
  }
});

$('generate').addEventListener('click', async () => {
  readJobFields();
  if (!state.job.description) return setStatus($('jobStatus'), 'The job description is empty.', true);
  const btn = $('generate');
  btn.disabled = true;
  busy($('jobStatus'), 'Tailoring… this usually takes 30–90 seconds.');
  try {
    const [settings, sources, context] = await Promise.all([getSettings(), getSources(), getContext()]);
    const { json, usage } = await callClaude({
      apiKey: settings.apiKey,
      model: settings.model,
      effort: settings.effort,
      system: buildSystem(settings, sources, context),
      messages: [{ role: 'user', content: jobPrompt(state.job, $('jobNotes').value.trim()) }],
      schema: JOB_SCHEMA,
      maxTokens: 32000,
    });
    state.result = json;
    if (json.company && !state.job.company) state.job.company = json.company;

    // Log it (re-tailoring the same URL updates the existing row).
    const log = await getLog();
    const existing = log.find((e) => e.url === state.job.url);
    state.logId = existing ? existing.id : crypto.randomUUID();
    await upsertLog({
      id: state.logId,
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
      company: state.job.company || json.company,
      title: state.job.title || json.job_title,
      location: state.job.location,
      url: state.job.url,
      fit: json.fit_score,
      status: existing ? existing.status : 'tailored',
      appliedAt: existing ? existing.appliedAt : null,
      notes: existing ? existing.notes : '',
    });
    await persist();
    renderResult();
    setStatus($('jobStatus'), usageNote(settings.model, usage));
  } catch (e) {
    setStatus($('jobStatus'), e.message, true);
  } finally {
    btn.disabled = false;
  }
});

function resumeToText(r) {
  const lines = [r.headline, '', r.summary, ''];
  for (const g of r.skills) lines.push(`${g.label}: ${g.items.join(', ')}`);
  for (const j of r.experience) {
    lines.push('', `${j.title} | ${j.company} | ${j.dates}${j.location ? ` | ${j.location}` : ''}`);
    j.bullets.forEach((b) => lines.push(`• ${b}`));
  }
  if (r.education.length) lines.push('', ...r.education.map((e) => `${e.credential}, ${e.school} ${e.dates}`.trim()));
  if (r.certifications.length) lines.push('', ...r.certifications);
  return lines.join('\n');
}
function letterToText(l) {
  return [l.greeting, '', ...l.paragraphs.flatMap((p) => [p, '']), l.closing].join('\n');
}

function renderResult() {
  const r = state.result;
  $('result').hidden = !r;
  if (!r) return;
  const s = $('fitScore');
  s.textContent = r.fit_score;
  s.className = `score ${r.fit_score >= 75 ? 'good' : r.fit_score >= 50 ? 'mid' : 'low'}`;
  $('fitSummary').textContent = r.fit_summary;
  fillList($('strengths'), r.strengths);
  renderGaps(r.gaps);
  fillList($('checks'), r.check_before_sending);
  $('resumePreview').textContent = resumeToText(r.resume);
}

async function download(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: DOCX_MIME }));
  try {
    await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
function folderFor(settings) {
  const company = safeName(state.job.company || state.result.company);
  const title = safeName(state.job.title || state.result.job_title);
  const who = safeName(settings.profile.fullName || 'Me');
  return { dir: `Job Tailor/${company} - ${title}`, who, company };
}

$('dlResume').addEventListener('click', async () => {
  const settings = await getSettings();
  const { dir, who, company } = folderFor(settings);
  await download(buildResumeDocx(settings.profile, state.result.resume), `${dir}/${who} - Resume - ${company}.docx`);
});
$('dlResumePrint').addEventListener('click', async () => {
  const settings = await getSettings();
  const { linkedin, website } = settings.profile;
  if (!linkedin && !website) return setStatus($('jobStatus'), 'Add your LinkedIn or website in Options › Your details first.');
  const { dir, who, company } = folderFor(settings);
  await download(buildResumeDocx(settings.profile, state.result.resume, { qr: true }), `${dir}/${who} - Resume (print) - ${company}.docx`);
  setStatus($('jobStatus'), 'Print version saved. Use the regular version for online applications.');
});
$('dlCover').addEventListener('click', async () => {
  const settings = await getSettings();
  const { dir, who, company } = folderFor(settings);
  await download(buildCoverLetterDocx(settings.profile, state.result.cover_letter), `${dir}/${who} - Cover Letter - ${company}.docx`);
});
$('copyCover').addEventListener('click', async () => {
  await navigator.clipboard.writeText(letterToText(state.result.cover_letter));
  setStatus($('jobStatus'), 'Cover letter copied.');
});
$('autofill').addEventListener('click', async () => {
  try {
    const { profile } = await getSettings();
    const filled = await runInTab(autofillContactFields, [profile]);
    setStatus($('jobStatus'), filled && filled.length
      ? `Filled ${filled.length} field(s): ${filled.join('; ')}. Review before submitting.`
      : 'No empty contact fields found on this page (or it is inside a frame the extension can’t see).');
  } catch (e) {
    setStatus($('jobStatus'), e.message, true);
  }
});
$('markApplied').addEventListener('click', async () => {
  if (!state.logId) return;
  const [log, settings] = await Promise.all([getLog(), getSettings()]);
  const entry = log.find((e) => e.id === state.logId);
  if (!entry) return;
  const e = normalizeEntry(entry, settings.followUpDays);
  if (e.status === 'applied') return setStatus($('jobStatus'), 'Already marked as applied.');
  await changeStage(e, 'applied', settings, 'Marked as applied from the Job tab');
  const next = (await getLog()).find((x) => x.id === state.logId);
  setStatus($('jobStatus'), `Marked as applied. First follow-up is due ${shortDate(next.nextFollowUpAt)} (see the Log tab).`);
});

// ---------- GAPS → ACTION ITEMS ----------
const normGap = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function renderGaps(gaps) {
  const ul = $('gaps');
  ul.innerHTML = '';
  if (!gaps || !gaps.length) { fillList(ul, []); return; }
  const tracked = new Set((await getContext()).filter((c) => c.kind === 'gap' && c.status !== 'dismissed').map((c) => normGap(c.title)));
  for (const gap of gaps) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    const span = document.createElement('span');
    span.textContent = gap;
    const markAdded = () => { btn.textContent = '✓'; btn.className = 'add-gap added'; btn.title = 'Tracked in Context › Action items'; btn.disabled = true; };
    btn.className = 'add-gap';
    btn.textContent = '+';
    btn.title = 'Make this an action item so you can add context for it';
    if (tracked.has(normGap(gap))) markAdded();
    btn.onclick = async () => {
      await addGapAction(gap, state.job);
      markAdded();
      updateOpenCount();
    };
    li.append(btn, span);
    ul.appendChild(li);
  }
}

// ---------- CONTEXT ----------
async function updateOpenCount() {
  const open = (await getContext()).filter((c) => c.kind === 'gap' && c.status === 'open').length;
  $('openCount').hidden = !open;
  $('openCount').textContent = open;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function jobsLine(item) {
  if (!item.jobs || !item.jobs.length) return '';
  const first = item.jobs[0];
  const more = item.jobs.length > 1 ? ` +${item.jobs.length - 1} more` : '';
  return `Gap for ${first.company || first.title}${more}`;
}

function contextCard(item, { editing } = {}) {
  const card = el('div', 'ctx');
  if (item.title) card.appendChild(el('div', 'title', item.title));
  const metaBits = [];
  if (item.kind === 'gap') metaBits.push(jobsLine(item));
  if (item.source && item.source.title) metaBits.push(`From: ${item.source.title}`);
  metaBits.push(new Date(item.updatedAt || item.createdAt).toLocaleDateString());
  card.appendChild(el('div', 'meta', metaBits.filter(Boolean).join(' · ')));

  const row = el('div', 'row');
  if (editing) {
    const ta = el('textarea');
    ta.rows = 4;
    ta.value = item.text || '';
    ta.placeholder = item.kind === 'gap'
      ? 'What have you actually done that relates to this? Projects, tools, results, scale. Leave it as a gap if the answer is "nothing yet".'
      : '';
    card.appendChild(ta);
    const save = el('button', 'btn primary', item.kind === 'gap' ? 'Save context' : 'Save');
    save.onclick = async () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      await upsertContext({ id: item.id, text, status: 'done' });
      setStatus($('contextStatus'), state.job ? 'Saved. Re-tailor the current job on the Job tab to use it.' : 'Saved. It will be used on your next tailor or answer.');
      renderContext();
    };
    row.appendChild(save);
    if (item.kind === 'gap') {
      const dismiss = el('button', 'btn', 'Not a real gap / skip');
      dismiss.onclick = async () => { await upsertContext({ id: item.id, status: 'dismissed' }); renderContext(); };
      row.appendChild(dismiss);
    }
    if (item.status === 'done') {
      const cancel = el('button', 'btn', 'Cancel');
      cancel.onclick = () => renderContext();
      row.appendChild(cancel);
    }
  } else {
    card.appendChild(el('div', 'body', item.text));
    const edit = el('button', 'btn small', 'Edit');
    edit.onclick = () => card.replaceWith(contextCard(item, { editing: true }));
    row.appendChild(edit);
  }
  const del = el('button', 'btn small', 'Delete');
  del.onclick = async () => {
    if (!confirm('Delete this context item?')) return;
    await saveContext((await getContext()).filter((c) => c.id !== item.id));
    renderContext();
  };
  row.appendChild(el('span', 'grow'));
  row.appendChild(del);
  card.appendChild(row);
  return card;
}

async function renderContext() {
  const context = await getContext();
  const open = context.filter((c) => c.kind === 'gap' && c.status === 'open');
  const saved = context.filter((c) => c.status === 'done' && c.text);
  const q = $('contextFilter').value.trim().toLowerCase();
  const shown = q ? saved.filter((c) => `${c.title} ${c.text}`.toLowerCase().includes(q)) : saved;

  $('actionSummary').textContent = open.length ? `· ${open.length} open` : '';
  $('actionList').innerHTML = '';
  if (!open.length) $('actionList').appendChild(el('p', 'small muted', 'No open action items. Click + next to a gap on the Job tab to add one.'));
  for (const item of open) $('actionList').appendChild(contextCard(item, { editing: true }));

  $('savedSummary').textContent = `· ${saved.length} item(s), sent with every request`;
  $('savedList').innerHTML = '';
  if (!shown.length) $('savedList').appendChild(el('p', 'small muted', saved.length ? 'Nothing matches.' : 'Nothing saved yet.'));
  for (const item of shown) $('savedList').appendChild(contextCard(item));
  updateOpenCount();
}

$('contextFilter').addEventListener('input', renderContext);
$('saveNote').addEventListener('click', async () => {
  const text = $('noteText').value.trim();
  if (!text) return setStatus($('contextStatus'), 'Write something first.', true);
  await addNote(text, null, $('noteTopic').value.trim());
  $('noteText').value = '';
  $('noteTopic').value = '';
  setStatus($('contextStatus'), 'Saved. It will be used on your next tailor or answer.');
  renderContext();
});

// ---------- BACKUP REMINDER ----------
async function checkBackup() {
  const { lastBackupAt, backupSnoozeUntil } = await chrome.storage.local.get(['lastBackupAt', 'backupSnoozeUntil']);
  const [context, log] = await Promise.all([getContext(), getLog()]);
  const hasData = context.length || log.length;
  const stale = !lastBackupAt || Date.now() - new Date(lastBackupAt).getTime() > BACKUP_REMINDER_DAYS * 86_400_000;
  const snoozed = backupSnoozeUntil && Date.now() < backupSnoozeUntil;
  $('backupBanner').hidden = !(hasData && stale && !snoozed);
  $('backupMsg').textContent = lastBackupAt
    ? `Last backup ${new Date(lastBackupAt).toLocaleDateString()}. Back up your context and log so nothing is lost if the extension is removed.`
    : 'You have context and log entries that have never been backed up.';
}
$('backupNow').addEventListener('click', async () => { await downloadBackup(); checkBackup(); });
$('backupLater').addEventListener('click', async () => {
  await chrome.storage.local.set({ backupSnoozeUntil: Date.now() + 3 * 86_400_000 });
  checkBackup();
});

// ---------- ANSWER ----------
async function answerQuestion() {
  const question = $('question').value.trim();
  if (!question) return setStatus($('answerStatus'), 'Enter a question first.', true);
  const btn = $('answerBtn');
  btn.disabled = true;
  $('answerCard').hidden = true;
  busy($('answerStatus'), 'Drafting answer…');
  try {
    const [settings, sources, context] = await Promise.all([getSettings(), getSources(), getContext()]);
    const tab = await targetTab().catch(() => null);
    const { json, usage } = await callClaude({
      apiKey: settings.apiKey,
      model: settings.answerModel,
      effort: settings.answerEffort,
      system: buildSystem(settings, sources, context),
      messages: [{
        role: 'user',
        content: answerPrompt({
          question,
          job: $('useJobCtx').checked ? state.job : null,
          pageTitle: tab && tab.title,
          pageUrl: tab && tab.url,
          length: $('answerLength').value,
        }),
      }],
      schema: ANSWER_SCHEMA,
      maxTokens: 8000,
    });
    $('needsYou').hidden = !json.needs_you;
    $('needsYou').textContent = json.needs_you ? `NEEDS YOU: ${json.needs_you_reason}` : '';
    $('answerText').value = json.answer;
    $('answerCard').hidden = false;
    setStatus($('answerStatus'), usageNote(settings.answerModel, usage));
  } catch (e) {
    setStatus($('answerStatus'), e.message, true);
  } finally {
    btn.disabled = false;
  }
}
$('answerBtn').addEventListener('click', () => { state.answerTarget = null; answerQuestion(); });
$('copyAnswer').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('answerText').value);
  setStatus($('answerStatus'), 'Copied.');
});
$('insertAnswer').addEventListener('click', async () => {
  const text = $('answerText').value;
  try {
    const t = state.answerTarget;
    const target = t ? { tabId: t.tabId, frameIds: [t.frameId] } : null;
    const r = await runInTab(insertAnswerIntoPage, [text], target);
    setStatus($('answerStatus'), r === 'inserted' ? 'Inserted.' : 'Now click the field on the page to insert.');
  } catch (e) {
    setStatus($('answerStatus'), e.message, true);
  }
});

async function handlePending(p) {
  if (!p || !p.text || Date.now() - p.at > 120_000) return;
  await chrome.storage.session.remove('pendingQuestion');
  state.answerTarget = { tabId: p.tabId, frameId: p.frameId };
  showTab('answer');
  $('question').value = p.text;
  answerQuestion();
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.pendingQuestion && changes.pendingQuestion.newValue) {
    handlePending(changes.pendingQuestion.newValue);
  }
  if (area === 'local' && (changes.settings || changes.sources)) checkSetup();
  if (area === 'local' && (changes.log || changes.settings)) {
    if (!$('tab-log').hidden) scheduleLogRender();
    else updateDueCount();
  }
  if (area === 'local' && (changes.context || changes.log || changes.lastBackupAt)) checkBackup();
  if (area === 'local' && changes.context) {
    updateOpenCount();
    if (!$('tab-context').hidden) renderContext();
  }
});

// ---------- LOG (tracking) ----------
const logUi = { open: new Set(), filter: 'open', q: '' };

// Stage filter options are added once, after the fixed ones.
(() => {
  const f = $('logFilter');
  const grp = document.createElement('optgroup');
  grp.label = 'Stage';
  for (const st of STAGES) grp.appendChild(new Option(st.label, `stage:${st.id}`));
  f.appendChild(grp);
})();
$('logFilter').addEventListener('change', () => { logUi.filter = $('logFilter').value; renderLog(); });
$('logSearch').addEventListener('input', () => { logUi.q = $('logSearch').value.trim().toLowerCase(); renderLog(); });

async function updateDueCount() {
  const [log, settings] = await Promise.all([getLog(), getSettings()]);
  const due = log.map((e) => normalizeEntry(e, settings.followUpDays)).filter(isDue).length;
  $('dueCount').hidden = !due;
  $('dueCount').textContent = due;
  return due;
}

// Re-render after storage changes, but never while the user is typing in the log.
let logTimer = null;
function scheduleLogRender() {
  clearTimeout(logTimer);
  logTimer = setTimeout(() => {
    if ($('logList').contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) {
      updateDueCount();
      return;
    }
    renderLog();
  }, 150);
}

async function changeStage(entry, newStage, settings, note = '') {
  const patch = stagePatch(entry, newStage, settings.followUpDays);
  await addActivity(entry.id, { type: 'stage', at: new Date().toISOString(), stageFrom: entry.status, stage: newStage, note }, patch);
}

function matchesFilter(e) {
  const f = logUi.filter;
  if (f === 'due') return isDue(e);
  if (f === 'open') return !CLOSED.has(e.status);
  if (f.startsWith('stage:')) return e.status === f.slice(6);
  return true;
}
function matchesSearch(e) {
  if (!logUi.q) return true;
  const hay = [e.title, e.company, e.location, e.notes, e.nextAction, e.payRange,
    e.contact.name, e.contact.role, e.contact.info, ...e.activities.map((a) => `${a.note} ${a.contact}`)].join(' ');
  return hay.toLowerCase().includes(logUi.q);
}

async function renderLog() {
  const [log, settings] = await Promise.all([getLog(), getSettings()]);
  const entries = log.map((e) => normalizeEntry(e, settings.followUpDays));
  const due = entries.filter(isDue);
  const count = (fn) => entries.filter(fn).length;

  $('logSummary').textContent = entries.length
    ? [
      `${entries.length} job(s)`,
      `${count((e) => e.appliedAt)} applied`,
      `${count((e) => ACTIVE.has(e.status))} active`,
      count((e) => ['interviewing', 'offer'].includes(e.status)) ? `${count((e) => ['interviewing', 'offer'].includes(e.status))} interviewing/offer` : '',
      due.length ? `${due.length} follow-up due` : '',
    ].filter(Boolean).join(' · ')
    : 'No jobs yet. Tailor one from the Job tab.';
  $('dueCount').hidden = !due.length;
  $('dueCount').textContent = due.length;

  // Due first (most overdue at the top), then upcoming follow-ups, then most recently touched.
  const shown = entries.filter((e) => matchesFilter(e) && matchesSearch(e)).sort((a, b) => {
    const da = isDue(a), db = isDue(b);
    if (da !== db) return da ? -1 : 1;
    if (da) return a.nextFollowUpAt.localeCompare(b.nextFollowUpAt);
    const na = ACTIVE.has(a.status) && a.nextFollowUpAt, nb = ACTIVE.has(b.status) && b.nextFollowUpAt;
    if (!!na !== !!nb) return na ? -1 : 1;
    if (na) return a.nextFollowUpAt.localeCompare(b.nextFollowUpAt);
    return lastTouched(b).localeCompare(lastTouched(a));
  });

  const list = $('logList');
  list.innerHTML = '';
  if (entries.length && !shown.length) list.appendChild(el('p', 'small muted', 'Nothing matches this filter.'));
  for (const e of shown) list.appendChild(logCard(e, settings));
}

function stageClass(id) {
  if (id === 'offer' || id === 'accepted') return 'stage good';
  if (ACTIVE.has(id)) return 'stage active';
  if (CLOSED.has(id)) return 'stage closed';
  return 'stage';
}

function logCard(e, settings) {
  const card = el('div', `app${isDue(e) ? ' due' : ''}${CLOSED.has(e.status) ? ' closed' : ''}`);
  const head = el('div', 'app-head');
  const left = el('div', 'grow');
  const a = el('a', null, e.title || 'Untitled');
  a.href = e.url; a.target = '_blank';
  left.appendChild(a);
  const applied = e.appliedAt ? `applied ${shortDate(e.appliedAt)}` : `added ${shortDate(e.createdAt)}`;
  left.appendChild(el('div', 'meta', [e.company, e.location, applied].filter(Boolean).join(' · ')));

  // Last contact and the next step, so the list answers "what do I do today?"
  const last = lastContact(e);
  const fu = followUpCount(e);
  if (last) {
    const bits = [typeLabel(last.type)];
    if (last.method) bits.push(`via ${methodLabel(last.method)}`);
    bits.push(daysAgo(last.at));
    left.appendChild(el('div', 'meta', `Last: ${bits.join(' ')}${fu ? ` · ${fu} follow-up${fu === 1 ? '' : 's'}` : ''}`));
  }
  if (ACTIVE.has(e.status) && e.nextFollowUpAt) {
    const due = isDue(e);
    const when = e.nextFollowUpAt === todayStr() ? 'today' : shortDate(e.nextFollowUpAt);
    const text = `${due ? (e.nextFollowUpAt < todayStr() ? `Overdue since ${when}` : 'Due today') : `Next: ${when}`}${e.nextAction ? ` · ${e.nextAction}` : ''}`;
    left.appendChild(el('div', `next${due ? ' flag' : ''}`, text));
  }

  const right = el('div');
  right.style.textAlign = 'right';
  right.appendChild(el('span', stageClass(e.status), stageLabel(e.status)));
  if (e.fit != null && e.fit !== '') right.appendChild(el('div', 'fit', `fit ${e.fit}`));
  const toggle = el('button', 'btn small', logUi.open.has(e.id) ? 'Close' : 'Track');
  toggle.style.marginTop = '4px';
  toggle.onclick = () => {
    if (logUi.open.has(e.id)) logUi.open.delete(e.id); else logUi.open.add(e.id);
    card.replaceWith(logCard(e, settings));
  };
  right.appendChild(toggle);

  head.append(left, right);
  card.appendChild(head);
  if (logUi.open.has(e.id)) card.appendChild(logDetail(e, settings));
  return card;
}

function field(label, input, cls) {
  const l = el('label', `f${cls ? ` ${cls}` : ''}`, label);
  l.appendChild(input);
  return l;
}
function textInput(value, placeholder = '') {
  const i = el('input');
  i.type = 'text'; i.value = value || ''; i.placeholder = placeholder;
  return i;
}
function dateInput(value) {
  const i = el('input');
  i.type = 'date'; i.value = value || '';
  return i;
}
function selectOf(options, value, blank) {
  const s = el('select');
  if (blank != null) s.add(new Option(blank, ''));
  for (const o of options) s.add(new Option(o.label, o.id, false, o.id === value));
  if (value != null) s.value = value;
  return s;
}

function logDetail(e, settings) {
  const box = el('div', 'detail');
  const saved = (msg = 'Saved.') => setStatus($('logStatus'), msg);
  const save = async (patch) => { await upsertLog({ id: e.id, ...patch, updatedAt: new Date().toISOString() }); Object.assign(e, patch); saved(); };

  // --- status and next step ---
  const grid = el('div', 'grid2');
  const stage = selectOf(STAGES, e.status);
  stage.onchange = async () => {
    await changeStage(e, stage.value, settings);
    saved(`Moved to ${stageLabel(stage.value)}.`);
    renderLog();
  };
  const next = dateInput(e.nextFollowUpAt);
  next.onchange = () => save({ nextFollowUpAt: next.value });
  const action = textInput(e.nextAction, 'e.g. Follow-up #2 to the recruiter');
  action.onchange = () => save({ nextAction: action.value.trim() });
  grid.append(field('Stage', stage), field('Next follow-up', next), field('Next action', action, 'span2'));
  box.appendChild(grid);

  // --- who and what ---
  const people = el('div', 'grid2');
  people.style.marginTop = '6px';
  const cName = textInput(e.contact.name, 'Name');
  const cRole = textInput(e.contact.role, 'Recruiter, hiring manager…');
  const cInfo = textInput(e.contact.info, 'Email, phone or LinkedIn URL');
  const saveContact = () => save({ contact: { name: cName.value.trim(), role: cRole.value.trim(), info: cInfo.value.trim() } });
  [cName, cRole, cInfo].forEach((i) => { i.onchange = saveContact; });
  const pay = textInput(e.payRange, 'e.g. $105–120K');
  pay.onchange = () => save({ payRange: pay.value.trim() });
  people.append(field('Contact', cName), field('Their role', cRole), field('Contact info', cInfo), field('Pay range', pay));
  const notes = el('textarea');
  notes.rows = 3; notes.value = e.notes || '';
  notes.placeholder = 'Anything worth remembering: referral, team, interview format, salary talk, red flags.';
  notes.onchange = () => save({ notes: notes.value.trim() });
  people.appendChild(field('Notes', notes, 'span2'));
  box.appendChild(people);

  // --- log an activity ---
  const sub = el('div', 'subcard');
  sub.appendChild(el('h3', null, 'Log an activity'));
  const ag = el('div', 'grid2');
  const type = selectOf(ACTIVITY_TYPES, 'follow_up');
  const method = selectOf(METHODS, 'email', '—');
  const when = dateInput(todayStr());
  const who = textInput(e.contact.name, 'Who you contacted');
  const toStage = selectOf(STAGES, e.status);
  const aNote = el('textarea');
  aNote.rows = 2;
  aNote.placeholder = 'What you sent or what happened. Questions asked, promises made, next steps.';
  const aNext = dateInput('');
  const aAction = textInput('');
  const applyDefaults = (typeChanged) => {
    const t = TYPE_BY_ID[type.value];
    if (typeChanged) {
      method.value = t.method || '';
      toStage.value = t.stage && !(CLOSED.has(e.status) && !CLOSED.has(t.stage)) ? t.stage : e.status;
    }
    const d = activityDefaults(type.value, when.value || todayStr(), e, settings.followUpDays);
    aNext.value = CLOSED.has(toStage.value) ? '' : d.next;
    aAction.value = CLOSED.has(toStage.value) ? '' : d.action;
  };
  type.onchange = () => applyDefaults(true);
  when.onchange = () => applyDefaults(false);
  toStage.onchange = () => applyDefaults(false);
  applyDefaults(true);

  ag.append(
    field('What happened', type), field('Method', method),
    field('Date', when), field('With', who),
    field('Stage after this', toStage, 'span2'),
    field('Details', aNote, 'span2'),
    field('Then follow up on', aNext), field('Next action', aAction),
  );
  sub.appendChild(ag);
  const addBtn = el('button', 'btn primary', 'Add to timeline');
  addBtn.style.marginTop = '6px';
  addBtn.onclick = async () => {
    if (!when.value) { when.focus(); return; }
    const patch = { nextFollowUpAt: aNext.value, nextAction: aAction.value.trim() };
    if (toStage.value !== e.status) Object.assign(patch, stagePatch(e, toStage.value, settings.followUpDays), { nextFollowUpAt: aNext.value, nextAction: aAction.value.trim() });
    await addActivity(e.id, {
      type: type.value,
      method: method.value,
      at: dateToIso(when.value),
      contact: who.value.trim(),
      note: aNote.value.trim(),
      stage: toStage.value,
      stageFrom: e.status,
    }, patch);
    if (who.value.trim() && !e.contact.name) await upsertLog({ id: e.id, contact: { ...e.contact, name: who.value.trim() } });
    saved(`${typeLabel(type.value)} logged${patch.nextFollowUpAt ? `. Next follow-up ${shortDate(patch.nextFollowUpAt)}` : ''}.`);
    renderLog();
  };
  sub.appendChild(addBtn);
  box.appendChild(sub);

  // --- timeline ---
  const tl = el('div', 'subcard');
  tl.appendChild(el('h3', null, `Timeline · ${e.activities.length} entr${e.activities.length === 1 ? 'y' : 'ies'}`));
  const ul = el('ul', 'timeline');
  const acts = [...e.activities].sort((x, y) => String(y.at).localeCompare(String(x.at)));
  let fuN = followUpCount(e);
  for (const act of acts) {
    const li = el('li');
    li.appendChild(el('span', 'when', shortDate(act.at)));
    const what = el('span', 'what');
    const label = act.type === 'follow_up' ? `${typeLabel(act.type)} #${fuN--}` : typeLabel(act.type);
    const head = el('b', null, label);
    what.appendChild(head);
    const bits = [];
    if (act.method) bits.push(`via ${methodLabel(act.method)}`);
    if (act.contact) bits.push(`with ${act.contact}`);
    if (act.stageFrom && act.stage && act.stageFrom !== act.stage) bits.push(`${stageLabel(act.stageFrom)} → ${stageLabel(act.stage)}`);
    else if (act.stage && act.type !== 'stage') bits.push(`at ${stageLabel(act.stage)}`);
    if (bits.length) what.appendChild(el('span', 'muted', ` ${bits.join(' · ')}`));
    if (act.note) what.appendChild(el('div', 'n', act.note));
    const x = el('button', 'x', '✕');
    x.title = 'Remove this entry';
    x.onclick = async () => {
      if (!confirm('Remove this timeline entry?')) return;
      await removeActivity(e.id, act.id);
      renderLog();
    };
    li.append(what, x);
    ul.appendChild(li);
  }
  if (!acts.length) ul.appendChild(el('li', 'small muted', 'Nothing logged yet.'));
  tl.appendChild(ul);
  box.appendChild(tl);

  const foot = el('div', 'row');
  foot.style.marginTop = '8px';
  foot.appendChild(el('span', 'grow'));
  const del = el('button', 'btn small', 'Remove job from log');
  del.onclick = async () => {
    if (!confirm(`Remove "${e.title}" and its timeline from the log?`)) return;
    await saveLog((await getLog()).filter((x) => x.id !== e.id));
    logUi.open.delete(e.id);
    renderLog();
  };
  foot.appendChild(del);
  box.appendChild(foot);
  return box;
}

// ---------- CSV export ----------
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
async function downloadCsv(rows, cols, name) {
  const csv = [cols.map((c) => c[0]).join(','), ...rows.map((r) => cols.map((c) => csvCell(c[1](r))).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  await chrome.downloads.download({ url, filename: `Job Tailor/${name}-${todayStr()}.csv`, saveAs: true });
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
async function loadEntries() {
  const [log, settings] = await Promise.all([getLog(), getSettings()]);
  return log.map((e) => normalizeEntry(e, settings.followUpDays));
}

$('exportCsv').addEventListener('click', async () => {
  const entries = await loadEntries();
  const day = (v) => (v ? localDate(v) : '');
  await downloadCsv(entries, [
    ['Added', (e) => day(e.createdAt)],
    ['Company', (e) => e.company],
    ['Title', (e) => e.title],
    ['Location', (e) => e.location],
    ['URL', (e) => e.url],
    ['Fit', (e) => e.fit],
    ['Stage', (e) => stageLabel(e.status)],
    ['Applied', (e) => day(e.appliedAt)],
    ['Follow-ups sent', (e) => followUpCount(e)],
    ['Last contact', (e) => { const l = lastContact(e); return l ? day(l.at) : ''; }],
    ['Last contact type', (e) => { const l = lastContact(e); return l ? typeLabel(l.type) : ''; }],
    ['Last contact method', (e) => { const l = lastContact(e); return l ? methodLabel(l.method) : ''; }],
    ['Next follow-up', (e) => (ACTIVE.has(e.status) ? e.nextFollowUpAt : '')],
    ['Next action', (e) => e.nextAction],
    ['Follow-up due', (e) => (isDue(e) ? 'yes' : '')],
    ['Contact', (e) => e.contact.name],
    ['Contact role', (e) => e.contact.role],
    ['Contact info', (e) => e.contact.info],
    ['Pay range', (e) => e.payRange],
    ['Notes', (e) => e.notes],
    ['Timeline', (e) => [...e.activities].sort((x, y) => String(x.at).localeCompare(String(y.at))).map(activityLine).join(' | ')],
  ], 'application-log');
});

$('exportActivity').addEventListener('click', async () => {
  const entries = await loadEntries();
  const rows = entries.flatMap((e) => e.activities.map((a) => ({ e, a })))
    .sort((x, y) => String(x.a.at).localeCompare(String(y.a.at)));
  await downloadCsv(rows, [
    ['Date', (r) => localDate(r.a.at)],
    ['Company', (r) => r.e.company],
    ['Title', (r) => r.e.title],
    ['Activity', (r) => typeLabel(r.a.type)],
    ['Method', (r) => methodLabel(r.a.method)],
    ['With', (r) => r.a.contact],
    ['Stage before', (r) => stageLabel(r.a.stageFrom)],
    ['Stage after', (r) => stageLabel(r.a.stage)],
    ['Details', (r) => r.a.note],
    ['URL', (r) => r.e.url],
  ], 'application-activity');
});

// ---------- init ----------
(async () => {
  await migrate();
  checkSetup();
  checkBackup();
  updateOpenCount();
  updateDueCount();
  const { panelState, pendingQuestion } = await chrome.storage.session.get(['panelState', 'pendingQuestion']);
  if (panelState) {
    Object.assign(state, panelState);
    renderJob();
    renderResult();
  }
  handlePending(pendingQuestion);
})();
