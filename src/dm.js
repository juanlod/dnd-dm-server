import { RATE_LIMIT_MS, DM_MODE, OPENAI_API_KEY } from './config.js';
import { getRoomContext } from './room-context.js';
import { askOpenAIWithFallback } from './openai.js';
import { partyContextText } from './party.js';

export function mockDMReply(userText) {
  const hooks = [
    'El aire huele a humedad y madera vieja.',
    'Una brisa apaga por un segundo tu antorcha.',
    'Oyes un murmullo detrás de una pared de piedra.',
    'El suelo cruje como si algo se moviese debajo.'
  ];
  const options = [
    'Examinar más de cerca (Investigación DC 12).',
    'Avanzar con sigilo (Sigilo DC 13).',
    'Llamar a quien esté ahí.',
    'Preparar un arma y esperar.',
    'Retroceder y buscar otra ruta.'
  ];
  const hook = hooks[Math.floor(Math.random() * hooks.length)];
  const shuffled = options.sort(() => Math.random() - 0.5).slice(0, 4);
  return [
    `Tomas una decisión tras decir: "${userText}".`,
    hook,
    '',
    '¿Qué haces ahora? Opciones:',
    ...shuffled.map((o, i) => `${i + 1}) ${o}`)
  ].join('\n');
}

export async function askDM(roomId, userMessage) {
  const ctx = getRoomContext(roomId);

  const now = Date.now();
  if (now - ctx.lastAskAt < RATE_LIMIT_MS) {
    return '⏳ Espera un poco antes de volver a preguntar al DM.';
  }
  ctx.lastAskAt = now;

  ctx.messages.push({ role: 'user', content: userMessage });

  const partyCtx = partyContextText(roomId);
  const allMessages = [
    { role: 'system', content: ctx.system },
    { role: 'system', content: partyCtx },
    ...ctx.messages
  ];

  if (ctx.dmMode === 'mock' || DM_MODE === 'mock' || !OPENAI_API_KEY) {
    const reply = mockDMReply(userMessage);
    ctx.messages.push({ role: 'assistant', content: reply });
    if (ctx.messages.length > 40) ctx.messages.splice(0, 10);
    return reply;
  }

  try {
    const reply = await askOpenAIWithFallback(allMessages);
    ctx.messages.push({ role: 'assistant', content: reply });
    if (ctx.messages.length > 40) ctx.messages.splice(0, 10);
    return reply;
  } catch (err) {
    console.error('[DM] Error OpenAI:', err);
    const insufficient = err?.status === 429 && (err?.code === 'insufficient_quota' || /quota/i.test(err?.message || ''));
    if (insufficient) {
      ctx.dmMode = 'mock';
      const fallback = mockDMReply(userMessage);
      ctx.messages.push({ role: 'assistant', content: fallback });
      return [
        '⚠️ OpenAI sin cuota en este momento. Cambio automático a DM local.',
        '',
        fallback
      ].join('\n');
    }
    return `⚠️ Error del modelo: ${err?.message || err?.code || err?.status || 'desconocido'}`;
  }
}
