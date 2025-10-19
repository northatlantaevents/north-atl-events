import { chromium } from '@playwright/test';
import { XMLBuilder } from 'fast-xml-parser';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

const SITES = JSON.parse(fs.readFileSync('./sites.json','utf8'));
const OUT_DIR = path.join(process.cwd(), 'docs');
const OUT_FILE = path.join(OUT_DIR, 'feed.xml');
const DEBUG_DIR = path.join(OUT_DIR, 'debug');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const safe = (v) => (typeof v === 'string' ? v.trim() : (v ?? '') + '');
const toAbs = (href, base) => { try { return new URL(href, base).href; } catch { return href || base; } };
const norm = (s) => safe(s).toLowerCase().replace(/\s+/g,' ').trim();
const rfc822 = (d) => (d ? new Date(d) : new Date()).toUTCString();

function buildRSS(items, channel = {
  title: 'North ATL Events (JS-capable Feed)',
  link: 'https://example.com',
  description: 'Combined events rendered with Playwright'
}) {
  const builder = new XMLBuilder({ ignoreAttributes: false, suppressEmptyNode: true });
  return builder.build({
    rss: {
      '@_version': '2.0',
      channel: {
        title: channel.title,
        link: channel.link,
        description: channel.description,
        lastBuildDate: new Date().toUTCString(),
        item: items.map(i => ({
          title: i.title,
          link: i.link,
          guid: i.guid,
          pubDate: i.pubDate,
          description: i.description
        }))
      }
    }
  });
}

async function firstExistingSelector(page, candidates, timeoutMs=6000) {
  const list = candidates.split(',').map(s => s.trim()).filter(Boolean);
  const start = Date.now();
  for (;;) {
    for (const sel of list) {
      const count = await page.locator(sel).count();
      if (count > 0) return sel;
    }
    if (Date.now() - start > timeoutMs) return null;
    await sleep(250);
  }
}

async function innerTextSafe(page, handle) {
  if (!handle) return '';
  try { return safe(await (await handle.getProperty('innerText')).jsonValue()); }
  catch { return ''; }
}

async function scrapeDOM(page, cfg) {
  const waitMs = cfg.waitMs ?? 2000;

  await page.goto(cfg.url, {
    waitUntil: 'networkidle',
    timeout: 60000,
  });
  // Helpful headers
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9'
  });

  // Some sites lazy-load; give it a beat
  await sleep(waitMs);

  // Try to find a working item selector from the provided list
  const itemSel = await firstExistingSelector(page, cfg.item, 8000);
  if (!itemSel) return { items: [], debug: { itemSelectorChosen: null, itemCount: 0 } };

  const cards = await page.locator(itemSel).elementHandles();
  const take = Math.min(cards.length, cfg.max || 120);
  const out = [];

  for (let i = 0; i < take; i++) {
    const el = cards[i];

    // title
    let title = '';
    for (const tSel of cfg.title.split(',').map(s => s.trim())) {
      const tEl = await el.$(tSel);
      title = await innerTextSafe(page, tEl);
      if (title) break;
    }

    // link
    let href = '';
    for (const aSel of cfg.link.split(',').map(s => s.trim())) {
      const aEl = await el.$(aSel);
      if (aEl) {
        href = safe(await aEl.getAttribute('href'));
        if (href) break;
      }
    }
    if (href && href.startsWith('/')) href = toAbs(href, cfg.url);

    // date
    let date = '';
    for (const dSel of cfg.date.split(',').map(s => s.trim())) {
      const dEl = await el.$(dSel);
      if (dEl) {
        try { date = safe(await dEl.innerText()); } catch {}
        if (date) break;
      }
    }

    if (!title && !href) continue;
    out.push({
      title: (cfg.town ? `[${cfg.town}] ` : '') + title,
      link: href || cfg.url,
      guid: (href || cfg.url) + '#' + norm(title) + '#' + norm(date),
      pubDate: rfc822(date),
      description: [cfg.venue, date].filter(Boolean).join(' — ')
    });
  }

  return { items: out, debug: { itemSelectorChosen: itemSel, itemCount: take } };
}

