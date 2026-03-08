/**
 * Mobile matchmaking test — iPhone 13 emulation, two players.
 */
import { chromium, devices } from 'playwright';

const BASE_URL = process.env.TEST_URL || 'http://localhost:5173';
const iPhone = devices['iPhone 13'];

async function setupPlayer(browser, label) {
  const ctx = await browser.newContext({ ...iPhone, locale: 'ko-KR' });
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', msg => {
    const t = msg.text();
    if (msg.type() === 'error') errors.push(t);
    if (t.includes('null') || t.includes('pool') || t.includes('Firestore') || t.includes('Match'))
      console.log(`  [${label} log] ${t.slice(0, 150)}`);
  });
  page.on('pageerror', e => errors.push('PAGE: ' + e.message));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);

  // Click guest mode button (previously "빠른 계정 생성", now "게스트로 시작")
  await page.locator('button').filter({ hasText: /게스트|빠른|Guest/ }).first().click();
  // Guest mode goes directly to lobby via onAuthStateChanged
  await page.waitForTimeout(7000);

  const bodyText = await page.textContent('body');
  const success = bodyText.includes('대결 시작');
  console.log(`[${label}] Guest login ${success ? '✅ in lobby' : '❌ failed'}`);
  return { page, ctx, errors, success };
}

async function main() {
  console.log('=== Mobile Matchmaking Test (iPhone 13 emulation) ===\n');

  const browser = await chromium.launch({ headless: true });

  console.log('--- Setting up Player 1 ---');
  const p1 = await setupPlayer(browser, 'P1');

  console.log('\n--- Setting up Player 2 ---');
  const p2 = await setupPlayer(browser, 'P2');

  if (!p1.success || !p2.success) {
    console.log('\n❌ Failed to get both players to lobby');
    await browser.close();
    process.exit(1);
  }

  console.log('\n✅ Both in lobby. Starting matchmaking...\n');

  await p1.page.locator('button').filter({ hasText: '대결 시작' }).first().click();
  await p1.page.waitForTimeout(600);
  await p2.page.locator('button').filter({ hasText: '대결 시작' }).first().click();
  console.log('Both clicked Ranked Match.\n');

  // Monitor timer on P1
  const readings = [];
  let gameAt = null;

  for (let i = 1; i <= 20; i++) {
    await p1.page.waitForTimeout(1000);
    const b = await p1.page.textContent('body');
    const m = b.match(/(\d+)\s*초\s*경과|(\d+)s\s*elapsed/i);
    const secs = m ? parseInt(m[1] || m[2]) : null;
    readings.push(secs);

    const inGame = b.includes('흑') || b.includes('백') || b.includes('돌을') || b.includes('Turn') || b.includes('차례');
    console.log(`[${i}s] timer=${secs !== null ? secs + 's' : 'N/A'} | inGame=${inGame}`);

    if (inGame) { gameAt = i; break; }
  }

  const valid = readings.filter(x => x !== null);
  const timerCounting = valid.length >= 2 && Math.max(...valid) > Math.min(...valid);
  const matchFound = gameAt !== null;

  await p1.page.screenshot({ path: '/tmp/p1_final.png' });
  await p2.page.screenshot({ path: '/tmp/p2_final.png' });

  const allErrors = [...p1.errors, ...p2.errors];
  console.log('\n=== Console Errors ===');
  if (allErrors.length === 0) console.log('None ✅');
  else allErrors.forEach(e => console.log('  ❌', e.slice(0, 200)));

  console.log('\n=== RESULT ===');
  console.log(`Both reached lobby: ✅`);
  // If match found quickly (< 3s), timer may not have multiple readings — that's fine
  const timerOk = timerCounting || (matchFound && gameAt <= 3);
  console.log(`Timer counting:     ${timerOk ? '✅ (matched too fast to measure)' : '❌ NO — [' + readings.join(',') + ']'}`);
  console.log(`Match found:        ${matchFound ? '✅ YES (at ~' + gameAt + 's)' : '❌ NO (timed out)'}`);

  await browser.close();
  if (!timerOk || !matchFound) process.exit(1);
}

main().catch(e => { console.error('Crashed:', e); process.exit(1); });
