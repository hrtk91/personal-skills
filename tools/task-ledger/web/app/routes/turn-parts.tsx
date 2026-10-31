// The two parts of あなたの番 that teach Claude your values: principle proposals to accept or turn down, and the
// decisions Claude made by a principle, each with a way to say it was wrong.
import { useState } from "react";
import s from "./pages.module.css";

export interface Candidate { id: number; target: string; text: string; quote: string; quoteAt: string | null }
export interface ClaudeDecision { taskId: string; taskTitle: string; at: string; text: string; principle: string | null; principleTitle: string | null }

type Submit = (form: Record<string, string>) => void;

const targetName = (target: string) => target === "共通" ? "共通" : target.split("/").filter(Boolean).at(-1) ?? target;

export function Candidates({ items, submit, busy }: { items: Candidate[]; submit: Submit; busy: boolean }) {
  return (
    <section className={s.part}>
      <h2>原則の案 <span className={s.n}>{items.length}</span></h2>
      {items.length ? items.map((item) => <CandidateCard key={item.id} item={item} submit={submit} busy={busy} />)
        : <p className={s.empty}>新しい案はありません。</p>}
    </section>
  );
}

function CandidateCard({ item, submit, busy }: { item: Candidate; submit: Submit; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const send = (action: string, finalText?: string) => submit({ intent: "principle", candidateId: String(item.id), action, ...(finalText ? { finalText } : {}) });
  return (
    <article className={s.card}>
      <p className={s.lead}>{item.text}</p>
      <p className={s.quote}>「{item.quote}」</p>
      <p className={s.metaText}>入れる先: {targetName(item.target)}</p>
      {editing ? (
        <div className={s.edit}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="直した原則の文" />
          <div className={s.buttons}>
            <button type="button" className={s.primary} disabled={busy || !text.trim()} onClick={() => send("直して入れる", text.trim())}>この文で入れる</button>
            <button type="button" disabled={busy} onClick={() => { setEditing(false); setText(item.text); }}>やめる</button>
          </div>
        </div>
      ) : (
        <div className={s.buttons}>
          <button type="button" className={s.primary} disabled={busy} onClick={() => send("入れる")}>入れる</button>
          <button type="button" disabled={busy} onClick={() => setEditing(true)}>直して入れる</button>
          <button type="button" disabled={busy} onClick={() => send("入れない")}>入れない</button>
        </div>
      )}
    </article>
  );
}

export function ClaudeDecisions({ items, submit, busy }: { items: ClaudeDecision[]; submit: Submit; busy: boolean }) {
  const today = new Date().toLocaleDateString("sv-SE");
  const count = items.filter((d) => new Date(d.at).toLocaleDateString("sv-SE") === today).length;
  return (
    <section className={s.part}>
      <h2>Claude が決めたことの確かめ <span className={s.n}>今日 {count}</span></h2>
      {items.length ? <div className={s.list}>{items.map((item) => <DecisionRow key={`${item.taskId}:${item.at}`} item={item} submit={submit} busy={busy} />)}</div>
        : <p className={s.empty}>この 7 日、Claude が原則で決めたことはありません。</p>}
    </section>
  );
}

function DecisionRow({ item, submit, busy }: { item: ClaudeDecision; submit: Submit; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  return (
    <div className={s.decision}>
      <div className={s.decisionMain}>
        <span className={s.decisionText}>{item.taskTitle}: {item.text}</span>
        <span className={s.principle}>{item.principleTitle ?? item.principle ?? "原則なし"}</span>
      </div>
      {open ? (
        <div className={s.edit}>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} aria-label="どこが違うか" placeholder="どこが違うか" />
          <div className={s.buttons}>
            <button type="button" className={s.primary} disabled={busy || !note.trim()} onClick={() => submit({ intent: "feedback", taskId: item.taskId, answerAt: item.at, note: note.trim() })}>送る</button>
            <button type="button" disabled={busy} onClick={() => setOpen(false)}>やめる</button>
          </div>
        </div>
      ) : <button type="button" className={s.wrong} disabled={busy} onClick={() => setOpen(true)}>違う</button>}
    </div>
  );
}
