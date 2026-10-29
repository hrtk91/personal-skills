// The consultation sidebar (Claude's part). Data and intents: ./types.ts. The route places it to the right of
// the Goal tab on a wide screen and full screen on a phone; this file only draws what it is given.
import { useEffect, useRef, useState } from "react";
import type { ConsultData, ConsultIntent, ConsultMessage, ConsultPartner } from "./types.js";
import styles from "./view.module.css";

const DECIDE_TO: { to: "待ち" | "保留" | "やめ"; label: string }[] = [
  { to: "待ち", label: "この答えで続けさせる" },
  { to: "保留", label: "保留" },
  { to: "やめ", label: "やめる" },
];

export function ConsultPanel({ data, submit, busy, closeHref, partnerHref }: {
  data: ConsultData;
  submit: (intent: ConsultIntent) => void;
  busy?: boolean;
  /** Where 「閉じる」 goes (the Goal tab). Omitted: no close link. */
  closeHref?: string;
  /** The same sidebar talking with the other partner. Omitted: the partner chips are labels only. */
  partnerHref?: (kind: ConsultPartner["kind"]) => string;
}) {
  const [text, setText] = useState("");
  const [model, setModel] = useState(data.model);
  const [answer, setAnswer] = useState("");
  const log = useRef<HTMLOListElement>(null);
  const partner = data.partners.find((p) => p.kind === data.partner);
  const writing = data.messages.some((m) => m.pending);
  const lastReply = [...data.messages].reverse().find((m) => m.role === "partner" && !m.pending);

  useEffect(() => { log.current?.lastElementChild?.scrollIntoView({ block: "end" }); }, [data.messages.length, data.messages.at(-1)?.text]);

  const send = (kind: ConsultPartner["kind"]) => {
    const body = text.trim();
    if (!body) return;
    submit({ intent: "consult-send", taskId: data.taskId, partner: kind, model, text: body });
    setText("");
  };

  return (
    <aside className={styles.panel} aria-label="相談">
      <header className={styles.head}>
        <div className={styles.headRow}>
          <b className={styles.title}>相談</b>
          {closeHref ? <a className={styles.close} href={closeHref}>閉じる</a> : null}
        </div>
        <p className={styles.task}>{data.taskTitle}</p>
        <p className={styles.question}>{data.question}</p>
      </header>

      <div className={styles.who}>
        <div className={styles.chips} role="group" aria-label="相手">
          {data.partners.map((p) => {
            const cls = p.kind === data.partner ? `${styles.chip} ${styles.on}` : styles.chip;
            if (!p.sessionId) return <span key={p.kind} className={`${cls} ${styles.off}`} title="会話の記録が残っていないので、続きから話せません">{p.label}</span>;
            return partnerHref && p.kind !== data.partner
              ? <a key={p.kind} className={cls} href={partnerHref(p.kind)}>{p.label}</a>
              : <span key={p.kind} className={cls} aria-current={p.kind === data.partner ? "true" : undefined}>{p.label}</span>;
          })}
        </div>
        <label className={styles.model}>
          <span>モデル</span>
          <select value={model} onChange={(event) => setModel(event.currentTarget.value)} disabled={busy}>
            {data.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      </div>

      <ol className={styles.log} ref={log}>
        {data.messages.length ? data.messages.map((m) => <Message key={m.id} message={m} partner={partner?.label ?? "相手"} onUse={setAnswer} />)
          : <li className={styles.empty}>{partner?.sessionId
            ? `${partner.label}は、この仕事で判断待ちを書いたときの会話を覚えています。気になる所を聞いてください。`
            : "この仕事では会話の記録が残っていないので、続きから話せる相手がいません。"}</li>}
      </ol>

      <form className={styles.compose} onSubmit={(event) => { event.preventDefault(); send(data.partner); }}>
        <textarea className={styles.input} value={text} onChange={(event) => setText(event.currentTarget.value)}
          placeholder={partner?.sessionId ? `${partner.label}に聞く` : "話せる相手がいません"} aria-label="相談の文"
          disabled={!partner?.sessionId}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(data.partner); } }} />
        <button type="submit" className={`${styles.b} ${styles.pri}`} disabled={busy || writing || !text.trim() || !partner?.sessionId}>
          {writing ? "返事を書いています" : "送る"}
        </button>
      </form>

      <form className={styles.decide} onSubmit={(event) => event.preventDefault()}>
        <b className={styles.decideTitle}>決める</b>
        <textarea className={styles.input} value={answer} onChange={(event) => setAnswer(event.currentTarget.value)}
          placeholder={lastReply ? "返事の「これを答えにする」で写すか、ここに書く" : "台帳に返す答え"} aria-label="答え" />
        <div className={styles.btns}>
          {DECIDE_TO.map((item, index) => (
            <button key={item.to} type="button" className={index === 0 ? `${styles.b} ${styles.pri}` : styles.b}
              disabled={busy || (item.to === "待ち" && !answer.trim())}
              onClick={() => submit({ intent: "consult-decide", taskId: data.taskId, text: answer.trim() || item.label, to: item.to })}>
              {item.label}
            </button>
          ))}
        </div>
      </form>
    </aside>
  );
}

function Message({ message, partner, onUse }: { message: ConsultMessage; partner: string; onUse: (text: string) => void }) {
  const mine = message.role === "you";
  return (
    <li className={mine ? `${styles.msg} ${styles.mine}` : styles.msg}>
      <span className={styles.from}>{mine ? "あなた" : partner}{message.pending ? "（書いています）" : ""}</span>
      <div className={styles.bubble}>{message.text || "…"}</div>
      {!mine && !message.pending ? <button type="button" className={styles.use} onClick={() => onUse(message.text)}>これを答えにする</button> : null}
    </li>
  );
}
