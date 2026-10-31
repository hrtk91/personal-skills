export type Principle = { ref: string; number: string; title: string; body: string };
/** Parse numbered markdown principles without performing any filesystem access. */
export function parsePrinciples(markdown: string, target: '共通' | string = '共通'): Principle[] {
  const lines = markdown.split(/\r?\n/);
  let valueSection = false;
  const items: Principle[] = [];
  let current: { number: string; title: string; body: string[]; value: boolean } | null = null;
  const finish = () => { if (current) items.push({ ref: `${target}:${current.value ? `価値基準${current.number}` : current.number}`, number: current.number, title: current.title, body: current.body.join('\n').trim() }); };
  for (const line of lines) {
    if (/^##\s+大事な価値基準\s*$/.test(line)) { finish(); current = null; valueSection = true; continue; }
    if (/^##\s+/.test(line)) { finish(); current = null; valueSection = false; continue; }
    const match = line.match(/^(\d+[a-z]?)\.\s+\*\*(.+?)\*\*\s*(.*)$/i);
    if (match) { finish(); current = { number: match[1]!, title: match[2]!, body: match[3] ? [match[3]] : [], value: valueSection }; }
    else if (current) current.body.push(line);
  }
  finish(); return items;
}
export function hasPrincipleRef(markdown: string, ref: string, target?: string): boolean { return parsePrinciples(markdown,target).some(p => p.ref === ref); }
