export function rollDice(notation = '1d20+0') {
    const m = (notation || '').toLowerCase().match(/^(\d+)d(\d+)([+-]\d+)?$/);
    if (!m) return { ok: false, error: 'Notación inválida. Usa p.ej. 1d20+5' };
    const count = parseInt(m[1], 10);
    const faces = parseInt(m[2], 10);
    const mod = parseInt(m[3] || '0', 10);
    if (count <= 0 || faces <= 1) return { ok: false, error: 'Dados inválidos.' };
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * faces));
    const total = rolls.reduce((a, b) => a + b, 0) + mod;
    return { ok: true, rolls, mod, total, faces, count };
  }
  