import { OPENAI_API_KEY, MODEL, FALLBACK_MODELS, MAX_TOKENS } from './config.js';

function authHeaders() {
  const h = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json'
  };
  if (process.env.OPENAI_ORG) h['OpenAI-Organization'] = process.env.OPENAI_ORG;
  if (process.env.OPENAI_PROJECT) h['OpenAI-Project'] = process.env.OPENAI_PROJECT;
  return h;
}

export async function callChatCompletions(model, messages, maxTokens = MAX_TOKENS) {
  const payload = { model, messages, temperature: 0.8, max_tokens: maxTokens };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { }

  if (!res.ok) {
    const err = new Error(data?.error?.message || text || `HTTP ${res.status}`);
    err.name = 'OpenAIApiError';
    err.status = res.status;
    err.code = data?.error?.code;
    err.type = data?.error?.type;
    throw err;
  }
  const choice = data?.choices?.[0];
  return {
    content: choice?.message?.content?.trim() || '(sin respuesta)',
    finishReason: choice?.finish_reason || null
  };
}

export async function askOpenAIWithFallback(allMessages, { continueIfClipped = true } = {}) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no configurada');
  const candidates = [MODEL, ...FALLBACK_MODELS].filter((v, i, a) => v && a.indexOf(v) === i);

  let lastErr;
  for (const m of candidates) {
    try {
      let { content, finishReason } = await callChatCompletions(m, allMessages, MAX_TOKENS);

      if (continueIfClipped && finishReason === 'length') {
        let acc = content;
        let tries = 0;
        let msgs = [...allMessages, { role: 'assistant', content }];

        while (tries < 2) {
          msgs = [...msgs, { role: 'user', content: 'Continúa exactamente desde donde lo dejaste, sin repetir texto previo.' }];
          const more = await callChatCompletions(m, msgs, MAX_TOKENS);
          acc += '\n' + more.content;
          if (more.finishReason !== 'length') break;
          msgs = [...msgs, { role: 'assistant', content: more.content }];
          tries++;
        }
        return acc;
      }
      return content;

    } catch (e) {
      lastErr = e;
      const notFound = e?.status === 404 || e?.code === 'model_not_found';
      const insufficient = e?.status === 429 && (e?.code === 'insufficient_quota' || /quota/i.test(e?.message || ''));
      if (insufficient) throw e;
      if (!notFound) throw e;
      console.warn(`[DM] Modelo no disponible: ${m} (${e?.code || e?.status}). Probando siguiente...`);
    }
  }
  throw lastErr;
}
