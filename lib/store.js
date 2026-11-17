// chrome.storage.local wrappers. Everything stays on this device.

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
