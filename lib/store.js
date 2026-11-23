// chrome.storage.local wrappers. Everything stays on this device.
// Data survives extension updates as long as the extension ID stays the same
// (pinned by "key" in manifest.json). Removing the extension deletes it, so
// Options also offers a full JSON backup.

import { normalizeEntry, newActivity, isDue } from './tracking.js';

export const DATA_VERSION = 3;

export const DEFAULT_RULES = [
  'Use only facts that appear in the source files. Never invent metrics, employers, titles, dates, tools, or certifications.',
  'Never list a proposed, acting, or offered title as one I held.',
  'Never name other people in HR, disciplinary, or incident-related content.',
  'The cover letter must not repeat the resume. Write it as a letter of personability and applicability: who I am, how I work, and why this role and company fit.',
  'Follow any display rules stated in the source files (for example, how prior roles or certifications should appear).',
].join('\n');

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-sonnet-5-5',
  answerModel: 'claude-sonnet-5-5',
  effort: 'medium',
  answerEffort: 'low',
  followUpDays: 10,
  qrCodes: false,
  rules: DEFAULT_RULES,
  knownAnswers: '',
  profile: { fullName: '', email: '', phone: '', location: '', linkedin: '', website: '' },
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}), profile: { ...DEFAULT_SETTINGS.profile, ...((settings || {}).profile || {}) } };
}
export async function saveSettings(patch) {
  const cur = await getSettings();
  await chrome.storage.local.set({ settings: { ...cur, ...patch } });
}

export async function getSources() {
  const { sources } = await chrome.storage.local.get('sources');
  return sources || [];
}
export async function saveSources(sources) {
  await chrome.storage.local.set({ sources });
}

export async function getLog() {
  const { log } = await chrome.storage.local.get('log');
  return log || [];
}
export async function saveLog(log) {
  await chrome.storage.local.set({ log });
}
export async function upsertLog(entry) {
  const log = await getLog();
  const i = log.findIndex((e) => e.id === entry.id);
  if (i >= 0) log[i] = { ...log[i], ...entry };
  else log.unshift(entry);
  await saveLog(log);
  return log;
}

// Adds an activity to an entry's timeline and applies any other changes (stage, next follow-up) in one write.
export async function addActivity(entryId, fields, patch = {}) {
  const log = await getLog();
  const i = log.findIndex((e) => e.id === entryId);
  if (i < 0) return null;
  const act = newActivity(fields);
  const activities = [...(log[i].activities || []), act];
  log[i] = { ...log[i], ...patch, activities, updatedAt: new Date().toISOString() };
  await saveLog(log);
  return act;
}
export async function removeActivity(entryId, activityId) {
  const log = await getLog();
  const e = log.find((x) => x.id === entryId);
  if (!e) return;
  e.activities = (e.activities || []).filter((a) => a.id !== activityId);
  await saveLog(log);
}
export async function dueCount() {
  const [log, settings] = await Promise.all([getLog(), getSettings()]);
  return log.map((e) => normalizeEntry(e, settings.followUpDays)).filter(isDue).length;
}

// ---------- context: notes and gap action items ----------
// { id, kind: 'note' | 'gap', title, text, status: 'open' | 'done' | 'dismissed',
//   jobs: [{ company, title, url }], source: { title, url } | null, createdAt, updatedAt }
// Items with text (and not dismissed) are sent to Claude as candidate-provided facts.

