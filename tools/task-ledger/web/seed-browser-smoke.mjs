import { Ledger } from '../ledger.ts';
const ledger=new Ledger(process.env.TASK_LEDGER_DB);
const repo='/tmp/browser-check';
const task=ledger.add({repo,title:'Need user decision',why:'browser smoke test',brief:'test'});
ledger.setStatus(task.id,'判断待ち','Approval required for browser test');
ledger.close();
