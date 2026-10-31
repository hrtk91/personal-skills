// The parts of a brief a reader needs on the task page, cut out of its markdown by their headings.
export interface BriefParts { problem: string | null; todo: string | null; done: string | null }

const HEADINGS: Record<keyof BriefParts, string> = { problem: "困りごと", todo: "やること", done: "終わりの条件" };

export function briefParts(markdown: string): BriefParts {
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("```")) fenced = !fenced;
    const heading = fenced ? null : /^##\s+(.+?)\s*$/.exec(line);
    if (heading) { current = heading[1]!; sections.set(current, []); continue; }
    if (current) sections.get(current)!.push(line);
  }
  const part = (name: string) => {
    const text = sections.get(name)?.join("\n").trim();
    return text ? text : null;
  };
  return { problem: part(HEADINGS.problem), todo: part(HEADINGS.todo), done: part(HEADINGS.done) };
}
