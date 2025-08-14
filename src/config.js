// Config global del servidor (ESM)
export const PORT = parseInt(process.env.PORT || '3000', 10);
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export const MODEL = process.env.MODEL || 'gpt-4o-mini';
export const DM_MODE = (process.env.DM_MODE || 'openai').toLowerCase(); // 'openai' | 'mock'
export const RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS || '1500', 10);
export const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '900', 10);
export const FALLBACK_MODELS = (process.env.FALLBACK_MODELS?.split(',') || [
  'gpt-4o-mini',
  'gpt-4o'
]).map(s => s.trim()).filter(Boolean);

// 10 minutos por turno (600 s)
export const DEFAULT_TURN_SEC = 600;
