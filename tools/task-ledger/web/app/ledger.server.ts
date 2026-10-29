import { Ledger } from "../../ledger.ts";
let ledger:Ledger|undefined;
export function getLedger(){ return ledger ??= new Ledger(); }
export function lastHarnessTime(){ const l=getLedger(); const all=l.list({all:true}); const times=all.flatMap(t=>l.events(t.id)).map(e=>e.at).sort(); return times.at(-1); }
