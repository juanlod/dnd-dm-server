export function stripDiacritics(s) {
    try { return s.normalize('NFD').replace(/\p{Diacritic}/gu, ''); } catch { return s; }
  }
  
  export function stripCmdLines(s = '') {
    if (!s) return s;
    let out = s.split(/\r?\n/).filter(line => !/^\s*\[CMD:[^\]]+\]\s*$/i.test(line)).join('\n');
    out = out.replace(/\s*\[CMD:[^\]]+\]\s*/gi, ' ').replace(/\s{2,}/g, ' ').trim();
    return out;
  }