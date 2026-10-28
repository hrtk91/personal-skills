import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ISSUE_FIELDS, type Issue, type IssueField, type IssueFields, type Ledger, type Task } from './ledger.ts';
import { taskContext } from './context.ts';

/** The Issue template the commanding Claude wrote (handoff/issue-template.md); found from this file, so any cwd works. */
export const TEMPLATE_PATH = fileURLToPath(new URL('../../handoff/issue-template.md', import.meta.url));

export function issueTemplate(): string {
  if (!existsSync(TEMPLATE_PATH)) throw new Error(`Issue の型がありません: ${TEMPLATE_PATH}`);
  return readFileSync(TEMPLATE_PATH, 'utf8');
}

// 「今の状態（必須）」「終わりの条件（自分で流して、出力を報告に貼る）」 → the field name.
const headingName = (heading: string): string => heading.trim().replace(/\s*[（(][^（）()]*[）)]\s*$/, '').trim();

// The template writes these as lines inside 終わりの条件 (「確かめのコマンド: `…`」), not as headings of their own.
const INLINE_FIELDS = ['確かめのコマンド', '触るファイル', '種類', '本番に出すか'] as const satisfies readonly IssueField[];

export type ParsedIssue = { title: string; fields: IssueFields; extra: string };

/**
 * Splits an Issue written as Markdown into the template's fields. Headings that are not fields (設計, 報告, 差し戻し ...)
 * and text before the first heading are kept in order as `extra`, so nothing written is dropped.
 */
export function parseIssueMarkdown(markdown: string): ParsedIssue {
  const clean = markdown.replace(/<!--[\s\S]*?-->/g, '');
  const titleMatch = clean.match(/^# (.*)$/m);
  const title = titleMatch?.[1]?.trim() ?? '';
  const fields: IssueFields = {};
  const extra: string[] = [];
  const headings = [...clean.matchAll(/^## (.+?)\s*$/gm)];
  const preamble = clean.slice(titleMatch ? titleMatch.index! + titleMatch[0].length : 0, headings[0]?.index ?? clean.length).trim();
  if (preamble) extra.push(preamble);
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i]!.index! + headings[i]![0].length;
    const end = headings[i + 1]?.index ?? clean.length;
    const text = clean.slice(start, end).trim();
    const name = headingName(headings[i]![1]!);
    if ((ISSUE_FIELDS as readonly string[]).includes(name)) {
      const field = name as IssueField;
      fields[field] = fields[field] ? `${fields[field]}\n\n${text}` : text;
    } else extra.push(`## ${headings[i]![1]!.trim()}${text ? `\n${text}` : ''}`);
  }
  for (const field of INLINE_FIELDS) {
    if (meaningful(fields[field], field)) continue;
    const value = fields['終わりの条件']?.match(new RegExp(`^${field}[:：]\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^`([^`]*)`$/, '$1').trim();
    if (meaningful(value, field)) fields[field] = value;
  }
  return { title, fields, extra: extra.join('\n\n') };
}

// The template's own explanation lines, per field (null while the template itself is being read, or when it is missing).
let templateFields: IssueFields | null | undefined;
function templateLines(field?: IssueField): Set<string> {
  if (templateFields === undefined) {
    templateFields = null;
    try { templateFields = parseIssueMarkdown(issueTemplate()).fields; } catch { templateFields = null; }
  }
  const sections = field ? [templateFields?.[field]] : Object.values(templateFields ?? {});
  return new Set(sections.flatMap((text) => (text ?? '').split('\n')).map((s) => s.trim()).filter(Boolean));
}

/** False when the value is empty, only placeholder marks (…, （…）), or only the template's explanation left as it was. */
export function meaningful(value: string | undefined, field?: IssueField): boolean {
  const placeholder = templateLines(field);
  return (value ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((s) => !placeholder.has(s))
    .some((s) => !/^(?:[-*]\s*)?(?:（[^\n]*）|\[[^\n]*\]|`?(?:…+|\.\.\.)`?)$/.test(s));
}

export function renderIssueBrief(issue: Issue, context = ''): string {
  const sections = ISSUE_FIELDS.map((field) => `## ${field}\n${issue.fields[field] ?? ''}`).join('\n\n');
  const body = issue.body.trim();
  const extra = body ? `\n\n${body.startsWith('## ') ? body : `## 中身\n${body}`}` : '';
  const history = issue.history.length ? `\n\n${issue.history.join('\n\n')}` : '';
  return `# ${issue.title}\n\n${sections}${extra}${history}${context ? `\n\n${context.trimEnd()}` : ''}\n`;
}

/** A worker's brief for an Issue: the fields, the Issue's other sections, the send-backs, then `task context` (without repeating the body). */
export function assembleIssueBrief(ledger: Ledger, issue: Issue, task?: Task): string {
  return renderIssueBrief(issue, taskContext(ledger, task ?? ({ repo: issue.repo, issue_id: issue.id } as Task), new Date(), { issueBody: false }));
}
