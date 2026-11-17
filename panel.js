import { callClaude, estimateCost } from './lib/claude.js';
import { buildSystem, JOB_SCHEMA, jobPrompt, ANSWER_SCHEMA, answerPrompt } from './lib/prompts.js';
import { buildResumeDocx, buildCoverLetterDocx, DOCX_MIME } from './lib/docx.js';
import { extractJobFromPage, autofillContactFields, insertAnswerIntoPage } from './lib/extract.js';
import { getSettings, getSources, getLog, saveLog, upsertLog } from './lib/store.js';

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
    const [settings, sources] = await Promise.all([getSettings(), getSources()]);
    const { json, usage } = await callClaude({
      apiKey: settings.apiKey,
      model: settings.model,
      effort: settings.effort,
      system: buildSystem(settings, sources),
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
  fillList($('gaps'), r.gaps);
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
  await upsertLog({ id: state.logId, status: 'applied', appliedAt: new Date().toISOString() });
  setStatus($('jobStatus'), 'Marked as applied. It will be flagged for follow-up in the Log.');
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
    const [settings, sources] = await Promise.all([getSettings(), getSources()]);
    const tab = await targetTab().catch(() => null);
    const { json, usage } = await callClaude({
      apiKey: settings.apiKey,
      model: settings.answerModel,
      effort: settings.answerEffort,
      system: buildSystem(settings, sources),
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
});

// ---------- LOG ----------
const STATUSES = ['tailored', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn'];

async function renderLog() {
  const [log, settings] = await Promise.all([getLog(), getSettings()]);
  const body = $('logBody');
  body.innerHTML = '';
  const dayMs = 86_400_000;
  let due = 0;
  for (const e of log) {
    const followUp = e.status === 'applied' && e.appliedAt &&
      Date.now() - new Date(e.appliedAt).getTime() >= settings.followUpDays * dayMs;
    if (followUp) due++;
    const tr = document.createElement('tr');

    const tdJob = document.createElement('td');
    const a = document.createElement('a');
    a.href = e.url; a.target = '_blank'; a.textContent = e.title || 'Untitled';
    const sub = document.createElement('div');
    sub.className = 'muted';
    const when = e.appliedAt ? `applied ${new Date(e.appliedAt).toLocaleDateString()}` : new Date(e.createdAt).toLocaleDateString();
    sub.textContent = `${e.company || ''} · ${when}`;
    tdJob.append(a, sub);
    if (followUp) {
      const f = document.createElement('div');
      f.className = 'flag';
      f.textContent = '⚑ Follow up';
      tdJob.appendChild(f);
    }

    const tdFit = document.createElement('td');
    tdFit.textContent = e.fit ?? '';

    const tdStatus = document.createElement('td');
    const sel = document.createElement('select');
    for (const s of STATUSES) sel.add(new Option(s, s, false, s === e.status));
    sel.onchange = async () => {
      const patch = { id: e.id, status: sel.value };
      if (sel.value === 'applied' && !e.appliedAt) patch.appliedAt = new Date().toISOString();
      await upsertLog(patch);
      renderLog();
    };
    tdStatus.appendChild(sel);

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'btn small';
    del.textContent = '✕';
    del.title = 'Remove from log';
    del.onclick = async () => {
      if (!confirm(`Remove "${e.title}" from the log?`)) return;
      await saveLog((await getLog()).filter((x) => x.id !== e.id));
      renderLog();
    };
    tdDel.appendChild(del);

    tr.append(tdJob, tdFit, tdStatus, tdDel);
    body.appendChild(tr);
  }
  $('logSummary').textContent = log.length
    ? `${log.length} job(s) · ${log.filter((e) => e.appliedAt).length} applied${due ? ` · ${due} need follow-up` : ''}`
    : 'No jobs yet. Tailor one from the Job tab.';
}

$('exportCsv').addEventListener('click', async () => {
  const log = await getLog();
  const cols = ['createdAt', 'company', 'title', 'location', 'url', 'fit', 'status', 'appliedAt', 'notes'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...log.map((e) => cols.map((c) => cell(e[c])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  await chrome.downloads.download({ url, filename: `Job Tailor/application-log-${new Date().toISOString().slice(0, 10)}.csv`, saveAs: true });
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});

// ---------- init ----------
(async () => {
  checkSetup();
  const { panelState, pendingQuestion } = await chrome.storage.session.get(['panelState', 'pendingQuestion']);
  if (panelState) {
    Object.assign(state, panelState);
    renderJob();
    renderResult();
  }
  handlePending(pendingQuestion);
})();
