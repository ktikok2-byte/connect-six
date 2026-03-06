import { chromium, devices } from 'playwright';
const iPhone = devices['iPhone 13'];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ ...iPhone });
const page = await ctx.newPage();

page.on('console', msg => {
  const t = msg.text();
  if (msg.type() === 'error' || t.includes('null') || t.includes('Match') || t.includes('pool') || t.includes('Firestore'))
    console.log('[console]', t.slice(0, 200));
});
page.on('pageerror', e => console.log('[pageerror]', e.message));

await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(3000);

// Auto-register
await page.locator('button').filter({ hasText: /빠른/ }).first().click();
await page.waitForTimeout(5000);

// Read credentials from page text
const bodyText = await page.textContent('body');
const idMatch = bodyText.match(/player_[a-f0-9]+/);
const pwMatch = bodyText.match(/아이디player_[a-f0-9]+비밀번호([a-f0-9]+)/);
const id = idMatch ? idMatch[0] : null;
const pw = pwMatch ? pwMatch[1] : null;
console.log('Credentials — id:', id, 'pw:', pw ? pw : 'not found');

if (!id || !pw) {
  // Maybe already logged in
  if (bodyText.includes('대결 시작')) {
    console.log('Already in lobby!');
  } else {
    console.log('Body:', bodyText.slice(0, 400));
  }
}

// Click "로그인하러 가기"
await page.locator('button').filter({ hasText: '로그인하러 가기' }).first().click();
await page.waitForTimeout(500);

// Fill login form
await page.fill('#id', id);
await page.fill('#pw', pw);

// Submit
await page.locator('form button').first().click();
console.log('Submitted login...');
await page.waitForTimeout(6000);

const afterLoginBody = await page.textContent('body');
console.log('After login body:', afterLoginBody.slice(0, 400));

const inLobby = afterLoginBody.includes('대결 시작');
console.log('In lobby:', inLobby);

if (inLobby) {
  console.log('\nClicking Ranked Match...');
  await page.locator('button').filter({ hasText: '대결 시작' }).first().click();

  // Monitor for 10 seconds
  for (let i = 1; i <= 10; i++) {
    await page.waitForTimeout(1000);
    const b = await page.textContent('body');
    const m = b.match(/(\d+)\s*초\s*경과|(\d+)s\s*elapsed/i);
    const secs = m ? parseInt(m[1] || m[2]) : null;
    const inMM = b.includes('경과') || b.includes('elapsed') || b.includes('검색') || b.includes('상대');
    const inGame = b.includes('흑') || b.includes('백') || b.includes('돌을');
    console.log(`[${i}s] timer=${secs !== null ? secs + 's' : 'N/A'} | inMatchmaking=${inMM} | inGame=${inGame}`);
    if (inGame) { console.log('GAME STARTED!'); break; }
  }

  await page.screenshot({ path: '/tmp/debug_final.png' });
}

await browser.close();
