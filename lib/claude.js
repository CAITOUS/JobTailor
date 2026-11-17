// Minimal Claude Messages API client for an unbundled extension page.
// The extension has no build step, so this uses fetch instead of the SDK.

const API_URL = 'https://api.anthropic.com/v1/messages';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export const MODELS = {
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 (balanced, default)',
  'claude-opus-5-5': 'Claude Opus 5.5 (strongest writing, ~2x cost)',
  'claude-haiku-5-5': 'Claude Haiku 5.5 (fastest, cheapest)',
};

export class ClaudeError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(apiKey, body, useFallback) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const payload = { ...body };
  if (useFallback) {
    headers['anthropic-beta'] = FALLBACK_BETA;
    payload.fallbacks = 'default';
  }
  return fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
}

/**
 * system: array of text blocks (put cache_control on the last stable one)
 * schema: JSON schema for structured output; the parsed object is returned as `json`
 */
export async function callClaude({ apiKey, model, effort, system, messages, schema, maxTokens = 16000 }) {
  if (!apiKey) throw new ClaudeError('Add your Claude API key in Options first.');
  const output_config = { effort };
  if (schema) output_config.format = { type: 'json_schema', schema };
  const body = { model, max_tokens: maxTokens, system, messages, output_config };

  // Server-side refusal fallback (beta, Sonnet/Opus only); dropped if the API rejects it.
  let useFallback = model !== 'claude-haiku-5-5';
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      res = await post(apiKey, body, useFallback);
    } catch (e) {
      if (attempt === 3) throw new ClaudeError(`Network error reaching the Claude API: ${e.message}`);
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    if (res.ok) break;
    const errText = await res.text();
    if (res.status === 400 && useFallback && /fallback/i.test(errText)) { useFallback = false; continue; }
    if (res.status === 401) throw new ClaudeError('API key rejected (401). Check it in Options.');
    if (res.status === 403) throw new ClaudeError('API key lacks permission for this model (403).');
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
      continue;
    }
    let msg = errText;
    try { msg = JSON.parse(errText).error.message; } catch (_) { /* keep raw */ }
    throw new ClaudeError(`Claude API error ${res.status}: ${msg}`);
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    throw new ClaudeError('Claude declined this request. Try rephrasing or a different model.');
  }
  if (data.stop_reason === 'max_tokens') {
    throw new ClaudeError('The response was cut off (max tokens). Try a lower effort level or shorter sources.');
  }
  const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let json = null;
  if (schema) {
    try { json = JSON.parse(text); } catch (_) { throw new ClaudeError('Claude returned malformed JSON. Try again.'); }
  }
  return { text, json, usage: data.usage || {}, model: data.model };
}

// Rough cost estimate in USD from usage, for the status line.
const PRICES = {
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
};
export function estimateCost(model, u) {
  const [inp, out, read] = PRICES[model] || PRICES['claude-sonnet-5-5'];
  const write = inp * 1.25;
  const usd = ((u.input_tokens || 0) * inp + (u.output_tokens || 0) * out +
    (u.cache_read_input_tokens || 0) * read + (u.cache_creation_input_tokens || 0) * write) / 1e6;
  return usd;
}
