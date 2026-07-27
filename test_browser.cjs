const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.toString()));
  // Login first
  await page.goto('http://localhost:3000/login');
  await page.type('input[name="email"]', 'al.matubis17@gmail.com');
  await page.type('input[name="password"]', 'password');
  await Promise.all([
    page.click('button[type="submit"]'),
    page.waitForNavigation()
  ]);
  // Wait a bit to ensure JS runs
  await new Promise(r => setTimeout(r, 2000));
  await browser.close();
})();
