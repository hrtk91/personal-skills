import { ISSUE_FIELDS, type Issue, type IssueField, type IssueFields } from './ledger.ts';

export const TEMPLATE = `# 題（何をするか。1 行）\n\n<!-- この Issue がそのまま作業役への依頼文になる。作業役は会話を知らないので、文脈を書き切る。 -->\n\n## なぜ\nユーザーの言葉と日付。何に困っているか。\n\n## 今の状態（必須）\n確かめた事実と、確かめ方を書く。\n\n## 関係する所（必須）\n触るファイル・呼び出し関係・既存部品・検査を書く。\n\n## やること\n番号を付けて書く。\n\n## やってよいこと\n許可を書く。\n\n## やらないこと\n禁止事項を書く。\n\n## 終わりの条件\n受け入れ条件を書く。\n\n## 確かめのコマンド\n実行するコマンド。\n\n## 触るファイル\nパスを列挙する。\n\n## 種類\n処理・見た目・調べ。\n\n## 本番に出すか\nはい／いいえ。`;

export function parseIssueMarkdown(markdown: string): { title: string; fields: IssueFields } {
  const clean = markdown.replace(/<!--[\s\S]*?-->/g, '');
  const title = clean.match(/^# (.*)$/m)?.[1]?.trim() ?? '';
  const fields: IssueFields = {};
  const headings = [...clean.matchAll(/^## (.+?)\s*$/gm)];
  for (let i = 0; i < headings.length; i++) {
    const rawHeading = headings[i]![1]!.trim();
    const requiredMarker = rawHeading.endsWith('（必須）');
    const heading = rawHeading.replace(/（必須）$/, '');
    if (!(ISSUE_FIELDS as readonly string[]).includes(heading)) continue;
    // The old dashboard brief has narrative sections with these names; only the explicitly required template headings fill the required fields.
    if ((heading === '今の状態' || heading === '関係する所') && !requiredMarker) continue;
    const start = headings[i]!.index! + headings[i]![0].length;
    const end = headings[i + 1]?.index ?? clean.length;
    fields[heading as IssueField] = clean.slice(start, end).trim();
  }
  return { title, fields };
}

export function meaningful(value: string | undefined): boolean {
  const text = (value ?? '').trim();
  if (!text) return false;
  return !/^(?:（[^\n]*）|\[[^\n]*\]|…+|\.\.\.)$/.test(text) && !/^(?:確かめた事実だけを書く|番号を付けて|仕事に要る許可を先に書く|本当に起きうるものだけ|実際に使われる所での確かめ|触るファイルと、それを呼ぶ所|同じ役目の既存の部品|関係する検査|前の仕事・報告・差し戻しの理由)/.test(text);
}

export function renderIssueBrief(issue: Issue, context = ''): string {
  const sections = ISSUE_FIELDS.map((field) => `## ${field}\n${issue.fields[field] ?? ''}`).join('\n\n');
  const history = issue.history.length ? `\n\n${issue.history.join('\n\n')}` : '';
  return `# ${issue.title}\n\n${sections}${history}${context ? `\n\n${context.trimEnd()}` : ''}\n`;
}
