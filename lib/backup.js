import { exportAll } from './store.js';

// Saves a full backup (settings, sources, context, log) as JSON to Downloads/Job Tailor/backups/.
export async function downloadBackup({ includeApiKey = false, saveAs = false } = {}) {
  const backup = await exportAll({ includeApiKey });
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  try {
    await chrome.downloads.download({ url, filename: `Job Tailor/backups/job-tailor-backup-${stamp}.json`, saveAs, conflictAction: 'uniquify' });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export const BACKUP_REMINDER_DAYS = 14;