export async function getContext() {
  const { context } = await chrome.storage.local.get('context');
  return context || [];
}
export async function saveContext(context) {
  await chrome.storage.local.set({ context });
}
export async function upsertContext(item) {
  const context = await getContext();
  const now = new Date().toISOString();
  const i = context.findIndex((c) => c.id === item.id);
  if (i >= 0) context[i] = { ...context[i], ...item, updatedAt: now };
  else context.unshift({ status: 'open', jobs: [], source: null, title: '', text: '', createdAt: now, ...item, updatedAt: now });
  await saveContext(context);
  return context;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Adds a gap as an action item; the same gap from another job is merged into the existing item.
export async function addGapAction(gap, job) {
  const context = await getContext();
  const ref = { company: job.company, title: job.title, url: job.url };
  const existing = context.find((c) => c.kind === 'gap' && norm(c.title) === norm(gap));
  if (existing) {
    if (!existing.jobs.some((j) => j.url === ref.url)) existing.jobs.push(ref);
    if (existing.status === 'dismissed') existing.status = 'open';
    existing.updatedAt = new Date().toISOString();
    await saveContext(context);
    return existing;
  }
  const item = { id: crypto.randomUUID(), kind: 'gap', title: gap, jobs: [ref] };
  await upsertContext(item);
  return item;
}
export async function addNote(text, source = null, title = '') {
  const item = { id: crypto.randomUUID(), kind: 'note', title, text, status: 'done', source };
  await upsertContext(item);
  return item;
}

// ---------- migrations, backup, restore ----------
// Each step upgrades stored data from version N-1 to N. Never delete fields here.
const MIGRATIONS = {
  2: async () => {
    const { context } = await chrome.storage.local.get('context');
    if (!context) await chrome.storage.local.set({ context: [] });
  },
  // Tracking: activity timeline, next follow-up date and action, contact, pay range.
  3: async () => {
    const [log, settings] = await Promise.all([getLog(), getSettings()]);
    await saveLog(log.map((e) => normalizeEntry(e, settings.followUpDays)));
  },
};

export async function migrate() {
  const { dataVersion = 1 } = await chrome.storage.local.get('dataVersion');
  for (let v = dataVersion + 1; v <= DATA_VERSION; v++) {
    if (MIGRATIONS[v]) await MIGRATIONS[v]();
    await chrome.storage.local.set({ dataVersion: v });
  }
}

const BACKUP_KEYS = ['settings', 'sources', 'context', 'log'];

export async function exportAll({ includeApiKey = false } = {}) {
  const data = await chrome.storage.local.get([...BACKUP_KEYS, 'dataVersion']);
  if (data.settings && !includeApiKey) data.settings = { ...data.settings, apiKey: '' };
  await chrome.storage.local.set({ lastBackupAt: new Date().toISOString() });
  return {
    app: 'job-tailor',
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    dataVersion: data.dataVersion || 1,
    data: Object.fromEntries(BACKUP_KEYS.map((k) => [k, data[k]])),
  };
}

// Merges a backup into current data: nothing already here is deleted.
// Items match by id (log, context) or file name (sources); the backup wins on conflicts.
export async function importAll(backup) {
  if (!backup || backup.app !== 'job-tailor' || !backup.data) throw new Error('This is not a Job Tailor backup file.');
  if ((backup.dataVersion || 1) > DATA_VERSION) throw new Error('This backup is from a newer version of Job Tailor. Update the extension first.');
  const d = backup.data;
  const cur = await chrome.storage.local.get(BACKUP_KEYS);
  const mergeBy = (a = [], b = [], key) => {
    const map = new Map(a.map((x) => [x[key], x]));
    for (const x of b) map.set(x[key], { ...(map.get(x[key]) || {}), ...x });
    return [...map.values()];
  };
  const settings = { ...(cur.settings || {}), ...(d.settings || {}) };
  if (!(d.settings || {}).apiKey && cur.settings && cur.settings.apiKey) settings.apiKey = cur.settings.apiKey;
  // Log entries also merge their activity timelines, so follow-ups logged on either side are kept.
  const curLog = new Map((cur.log || []).map((e) => [e.id, e]));
  const log = mergeBy(cur.log, d.log, 'id').map((e) => {
    const before = curLog.get(e.id);
    if (!before || !before.activities) return e;
    return { ...e, activities: mergeBy(before.activities, e.activities, 'id').sort((x, y) => String(x.at).localeCompare(String(y.at))) };
  });
  await chrome.storage.local.set({
    settings,
    sources: mergeBy(cur.sources, d.sources, 'name'),
    context: mergeBy(cur.context, d.context, 'id'),
    log: log.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))),
    dataVersion: backup.dataVersion || 1,
  });
  await migrate();
  return {
    sources: (d.sources || []).length,
    context: (d.context || []).length,
    log: (d.log || []).length,
  };
}
