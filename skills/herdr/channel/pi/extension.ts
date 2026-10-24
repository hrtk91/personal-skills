import { append, follow, hasFinished, hasStopped, lastId, logPath, type Row } from "../engine/channel.ts";

const finishDescription = "頼まれた仕事が全部終わったときに、最後に 1 回だけ呼ぶ。summary に何をしたかを短く、facts に確かめた事実（claim: 何が正しいか、how: どう確かめたか）を書く。確かめていないことは facts に入れない。呼んでも受け入れが決まるわけではなく、レビューが続く。";
const postDescription = "途中の知らせを送る。詰まった理由、大きな方針の変更、時間がかかっている作業など、監督に知っておいてほしいときに使う。返事は待たずに仕事を続ける。";

export function createChannelExtension(config: { log: string; name: string; supervisor?: string }) {
  return function channelExtension(pi: any): void {
  const { log, name, supervisor = "claude" } = config;
  let cursor: string | undefined;
  let workStart: string | null = null;
  let workActive = false;
  let stopFollowing: (() => void) | undefined;
  const requireName = (): string => {
    if (!name) throw new Error("AGENT_CHANNEL_NAME が無いので使えない");
    return name;
  };
  const result = (row: Row) => ({ content: [{ type: "text", text: JSON.stringify({ id: row.id }) }], details: row });
  const failed = (error: unknown) => ({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });

  pi.registerTool({
    name: "channel_finish", label: "Channel finish", description: finishDescription,
    parameters: {
      type: "object", required: ["summary", "facts"], additionalProperties: false,
      properties: {
        summary: { type: "string" },
        facts: { type: "array", minItems: 1, items: { type: "object", required: ["claim", "how"], additionalProperties: false, properties: { claim: { type: "string" }, how: { type: "string" } } } },
        refs: { type: "array", items: { type: "string" } },
      },
    },
    async execute(_id: string, params: { summary: string; facts: { claim: string; how: string }[]; refs?: string[] }) {
      try { return result(append(log, { kind: "finish", from: requireName(), to: supervisor, body: params.summary, facts: params.facts, refs: params.refs })); }
      catch (error) { return failed(error); }
    },
  });
  pi.registerTool({
    name: "channel_post", label: "Channel post", description: postDescription,
    parameters: {
      type: "object", required: ["text"], additionalProperties: false,
      properties: { text: { type: "string" }, to: { type: "string" }, refs: { type: "array", items: { type: "string" } } },
    },
    async execute(_id: string, params: { text: string; to?: string; refs?: string[] }) {
      try { return result(append(log, { kind: "post", from: requireName(), to: params.to ?? supervisor, body: params.text, refs: params.refs })); }
      catch (error) { return failed(error); }
    },
  });

  pi.on("session_start", () => {
    if (!name) return;
    cursor = lastId(log) ?? undefined;
    stopFollowing?.();
    stopFollowing = follow(log, { to: name }, (row) => {
      if (row.from === name) return;
      void pi.sendMessage({ customType: "agent-channel", content: `【連絡チャンネル】${row.from} から（${row.kind}）:\n${row.body}`, display: true, details: row }, { triggerTurn: true, deliverAs: "followUp" });
    }, { after: cursor });
  });
  pi.on("session_shutdown", () => { stopFollowing?.(); stopFollowing = undefined; });
  pi.on("before_agent_start", (event: { messageType: string }) => {
    if (event.messageType === "user") { workStart = lastId(log); workActive = true; }
  });
  pi.on("agent_settled", (event: { aborted: boolean }) => {
    if (!name || !workActive || hasFinished(log, name, workStart) || hasStopped(log, name, workStart)) return;
    append(log, { kind: "stopped", from: name, to: supervisor, body: "finish を呼ばずに止まりました", fields: { aborted: event.aborted, started_after: workStart } });
    workActive = false;
  });
  };
}

export default function channelExtension(pi: any): void {
  createChannelExtension({ log: logPath(), name: process.env.AGENT_CHANNEL_NAME ?? "", supervisor: process.env.AGENT_CHANNEL_SUPERVISOR ?? "claude" })(pi);
}
