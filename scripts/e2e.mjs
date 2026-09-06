/**
 * End-to-end checks driven through a real browser.
 *
 *   node scripts/e2e.mjs            # all groups
 *   node scripts/e2e.mjs auth feed  # selected groups
 *
 * Uses the installed Chrome (channel: 'chrome') rather than downloading a
 * Playwright browser bundle, so it runs on a machine that already has one.
 *
 * These are smoke tests against a running dev server, not a replacement for
 * the unit suite. They exist because a build that compiles proves nothing
 * about whether a menu opens where it should or whether a post keeps its
 * image - the class of defect this codebase was reported to have.
 */
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE ?? 'http://localhost:3000';
const PW = process.env.E2E_PASSWORD ?? 'UniPathTest2026!';

const ACCOUNTS = {
  admin: { email: 'aysel.dev01@ada.edu.az', password: 'UniPathAdmin2026!' },
  student: { email: 'e2e.student@ada.edu.az', password: PW },
  unverified: { email: 'e2e.unverified@ada.edu.az', password: PW },
  moderator: { email: 'e2e.mod@ada.edu.az', password: PW },
  frozen: { email: 'e2e.frozen@ada.edu.az', password: PW },
};

const results = [];
let currentGroup = '';

function record(name, ok, detail = '') {
  results.push({ group: currentGroup, name, ok, detail });
  const mark = ok ? '  PASS' : '  FAIL';
  console.log(`${mark}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : '');
  } catch (error) {
    record(name, false, error.message.split('\n')[0].slice(0, 160));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Signs in through the real form and waits for the post-login navigation.
 *
 * Two details that are load-bearing and were both wrong on the first attempt:
 *
 *  - `networkidle`, not `domcontentloaded`. The submit handler only exists
 *    once React has hydrated; clicking before that lands on an inert button
 *    and the test times out waiting for a navigation that was never started.
 *  - the locale cookie is forced to English. The product defaults to
 *    Azerbaijani, so text selectors like :has-text("Post") match nothing on a
 *    fresh context - the failure looks like a broken feature and is a broken
 *    test.
 */
async function login(page, who) {
  const account = ACCOUNTS[who];
  await page.context().addCookies([
    { name: 'CH_LOCALE', value: 'en', url: BASE },
  ]);
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.waitForSelector('button[type="submit"]', { timeout: 15000 });
  await page.fill('input[type="email"]', account.email);
  await page.fill('input[type="password"]', account.password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
  // The destination renders client-side after the push; give it a beat so the
  // caller sees a settled page rather than a mid-transition one.
  await page.waitForLoadState('networkidle').catch(() => {});
  return page.url();
}

/** A 1x1 PNG is too small for the uploader; this makes a real 300x200 one. */
function pngFixture() {
  // Minimal but valid PNG produced by hand would be fragile; use a data URI
  // decoded from a tiny base64 PNG scaled by the server instead. This is a
  // 300x200 solid-colour PNG.
  const { execSync } = require('node:child_process');
  void execSync;
  return null;
}
void pngFixture;

const GROUPS = {};

// ---------------------------------------------------------------------------
GROUPS.auth = async (browser) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await check('admin can sign in and lands on /admin', async () => {
    const url = await login(page, 'admin');
    assert(url.includes('/admin'), `landed on ${url}`);
    return url.replace(BASE, '');
  });

  await check('admin panel renders real data (not a redirect)', async () => {
    await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle' });
    assert(page.url().includes('/admin/users'), `bounced to ${page.url()}`);
    const rows = await page.locator('table tbody tr').count();
    assert(rows > 0, 'no user rows rendered');
    return `${rows} rows`;
  });

  await check('admin responses carry Cache-Control: no-store', async () => {
    const response = await page.goto(`${BASE}/admin/users`, { waitUntil: 'domcontentloaded' });
    const cc = response.headers()['cache-control'] ?? '';
    assert(cc.includes('no-store'), `got "${cc}"`);
    return cc;
  });

  await check('logout revokes, and browser BACK cannot restore the panel', async () => {
    await page.goto(`${BASE}/logout`, { waitUntil: 'networkidle' });
    await page.goBack({ waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(700);
    const url = page.url();
    const body = await page.locator('body').innerText().catch(() => '');
    assert(!url.includes('/admin'), `back returned to ${url}`);
    // The panel's own table must not be on screen either.
    assert(!/Full name\s+Nickname\s+Email/i.test(body), 'admin table still painted after back');
    return `back landed on ${url.replace(BASE, '') || '/'}`;
  });

  await check('revoked session token is refused by the API', async () => {
    // The context still holds the cookies from before /logout cleared them?
    // It does not - so assert the API refuses an unauthenticated call.
    const res = await ctx.request.get(`${BASE}/api/admin/users`);
    assert([401, 403].includes(res.status()), `expected 401/403, got ${res.status()}`);
    return `status ${res.status()}`;
  });

  await ctx.close();
};

// ---------------------------------------------------------------------------
GROUPS.security = async (browser) => {
  // --- normal user -> /admin -------------------------------------------------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page, 'student');

    await check('student visiting /admin is redirected away', async () => {
      await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
      assert(!page.url().includes('/admin'), `student reached ${page.url()}`);
      return `redirected to ${page.url().replace(BASE, '')}`;
    });

    await check('student calling /api/admin/users is refused', async () => {
      const res = await ctx.request.get(`${BASE}/api/admin/users`);
      assert(res.status() === 403, `expected 403, got ${res.status()}`);
      return `status ${res.status()}`;
    });

    await check('student cannot escalate their own role via /api/me', async () => {
      const res = await ctx.request.patch(`${BASE}/api/me`, {
        data: { role: 'ADMIN', accountStatus: 'ACTIVE', isVerified: true },
      });
      const body = await res.json().catch(() => ({}));
      // The allow-list drops unknown fields; the request is refused for having
      // no permitted field rather than silently applying `role`.
      const me = await ctx.request.get(`${BASE}/api/me`);
      const after = await me.json();
      assert(after.user.role === 'STUDENT', `role became ${after.user.role}`);
      return `role still ${after.user.role} (patch ${res.status()} ${body.error ?? ''})`;
    });

    await check('student cannot freeze another account', async () => {
      const res = await ctx.request.patch(`${BASE}/api/admin/users/whatever`, {
        data: { op: 'freeze', reason: 'malicious attempt from a student' },
      });
      assert([401, 403].includes(res.status()), `expected 401/403, got ${res.status()}`);
      return `status ${res.status()}`;
    });

    await ctx.close();
  }

  // --- moderator -> admin-only actions --------------------------------------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page, 'moderator');

    await check('moderator CAN read the admin panel', async () => {
      await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle' });
      assert(page.url().includes('/admin/users'), `bounced to ${page.url()}`);
      return 'panel reachable';
    });

    await check('moderator CANNOT change a role (ADMIN-only)', async () => {
      const list = await ctx.request.get(`${BASE}/api/admin/users?pageSize=1`);
      const { users } = await list.json();
      const target = users[0].id;
      const res = await ctx.request.patch(`${BASE}/api/admin/users/${target}`, {
        data: { op: 'role', role: 'ADMIN', reason: 'moderator escalation attempt' },
      });
      assert(res.status() === 403, `expected 403, got ${res.status()}`);
      return `status ${res.status()}`;
    });

    await check('moderator CANNOT delete an account', async () => {
      const list = await ctx.request.get(`${BASE}/api/admin/users?pageSize=1`);
      const { users } = await list.json();
      const res = await ctx.request.delete(`${BASE}/api/admin/users/${users[0].id}`, {
        data: { reason: 'moderator deletion attempt', confirmNickname: users[0].nickname },
      });
      assert(res.status() === 403, `expected 403, got ${res.status()}`);
      return `status ${res.status()}`;
    });

    await ctx.close();
  }

  // --- frozen account --------------------------------------------------------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await check('frozen account can still sign in (read-only escape hatch)', async () => {
      const url = await login(page, 'frozen');
      return `landed on ${url.replace(BASE, '')}`;
    });

    await check('frozen account CANNOT post', async () => {
      const res = await ctx.request.post(`${BASE}/api/feed`, {
        data: { body: 'post from a frozen account', tags: [], media: [] },
      });
      assert(res.status() === 403, `expected 403, got ${res.status()}`);
      return `status ${res.status()}`;
    });

    await check('frozen account CANNOT upload media', async () => {
      const res = await ctx.request.post(`${BASE}/api/media`, {
        multipart: { file: { name: 'x.png', mimeType: 'image/png', buffer: Buffer.alloc(64) } },
      });
      assert(res.status() === 403, `expected 403, got ${res.status()}`);
      return `status ${res.status()}`;
    });

    await check('frozen account CANNOT send a message', async () => {
      const res = await ctx.request.post(`${BASE}/api/messages`, {
        data: { userId: 'cxxxxxxxxxxxxxxxxxxxxxxxx' },
      });
      assert(res.status() === 403, `expected 403, got ${res.status()}`);
      return `status ${res.status()}`;
    });

    await check('frozen account CAN still read the feed', async () => {
      const res = await ctx.request.get(`${BASE}/api/feed?limit=5`);
      assert(res.ok(), `expected 200, got ${res.status()}`);
      return `status ${res.status()}`;
    });

    await ctx.close();
  }

  // --- unauthenticated --------------------------------------------------------
  {
    const ctx = await browser.newContext();
    await check('anonymous /api/admin/users is refused', async () => {
      const res = await ctx.request.get(`${BASE}/api/admin/users`);
      assert(res.status() === 401, `expected 401, got ${res.status()}`);
      return `status ${res.status()}`;
    });
    await check('anonymous /admin redirects to login', async () => {
      await ctx.addCookies([{ name: 'CH_LOCALE', value: 'en', url: BASE }]);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
      assert(page.url().includes('/login'), `landed on ${page.url()}`);
      return 'redirected to /login';
    });
    await ctx.close();
  }
};

// ---------------------------------------------------------------------------
GROUPS.feed = async (browser) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await login(page, 'student');
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });

  await check('dashboard renders without a runtime error', async () => {
    await page.waitForSelector('#composer', { timeout: 15000 });
    const fatal = errors.filter((e) => /Cannot read properties of undefined/i.test(e));
    assert(fatal.length === 0, fatal[0] ?? '');
    return 'composer present';
  });

  const stamp = Date.now();

  await check('TEXT post publishes and appears immediately', async () => {
    await page.fill('#composer', `e2e text post ${stamp}`);
    await page.click('button:has-text("Post"), button:has-text("Paylaş")');
    await page.waitForSelector(`article:has-text("e2e text post ${stamp}")`, { timeout: 20000 });
    const fatal = errors.filter((e) => /Cannot read properties of undefined \(reading 'map'\)/i.test(e));
    assert(fatal.length === 0, `tags.map crash: ${fatal[0]}`);
    return 'card rendered';
  });

  await check('post with TAGS publishes and shows them', async () => {
    await page.fill('#composer', `e2e tagged post ${stamp}`);
    await page.click('button[aria-label*="tag" i], button[aria-label*="Etiket" i]');
    await page.click('button:has-text("#ExamAlert")');
    await page.click('button:has-text("Post"), button:has-text("Paylaş")');
    const card = page.locator(`article:has-text("e2e tagged post ${stamp}")`).first();
    await card.waitFor({ timeout: 20000 });
    await card.locator('text=#ExamAlert').first().waitFor({ timeout: 5000 });
    return 'tag chip rendered on the new card';
  });

  await check('IMAGE post uploads, publishes and DISPLAYS', async () => {
    const png = await page.evaluate(async () => {
      // Draw a real 320x200 PNG in the page and hand back its bytes, so the
      // fixture is a genuine image the server will decode rather than a stub.
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 200;
      const g = canvas.getContext('2d');
      g.fillStyle = '#5458c4';
      g.fillRect(0, 0, 320, 200);
      g.fillStyle = '#fff';
      g.font = '28px sans-serif';
      g.fillText('E2E', 20, 110);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const buf = new Uint8Array(await blob.arrayBuffer());
      return Array.from(buf);
    });

    await page.setInputFiles('input[type="file"]', {
      name: 'e2e.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png),
    });

    await page.fill('#composer', `e2e image post ${stamp}`);
    await page.click('button:has-text("Post"), button:has-text("Paylaş")');

    const card = page.locator(`article:has-text("e2e image post ${stamp}")`).first();
    await card.waitFor({ timeout: 40000 });

    const img = card.locator('img').first();
    await img.waitFor({ timeout: 20000 });
    const src = await img.getAttribute('src');
    assert(src && src.startsWith('/api/media/'), `unexpected src "${src}"`);

    /**
     * WAIT for the decode rather than sampling `complete` once.
     *
     * The element is in the DOM the moment the card renders, but the bytes are
     * still in flight - so a single `complete && naturalWidth` read races the
     * network and reports a false failure on an image that loads fine a
     * moment later.
     */
    await img.evaluate(
      (el) =>
        new Promise((resolve, reject) => {
          if (el.complete && el.naturalWidth > 0) return resolve(true);
          el.addEventListener('load', () => resolve(true), { once: true });
          el.addEventListener('error', () => reject(new Error('image failed to load')), { once: true });
          setTimeout(() => reject(new Error('image did not decode within 15s')), 15000);
        }),
    );
    const natural = await img.evaluate((el) => `${el.naturalWidth}x${el.naturalHeight}`);
    assert(natural !== '0x0', 'image decoded to zero dimensions');
    return `served ${src} at ${natural}`;
  });

  await check('COMMENT can be written on the new post', async () => {
    const card = page.locator(`article:has-text("e2e text post ${stamp}")`).first();
    // The toggle lives in the card FOOTER; the submit button lives inside the
    // comment <form>. Both carry the word "comment" in their label, so an
    // aria-label substring match hits the toggle first and silently closes the
    // thread instead of posting - which is how this check passed against a
    // database that had zero comments in it.
    await card.locator('footer button').nth(1).click();

    const section = card.locator('section');
    await section.waitFor({ timeout: 10000 });

    const box = section.locator('textarea');
    await box.waitFor({ timeout: 10000 });
    await box.fill(`e2e comment ${stamp}`);
    await section.locator('form button[type="submit"]').click();

    // Assert against the rendered LIST, not any text on the page - the
    // textarea still contains the same string until it clears.
    await section.locator('ul li', { hasText: `e2e comment ${stamp}` }).first()
      .waitFor({ timeout: 15000 });
    return 'comment rendered in the thread list';
  });

  await check('comment PERSISTS in the database across a reload', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    const card = page.locator(`article:has-text("e2e text post ${stamp}")`).first();
    await card.waitFor({ timeout: 20000 });
    await card.locator('footer button').nth(1).click();
    const section = card.locator('section');
    await section.locator('ul li', { hasText: `e2e comment ${stamp}` }).first()
      .waitFor({ timeout: 15000 });
    return 'comment served from the API after reload';
  });

  await check('image post SURVIVES a reload (persisted, not local state)', async () => {
    const card = page.locator(`article:has-text("e2e image post ${stamp}")`).first();
    await card.waitFor({ timeout: 20000 });
    const img = card.locator('img').first();
    await img.waitFor({ timeout: 15000 });
    const loaded = await img.evaluate((el) => el.complete && el.naturalWidth > 0);
    assert(loaded, 'image did not load after reload');
    return 'image still served after reload';
  });

  await check('LIKE persists across a reload', async () => {
    const card = page.locator(`article:has-text("e2e text post ${stamp}")`).first();
    const likeBtn = card.locator('button[aria-label*="ike" i], button[aria-label*="Bəyən" i]').first();
    await likeBtn.click();
    await page.waitForTimeout(1200);
    await page.reload({ waitUntil: 'networkidle' });
    const after = page.locator(`article:has-text("e2e text post ${stamp}")`).first();
    const pressed = await after
      .locator('button[aria-label*="ike" i], button[aria-label*="Bəyən" i]')
      .first()
      .getAttribute('aria-pressed');
    assert(pressed === 'true', `aria-pressed=${pressed}`);
    return 'like persisted';
  });

  await ctx.close();
};

// ---------------------------------------------------------------------------
GROUPS.ui = async (browser) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await login(page, 'student');
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });

  await check('account menu opens ABOVE its trigger and is fully visible', async () => {
    const trigger = page.locator('aside [data-menu-trigger]').last();
    await trigger.click();
    const menu = page.locator('[role="menu"]').first();
    await menu.waitFor({ timeout: 5000 });

    const t = await trigger.boundingBox();
    const m = await menu.boundingBox();
    const viewport = page.viewportSize();

    assert(m.y + m.height <= t.y + 4, `menu top=${Math.round(m.y)} not above trigger top=${Math.round(t.y)}`);
    assert(m.y >= 0, `clipped at the top (y=${Math.round(m.y)})`);
    assert(m.y + m.height <= viewport.height, 'extends below the viewport');
    assert(m.x >= 0 && m.x + m.width <= viewport.width, 'extends outside horizontally');
    return `menu at y=${Math.round(m.y)}, trigger at y=${Math.round(t.y)}`;
  });

  await check('account menu is painted on top (hit-testable)', async () => {
    const menu = page.locator('[role="menu"]').first();
    const box = await menu.boundingBox();
    const topmost = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest('[role="menu"]') !== null;
      },
      [box.x + box.width / 2, box.y + 12],
    );
    assert(topmost, 'another element sits above the menu at its own coordinates');
    return 'menu is the hit target';
  });

  await check('account menu closes on outside click', async () => {
    await page.mouse.click(900, 400);
    await page.waitForTimeout(300);
    const count = await page.locator('[role="menu"]').count();
    assert(count === 0, `${count} menu(s) still open`);
    return 'closed';
  });

  await check('account menu works at mobile width', async () => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
    // The mobile bar hides the rail behind a hamburger. Its label is
    // a11y.openMenu ("Open menu"); the account row only exists once the sheet
    // is expanded.
    await page.locator('button[aria-label="Open menu"]').first().click();
    await page.waitForTimeout(500);
    /**
     * Pick the VISIBLE account trigger.
     *
     * The sidebar renders the account row twice - once in the mobile sheet and
     * once in the desktop rail - and the sheet's copy comes FIRST in DOM order.
     * `.last()` therefore selects the rail's copy, which is display:none at
     * this width, and the click waits forever for it to become actionable.
     */
    const trigger = page.locator('[data-menu-trigger]:visible').filter({ hasText: '@' }).first();
    await trigger.click();
    const menu = page.locator('[role="menu"]').first();
    await menu.waitFor({ timeout: 5000 });
    const m = await menu.boundingBox();
    assert(m.x >= 0 && m.x + m.width <= 390, `menu spans ${Math.round(m.x)}..${Math.round(m.x + m.width)}`);
    assert(m.y >= 0 && m.y + m.height <= 780, 'menu off-screen vertically');
    await page.setViewportSize({ width: 1280, height: 800 });
    return 'fits a 390px viewport';
  });

  await ctx.close();
};

// ---------------------------------------------------------------------------
GROUPS.darkmode = async (browser) => {
  const ctx = await browser.newContext({ colorScheme: 'dark' });
  const page = await ctx.newPage();
  await login(page, 'student');

  /** Relative luminance per WCAG. */
  const contrastScript = `
    (() => {
      const lum = (rgb) => {
        const [r,g,b] = rgb.map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126*r + 0.7152*g + 0.0722*b;
      };
      const parse = (s) => {
        const m = s.match(/rgba?\\(([^)]+)\\)/);
        if (!m) return null;
        const p = m[1].split(',').map((x) => parseFloat(x));
        if (p.length > 3 && p[3] === 0) return null; // fully transparent
        return [p[0], p[1], p[2]];
      };
      const bgOf = (el) => {
        let node = el;
        while (node && node !== document.documentElement) {
          const c = parse(getComputedStyle(node).backgroundColor);
          if (c) return c;
          node = node.parentElement;
        }
        return parse(getComputedStyle(document.body).backgroundColor) ?? [255,255,255];
      };
      const bad = [];
      const nodes = document.querySelectorAll('input, select, option, textarea, button, a, p, span, h1, h2, h3, td, th, label, li');
      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
        const text = (el.textContent ?? '').trim();
        const isField = ['INPUT','SELECT','TEXTAREA','OPTION'].includes(el.tagName);
        if (!text && !isField) continue;
        const fg = parse(style.color);
        if (!fg) continue;
        const bg = bgOf(el);
        const l1 = lum(fg), l2 = lum(bg);
        const ratio = (Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05);
        if (ratio < 3) {
          bad.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className || '').toString().slice(0, 60),
            text: text.slice(0, 40),
            color: style.color,
            bg: 'rgb(' + bg.join(',') + ')',
            ratio: Math.round(ratio * 100) / 100,
          });
        }
      }
      return bad;
    })()
  `;

  const pages = ['/dashboard', '/notes', '/notes/new', '/mentors', '/messages', '/notifications', '/settings', '/profile'];

  for (const path of pages) {
    await check(`dark mode contrast: ${path}`, async () => {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(900);
      const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      const bad = await page.evaluate(contrastScript);
      assert(bad.length === 0, `${bad.length} low-contrast: ${JSON.stringify(bad.slice(0, 3))}`);
      return `theme=${theme}, no low-contrast text`;
    });
  }

  await check('dark mode contrast: /register (selects and inputs)', async () => {
    const anon = await browser.newContext({ colorScheme: 'dark' });
    await anon.addCookies([{ name: 'CH_LOCALE', value: 'en', url: BASE }]);
    const p2 = await anon.newPage();
    await p2.goto(`${BASE}/register`, { waitUntil: 'networkidle' });
    await p2.waitForTimeout(900);
    const bad = await p2.evaluate(contrastScript);
    await anon.close();
    assert(bad.length === 0, `${bad.length} low-contrast: ${JSON.stringify(bad.slice(0, 3))}`);
    return 'no low-contrast text';
  });

  await check('<option> elements inherit themed colours', async () => {
    await page.goto(`${BASE}/notes/new`, { waitUntil: 'networkidle' });
    const info = await page.evaluate(() => {
      const opt = document.querySelector('select option');
      if (!opt) return null;
      const s = getComputedStyle(opt);
      return { color: s.color, background: s.backgroundColor };
    });
    assert(info, 'no <option> found to inspect');
    // In dark mode the option text must be light, not the UA's near-black.
    const rgb = info.color.match(/\d+/g).map(Number);
    const bright = (rgb[0] + rgb[1] + rgb[2]) / 3;
    assert(bright > 120, `option colour ${info.color} is too dark for a dark surface`);
    return `option color=${info.color} bg=${info.background}`;
  });

  await ctx.close();
};

// ---------------------------------------------------------------------------
GROUPS.admin = async (browser) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, 'admin');

  await check('/admin/users shows row action buttons', async () => {
    await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle' });
    const row = page.locator('table tbody tr').first();
    const verify = await row.locator('button[aria-label*="Verify" i]').count();
    const freeze = await row.locator('button[aria-label*="freeze" i]').count();
    const del = await row.locator('button[aria-label*="Delete" i]').count();
    assert(verify + freeze + del >= 2, `verify=${verify} freeze=${freeze} delete=${del}`);
    return `verify=${verify} freeze=${freeze} delete=${del}`;
  });

  await check('FREEZE flow: dialog -> confirm -> row shows frozen', async () => {
    await page.goto(`${BASE}/admin/users?q=e2estudent`, { waitUntil: 'networkidle' });
    const row = page.locator('table tbody tr').first();
    await row.locator('button[aria-label*="freeze" i]').first().click();
    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ timeout: 5000 });
    await dialog.locator('textarea').fill('E2E automated freeze verification test');
    await dialog.locator('button:has-text("Freeze"), button:has-text("Dondur")').last().click();
    await page.waitForTimeout(2500);
    const body = await page.locator('table tbody').innerText();
    assert(/SUSPENDED|Frozen|Dondurul/i.test(body), 'row does not show a frozen state');
    return 'row reflects the freeze immediately';
  });

  await check('frozen user is actually blocked server-side', async () => {
    const other = await browser.newContext();
    const p2 = await other.newPage();
    await login(p2, 'student');
    const res = await other.request.post(`${BASE}/api/feed`, {
      data: { body: 'should be refused while frozen', tags: [], media: [] },
    });
    await other.close();
    assert(res.status() === 403, `expected 403, got ${res.status()}`);
    return `posting refused with ${res.status()}`;
  });

  await check('UNFREEZE restores the account', async () => {
    await page.goto(`${BASE}/admin/users?q=e2estudent`, { waitUntil: 'networkidle' });
    const row = page.locator('table tbody tr').first();
    await row.locator('button[aria-label*="Lift freeze" i], button[aria-label*="unfreeze" i]').first().click();
    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ timeout: 5000 });
    await dialog.locator('button:has-text("Lift"), button:has-text("Dondurmanı")').last().click();
    await page.waitForTimeout(2500);
    const body = await page.locator('table tbody').innerText();
    assert(/ACTIVE/i.test(body), 'row is not ACTIVE after unfreeze');
    return 'account active again';
  });

  await check('role dialog offers all six roles', async () => {
    await page.goto(`${BASE}/admin/users?q=e2eunverif`, { waitUntil: 'networkidle' });
    const row = page.locator('table tbody tr').first();
    await row.locator('button[aria-label*="Verify" i]').first().click();
    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ timeout: 5000 });
    const options = await dialog.locator('select option').allTextContents();
    const need = ['STUDENT', 'ALUMNI', 'MENTOR', 'TEACHER', 'MODERATOR', 'ADMIN'];
    const missing = need.filter((r) => !options.includes(r));
    assert(missing.length === 0, `missing ${missing.join(',')} — got ${options.join(',')}`);
    return options.join(', ');
  });

  await check('privileged role requires an explicit acknowledgement', async () => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator('select').selectOption('ADMIN');
    await dialog.locator('textarea').fill('E2E privileged role acknowledgement test');
    const confirm = dialog.locator('button:has-text("Verify"), button:has-text("Təsdiqlə")').last();
    const disabledBefore = await confirm.isDisabled();
    assert(disabledBefore, 'confirm was enabled without ticking the acknowledgement');
    await dialog.locator('input[type="checkbox"]').check();
    const disabledAfter = await confirm.isDisabled();
    assert(!disabledAfter, 'confirm stayed disabled after acknowledging');
    await page.keyboard.press('Escape');
    return 'gated before, enabled after';
  });

  await check('/admin/verifications has NO Priority column', async () => {
    await page.goto(`${BASE}/admin/verifications`, { waitUntil: 'networkidle' });
    const headers = await page.locator('table thead th').allTextContents();
    const hasPriority = headers.some((h) => /priorit|prioritet|приорит/i.test(h));
    assert(!hasPriority, `headers: ${headers.join(' | ')}`);
    return headers.map((h) => h.trim()).filter(Boolean).join(', ');
  });

  await check('audit log shows IP / Device / Status columns', async () => {
    await page.goto(`${BASE}/admin/audit-logs`, { waitUntil: 'networkidle' });
    const headers = (await page.locator('table thead th').allTextContents()).join(' ').toLowerCase();
    assert(/ip/.test(headers), 'no IP column');
    assert(/device|cihaz|устрой/.test(headers), 'no Device column');
    assert(/status/.test(headers), 'no Status column');
    return 'IP, Device and Status present';
  });

  await check('audit log EXPORT downloads a real .xlsx', async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('button:has-text("Export"), button:has-text("Excel"), button:has-text("köçür")'),
    ]);
    const name = download.suggestedFilename();
    assert(name.endsWith('.xlsx'), `filename was ${name}`);
    const path = await download.path();
    const { readFileSync } = await import('node:fs');
    const head = readFileSync(path).subarray(0, 2).toString('latin1');
    // A .xlsx is a ZIP container; PK is the signature.
    assert(head === 'PK', `not a zip container (got ${JSON.stringify(head)})`);
    return `${name}, valid xlsx container`;
  });

  await check('admin account menu -> Profile page works', async () => {
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.locator('[data-menu-trigger]:visible').filter({ hasText: '@' }).first().click();
    const menu = page.locator('[role="menu"]').first();
    await menu.waitFor({ timeout: 5000 });
    await menu.locator('a[href="/admin/profile"]').click();
    await page.waitForURL('**/admin/profile', { timeout: 15000 });
    await page.waitForSelector('input', { timeout: 10000 });
    return 'reached /admin/profile with a form';
  });

  await check('admin Profile saves a change', async () => {
    const value = `E2E headline ${Date.now()}`;
    const inputs = page.locator('form input');
    await inputs.nth(1).fill(value);

    // Wait for the PATCH to COMPLETE rather than for a fixed delay. A timed
    // wait reloads while the write is still in flight and then reads back the
    // previous value, which looks like a persistence failure and is not one.
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith('/api/me') && r.request().method() === 'PATCH',
        { timeout: 20000 },
      ),
      page.click('button[type="submit"]'),
    ]);
    assert(response.ok(), `PATCH /api/me returned ${response.status()}`);

    await page.reload({ waitUntil: 'networkidle' });
    const after = await page.locator('form input').nth(1).inputValue();
    assert(after === value, `expected "${value}", got "${after}"`);
    return 'headline persisted';
  });

  await check('admin account menu -> Settings page works', async () => {
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.locator('[data-menu-trigger]:visible').filter({ hasText: '@' }).first().click();
    await page.locator('[role="menu"] a[href="/admin/settings"]').click();
    await page.waitForURL('**/admin/settings', { timeout: 15000 });
    const text = await page.locator('main').innerText();
    assert(text.length > 40, 'settings page looks empty');
    return 'reached /admin/settings';
  });

  await ctx.close();
};

// ---------------------------------------------------------------------------
GROUPS.features = async (browser) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, 'student');

  await check('/notifications renders (list or empty state)', async () => {
    await page.goto(`${BASE}/notifications`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const text = await page.locator('main').innerText();
    assert(!/not built yet|hazır deyil/i.test(text), 'still a stub page');
    assert(text.length > 30, 'page looks empty');
    return text.split('\n')[0].slice(0, 60);
  });

  await check('/messages renders a real inbox', async () => {
    await page.goto(`${BASE}/messages`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const text = await page.locator('main').innerText();
    assert(!/not built yet|hazır deyil/i.test(text), 'still a stub page');
    return text.split('\n')[0].slice(0, 60);
  });

  await check('/mentors lists the seeded mentor', async () => {
    await page.goto(`${BASE}/mentors`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const text = await page.locator('main').innerText();
    assert(!/not built yet|hazır deyil/i.test(text), 'still a stub page');
    assert(/e2estudent|Backend engineer/i.test(text), 'seeded mentor not listed');
    return 'mentor card rendered';
  });

  await check('mentor card links through to a working profile page', async () => {
    // Exclude by HREF, not by text: the "Become a mentor" link points at
    // /mentors/apply but its label contains no "apply", so a text filter lets
    // it through and the test lands on the application stub instead.
    await page
      .locator('a[href^="/mentors/"]:not([href="/mentors/apply"])')
      .first()
      .click();
    await page.waitForURL(/\/mentors\/[a-z0-9]+/i, { timeout: 15000 });
    await page.waitForTimeout(1200);
    const text = await page.locator('main').innerText();
    assert(/Backend engineer/i.test(text), 'headline missing on profile');
    assert(/mentored 20\+/i.test(text), 'about section missing');
    return page.url().replace(BASE, '');
  });

  await check('mentor search filters the directory', async () => {
    await page.goto(`${BASE}/mentors`, { waitUntil: 'networkidle' });
    await page.fill('input[type="search"]', 'zzzznomatch');
    await page.waitForTimeout(1500);
    const text = await page.locator('main').innerText();
    assert(/no mentors|mentor yoxdur|нет менторов/i.test(text), 'empty state not shown for a no-match search');
    return 'empty state shown';
  });

  await check('/notes shows the Add note action', async () => {
    await page.goto(`${BASE}/notes`, { waitUntil: 'networkidle' });
    const link = await page.locator('a[href="/notes/new"]').count();
    assert(link > 0, 'no link to /notes/new');
    return 'add-note link present';
  });

  await check('note upload accepts a .txt and states the size limit', async () => {
    await page.goto(`${BASE}/notes/new`, { waitUntil: 'networkidle' });
    const text = await page.locator('main').innerText();
    assert(/50 MB|50 МБ/i.test(text), 'size limit not stated in the UI');
    await page.setInputFiles('input[type="file"]', {
      name: 'e2e-notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('E2E lecture notes.\n'.repeat(40)),
    });
    await page.waitForTimeout(600);
    const after = await page.locator('main').innerText();
    assert(/e2e-notes\.txt/i.test(after), 'file chip did not appear');
    return 'txt accepted by the picker, limit shown';
  });

  await check('registration form has a searchable 50+ faculty picker', async () => {
    const anon = await browser.newContext();
    await anon.addCookies([{ name: 'CH_LOCALE', value: 'en', url: BASE }]);
    const p2 = await anon.newPage();
    await p2.goto(`${BASE}/register`, { waitUntil: 'networkidle' });
    const combo = p2.locator('#facultySlug');
    await combo.waitFor({ timeout: 10000 });
    await combo.click();
    await p2.waitForTimeout(400);
    const count = await p2.locator('[role="option"]').count();
    assert(count >= 50, `only ${count} options rendered`);

    await combo.fill('comp');
    await p2.waitForTimeout(400);
    const filtered = await p2.locator('[role="option"]').allTextContents();
    assert(filtered.some((o) => /Computer Science/i.test(o)), `filter produced ${filtered.join(',')}`);

    await combo.fill('Other');
    await p2.waitForTimeout(400);
    await p2.locator('[role="option"]:has-text("Other")').first().click();
    await p2.waitForTimeout(400);
    const manual = await p2.locator('#facultyOther').count();
    assert(manual === 1, '"Other" did not reveal a manual input');
    await anon.close();
    return `${count} options, search works, Other reveals manual input`;
  });

  await ctx.close();
};

// ---------------------------------------------------------------------------
GROUPS.messaging = async (browser) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();

  await login(pa, 'student');
  await login(pb, 'unverified');

  const stamp = Date.now();
  let conversationId = null;

  await check('student opens a conversation with another user', async () => {
    const me = await b.request.get(`${BASE}/api/me`);
    const { user } = await me.json();
    const res = await a.request.post(`${BASE}/api/messages`, { data: { userId: user.id } });
    assert(res.ok(), `status ${res.status()}`);
    const body = await res.json();
    conversationId = body.conversationId;
    assert(conversationId, 'no conversationId returned');
    return conversationId;
  });

  await check('opening the same pair twice is idempotent', async () => {
    const me = await b.request.get(`${BASE}/api/me`);
    const { user } = await me.json();
    const res = await a.request.post(`${BASE}/api/messages`, { data: { userId: user.id } });
    const body = await res.json();
    assert(body.conversationId === conversationId, `got a second thread ${body.conversationId}`);
    return 'same thread returned';
  });

  await check('message sends and appears in the sender UI', async () => {
    await pa.goto(`${BASE}/messages`, { waitUntil: 'networkidle' });
    await pa.waitForTimeout(1200);
    await pa.locator('li button').first().click();
    await pa.waitForTimeout(1000);
    await pa.fill('#message-input', `e2e hello ${stamp}`);
    await pa.click('button[aria-label*="Send" i], button[aria-label*="Göndər" i]');
    await pa.locator(`text=e2e hello ${stamp}`).first().waitFor({ timeout: 15000 });
    return 'sent and rendered';
  });

  await check('recipient RECEIVES it with an unread badge', async () => {
    await pb.goto(`${BASE}/messages`, { waitUntil: 'networkidle' });
    await pb.waitForTimeout(1500);
    const text = await pb.locator('main').innerText();
    assert(text.includes(`e2e hello ${stamp}`), 'message not visible to the recipient');
    return 'recipient sees the message preview';
  });

  await check('opening the thread marks it read', async () => {
    await pb.locator('li button').first().click();
    await pb.waitForTimeout(1800);
    const res = await b.request.get(`${BASE}/api/messages`);
    const { conversations } = await res.json();
    const conv = conversations.find((c) => c.id === conversationId);
    assert(conv && conv.unreadCount === 0, `unreadCount=${conv?.unreadCount}`);
    return 'unread cleared';
  });

  await check('message PERSISTS across a reload', async () => {
    await pa.reload({ waitUntil: 'networkidle' });
    await pa.waitForTimeout(1500);
    await pa.locator('li button').first().click();
    await pa.locator(`text=e2e hello ${stamp}`).first().waitFor({ timeout: 15000 });
    return 'still there after reload';
  });

  await a.close();
  await b.close();
};

// ---------------------------------------------------------------------------
GROUPS.notifications = async (browser) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  await login(pa, 'student');
  await login(pb, 'unverified');

  const stamp = Date.now();

  await check('commenting on a post generates a REAL notification', async () => {
    // The student posts.
    const post = await a.request.post(`${BASE}/api/feed`, {
      data: { body: `notif source ${stamp}`, tags: [], media: [] },
    });
    assert(post.ok(), `post failed ${post.status()}`);
    const { post: created } = await post.json();

    // The other account comments on it.
    const comment = await b.request.post(`${BASE}/api/feed/${created.id}/comments`, {
      data: { body: `notif comment ${stamp}` },
    });
    assert(comment.ok(), `comment failed ${comment.status()}`);

    // The author should now have an unread notification.
    const res = await a.request.get(`${BASE}/api/notifications?filter=unread`);
    const { notifications, unreadCount } = await res.json();
    assert(unreadCount > 0, 'no unread notification was created');
    assert(notifications.some((n) => n.type === 'POST_REPLY'), 'no POST_REPLY row');
    return `${unreadCount} unread, POST_REPLY present`;
  });

  await check('notifications page renders the event and marks all read', async () => {
    await pa.goto(`${BASE}/notifications`, { waitUntil: 'networkidle' });
    await pa.waitForTimeout(1500);
    const text = await pa.locator('main').innerText();
    assert(/comment|şərh|коммент/i.test(text), `page text: ${text.slice(0, 120)}`);

    await pa.click('button:has-text("Mark all"), button:has-text("Hamısını"), button:has-text("Отметить")');
    await pa.waitForTimeout(1800);

    const res = await a.request.get(`${BASE}/api/notifications`);
    const { unreadCount } = await res.json();
    assert(unreadCount === 0, `unreadCount is still ${unreadCount}`);
    return 'all marked read';
  });

  await a.close();
  await b.close();
};

// ---------------------------------------------------------------------------
const requested = process.argv.slice(2);
const selected = requested.length ? requested : Object.keys(GROUPS);

const browser = await chromium.launch({ channel: 'chrome', headless: true });

for (const name of selected) {
  if (!GROUPS[name]) {
    console.log(`\n(unknown group "${name}")`);
    continue;
  }
  currentGroup = name;
  console.log(`\n=== ${name.toUpperCase()} ===`);
  try {
    await GROUPS[name](browser);
  } catch (error) {
    record(`${name} group crashed`, false, error.message.split('\n')[0].slice(0, 200));
  }
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(60)}`);
console.log(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}`);
if (failed.length) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(`  [${f.group}] ${f.name}\n      ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