async function scrapeJSONLD(page, cfg) {
  await page.goto(cfg.url, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(cfg.waitMs ?? 1000);

  const scripts = await page.$$eval('script[type="application/ld+json"]', els => els.map(e => e.textContent || ''));
  const events = [];
  for (const raw of scripts) {
    try {
      const json = JSON.parse(raw);
      const arr = [];
      if (Array.isArray(json)) arr.push(...json);
      else {
        arr.push(json);
        if (Array.isArray(json['@graph'])) arr.push(...json['@graph']);
      }
      for (const node of arr) {
        if (!node) continue;
        if (node['@type'] === 'Event') events.push(node);
        if (Array.isArray(node.event)) node.event.forEach(e => { if (e['@type'] === 'Event') events.push(e); });
      }
    } catch {}
  }

  const out = events.map(e => {
    const title = safe(e.name);
    const url = toAbs(safe(e.url) || cfg.url, cfg.url);
    const start = safe(e.startDate || e.startTime);
    const venue = safe(e?.location?.name || cfg.venue);
    return {
      title: (cfg.town ? `[${cfg.town}] ` : '') + title,
      link: url,
      guid: url + '#' + norm(title) + '#' + norm(start),
      pubDate: rfc822(start),
      description: [venue, start].filter(Boolean).join(' — ')
    };
  });

  return out;
}

async function scrapeJSON(cfg) {
  const res = await fetch(cfg.api, { headers: { 'user-agent': USER_AGENT, 'accept': 'application/json' } });
  if (!res.ok) throw new Error(`JSON ${res.status} ${cfg.api}`);
  const data = await res.json();
  const list = Array.isArray(data?.events) ? data.events : (Array.isArray(data) ? data : []);
  return list.map(e => {
    const title = safe(e.title || e.name);
    const link  = toAbs(safe(e.url || e.link) || cfg.api, cfg.api);
    const date  = safe(e.start_date || e.start || e.date || '');
    const venue = safe(e?.venue?.name || e.venue || cfg.venue || '');
    return {
      title: (cfg.town ? `[${cfg.town}] ` : '') + title,
      link,
      guid: link + '#' + norm(title) + '#' + norm(date),
      pubDate: rfc822(date),
      description: [venue, date].filter(Boolean).join(' — ')
    };
  });
}

async function saveDebugSnapshot(page, cfg, reason='empty') {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const file = path.join(DEBUG_DIR, `${cfg.key}-${reason}.html`);
    const html = await page.content();
    fs.writeFileSync(file, html, 'utf8');
    console.log(`Saved debug HTML → ${file}`);
  } catch (e) {
    console.warn(`Could not save debug snapshot for ${cfg.key}: ${e.message}`);
  }
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
  const page = await ctx.newPage();

  const items = [];
  for (const cfg of SITES) {
    try {
      let part = [];
      let diag = null;

      if (cfg.mode === 'dom') {
        const result = await scrapeDOM(page, cfg);
        part = result.items;
        diag = result.debug;
        if ((part?.length || 0) === 0) {
          // Fallback to JSON-LD if DOM yielded nothing
          const alt = await scrapeJSONLD(page, { url: cfg.url, venue: cfg.venue, town: cfg.town, waitMs: cfg.waitMs });
          if (alt.length > 0) {
            console.log(`Fallback JSON-LD used for ${cfg.key} → ${alt.length} items`);
            part = alt;
          } else {
            await saveDebugSnapshot(page, cfg, 'empty');
          }
        }
      } else if (cfg.mode === 'jsonld') {
        part = await scrapeJSONLD(page, cfg);
        if ((part?.length || 0) === 0) await saveDebugSnapshot(page, cfg, 'jsonld-empty');
      } else if (cfg.mode === 'json') {
        part = await scrapeJSON(cfg);
      } else if (cfg.mode === 'ics') {
        part = await scrapeJSON(cfg);
      } else {
        console.warn(`Unknown mode for ${cfg.key}`);
      }

      items.push(...part);
      console.log(`OK: ${cfg.key} → ${part.length} items` + (diag ? ` (selector: ${diag.itemSelectorChosen}, count: ${diag.itemCount})` : ''));
    } catch (e) {
      console.error(`FAIL: ${cfg.key} → ${e.message}`);
      // Try to capture snapshot on fail
      try { await saveDebugSnapshot(page, cfg, 'error'); } catch {}
    }
  }

  await browser.close();

  // de-dupe
  const seen = new Set();
  const dedup = [];
  for (const it of items) {
    const k = norm(it.title) + '|' + norm(it.description) + '|' + norm(it.link);
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(it);
  }

  const rss = buildRSS(dedup.slice(0, 500));
  fs.writeFileSync(OUT_FILE, rss, 'utf8');
  console.log(`Wrote ${dedup.length} items → ${OUT_FILE}`);
})();
