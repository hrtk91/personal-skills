import { chromium } from '@playwright/test';
import { Ledger } from '../ledger.ts';
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
try {
 const page=await browser.newPage(); page.on('pageerror',e=>console.error('pageerror',e.message)); page.on('console',m=>{if(m.type()==='error')console.error('console',m.text())}); await page.goto('http://127.0.0.1:8790/p/browser-check'); await page.waitForTimeout(1000);
 if(!await page.getByText('Need user decision').count()) throw new Error('decision title missing');
 if(!await page.getByText('Approval required for browser test').count()) throw new Error('decision question missing');
 await page.locator('input[aria-label="ひとこと"]').fill('Proceed'); const response=page.waitForResponse(r=>r.request().method()==='POST'); await page.getByRole('button',{name:'続けさせる'}).click(); const posted=await response; console.log('action HTTP',posted.status()); const check=new Ledger(process.env.TASK_LEDGER_DB); const status=check.list({repo:'/tmp/browser-check',all:true})[0]?.status; check.close();
 if(status!=='待ち') throw new Error('answer did not update the ledger');
 console.log('Playwright PASS: project opened, decision rendered, answer updated temporary ledger');
} finally {await browser.close();}
