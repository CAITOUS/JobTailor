import { MODELS, callClaude } from './lib/claude.js';
import { getSettings, saveSettings, getSources, saveSources, DEFAULT_RULES } from './lib/store.js';

const $ = (id) => document.getElementById(id);
const PROFILE_FIELDS = ['fullName', 'email', 'phone', 'location', 'linkedin', 'website'];

let saveTimer;
function flashSaved() {
  $('saved').textContent = 'Saved';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { $('saved').textContent = ''; }, 1500);
}

async function save() {
  const profile = Object.fromEntries(PROFILE_FIELDS.map((f) => [f, $(f).value.trim()]));
  await saveSettings({
    apiKey: $('apiKey').value.trim(),
    model: $('model').value,
    effort: $('effort').value,
    answerModel: $('answerModel').value,
    answerEffort: $('answerEffort').value,
    rules: $('rules').value,
    knownAnswers: $('knownAnswers').value,
    followUpDays: Math.max(1, parseInt($('followUpDays').value, 10) || 10),
    profile,
  });
  flashSaved();
}

async function renderSources() {
  const sources = await getSources();
  const list = $('sourceList');
  list.innerHTML = '';
  for (const s of sources) {
    const row = document.createElement('div');
    row.className = 'src';
    const name = document.createElement('span');
    name.className = 'grow';
    name.textContent = s.name;
    const size = document.createElement('span');
    size.className = 'small muted';
    size.textContent = `${Math.round(s.text.length / 4).toLocaleString()} tokens (approx.)`;
    const del = document.createElement('button');
    del.className = 'btn small';
    del.textContent = 'Remove';
    del.onclick = async () => {
      await saveSources((await getSources()).filter((x) => x.name !== s.name));
      renderSources();
    };
    row.append(name, size, del);
    list.appendChild(row);
  }
  const total = sources.reduce((n, s) => n + s.text.length, 0);
  $('sourceTotal').textContent = sources.length
    ? `${sources.length} file(s), about ${Math.round(total / 4).toLocaleString()} tokens. Cached after the first call, so repeat calls cost less.`
    : 'No source files loaded yet.';
}

$('fileInput').addEventListener('change', async (e) => {
  const sources = await getSources();
  for (const file of e.target.files) {
    const text = await file.text();
    const i = sources.findIndex((s) => s.name === file.name);
    const entry = { name: file.name, text, addedAt: new Date().toISOString() };
    if (i >= 0) sources[i] = entry; else sources.push(entry);
  }
  await saveSources(sources);
  e.target.value = '';
  renderSources();
  flashSaved();
});

$('resetRules').addEventListener('click', async () => {
  $('rules').value = DEFAULT_RULES;
  await save();
});

$('testKey').addEventListener('click', async () => {
  await save();
  const s = await getSettings();
  $('testStatus').textContent = 'Testing…';
  $('testStatus').classList.remove('err');
  try {
    await callClaude({
      apiKey: s.apiKey, model: s.answerModel, effort: 'low', maxTokens: 64,
      system: [{ type: 'text', text: 'Reply with OK.' }],
      messages: [{ role: 'user', content: 'Ping' }],
    });
    $('testStatus').textContent = 'Key works.';
  } catch (err) {
    $('testStatus').textContent = err.message;
    $('testStatus').classList.add('err');
  }
});

(async () => {
  for (const id of ['model', 'answerModel']) {
    for (const [value, label] of Object.entries(MODELS)) $(id).add(new Option(label, value));
  }
  const s = await getSettings();
  $('apiKey').value = s.apiKey;
  $('model').value = s.model;
  $('effort').value = s.effort;
  $('answerModel').value = s.answerModel;
  $('answerEffort').value = s.answerEffort;
  $('rules').value = s.rules;
  $('knownAnswers').value = s.knownAnswers;
  $('followUpDays').value = s.followUpDays;
  for (const f of PROFILE_FIELDS) $(f).value = s.profile[f] || '';
  renderSources();

  document.querySelectorAll('input[type=text], textarea').forEach((el) => el.addEventListener('change', save));
  document.querySelectorAll('select').forEach((el) => el.addEventListener('change', save));
})();
