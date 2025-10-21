// scraper.js
import { chromium } from '@playwright/test';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

// ----------------------------- Config & constants -----------------------------
const OUT_DIR   = path.join(process.cwd(), 'docs');
const OUT_FILE  = path.join(OUT_DIR, 'feed.xml');
const DEBUG_DIR = path.join(OUT_DIR, 'debug');

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15A372 Safari/604.1';

const DEFAULT_SELECTORS = {
  item:  "li.mec-event-article, .mec-event-list li, .tribe-events-calendar-list__event, article, .event, .event-card, .event-item, li.event, li.EventList-item, .card, .listing, .tile",
  title: ".mec-event-title a, .entry-title a, .entry-title, h1, h2, h3, .title, .event-title, .card-title, [itemprop='name']",
  link:  ".mec-event-title a, a[href]",
  date:  ".mec-start-date, .tribe-event-date-start, time, [datetime], .date, .event-date, .card-date, [class*='date'], [class*='time']",
  image: "img, [data-src], [data-original], [data-lazy], [data-image], [style*='background-image']"
};

// ----------------------------- Helpers -----------------------------
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const safe   = (v) => (typeof v === 'string' ? v.trim() : (v ?? '') + '');
const norm   = (s) => safe(s).toLowerCase().replace(/\s+/g, ' ').trim();
const rfc822 = (d) => (d ? new Date(d) : new Date()).toUTCString();
const isImg  = (u) => /\.(png|jpe?g|gif|webp|avif)(\?.*)?$/i.test(u || '');
const cdata  = (s) => `<![CDATA[${s || ''}]]>`;
const pickFirstFromSrcset = (srcset) => {
  if (!srcset) return '';
  const first = srcset.split(',')[0] || '';
  return first.trim().split(/\s+/)[0] || '';
};
const toAbs = (href, base) => { try { return new URL(href, base).href; } catch { return href || base; } };
const pick  = (obj, pathStr) => {
  if (!pathStr) return undefined;
  return pathStr.split('.').reduce((o,k)=> (o && (k in o) ? o[k] : undefined), obj);
};
function stripJsonComments(str) {
  str = str.replace(/\/\*[\s\S]*?\*\//g, '');
  str = str.replace(/(^|\s)\/\/.*$/gm, '');
  return str;
}

// Load sites
const rawSites = fs.readFileSync('./sites.json', 'utf8');
const SITES = JSON.parse(stripJsonComments(rawSites));

// Defaults, filters
function applyDefaults(cfg) {
  if (cfg.mode === 'dom') {
    cfg.item  = cfg.item  || DEFAULT_SELECTORS.item;
    cfg.title = cfg.title || DEFAULT_SELECTORS.title;
    cfg.link  = cfg.link  || DEFAULT_SELECTORS.link;
    cfg.date  = cfg.date  || DEFAULT_SELECTORS.date;
    cfg.image = cfg.image || DEFAULT_SELECTORS.image;
  }
  if (cfg.waitMs == null) cfg.waitMs = 2200;

  if (cfg.filters) {
    cfg._filter = (txt) => {
      const t = (txt || '').toLowerCase();
      if (cfg.filters.exclude && cfg.filters.exclude.some(w => t.includes(w.toLowerCase()))) return false;
      if (cfg.filters.include && !cfg.filters.include.some(w => t.includes(w.toLowerCase()))) return false;
      return true;
    };
  } else {
    cfg._filter = () => true;
  }
}

async function firstExistingSelector(page, candidates, timeoutMs = 8000) {
  if (!candidates) return null;
  const list = candidates.split(',').map(s => s.trim()).filter(Boolean);
  const start = Date.now();
  for (;;) {
    for (const sel of list) {
      try {
        const count = await page.locator(sel).count();
        if (count > 0) return sel;
      } catch {}
    }
    if (Date.now() - start > timeoutMs) return null;
    await sleep(250);
  }
}

async function innerTextSafe(handle) {
  if (!handle) return '';
  try { return safe(await (await handle.getProperty('innerText')).jsonValue()); }
  catch { return ''; }
}

async function autoScroll(page, pixels = 2000) {
  await page.evaluate(async (step) => {
    await new Promise((resolve) => {
      let scrolled = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        scrolled += step;
        if (scrolled >= document.body.scrollHeight * 0.9) { clearInterval(timer); resolve(); }
      }, 100);
    });
  }, Math.max(200, Math.floor(pixels / 10)));
}

async function clickCookieBanners(page) {
  const sels = [
    'button[aria-label="Accept"]',
    'button:has-text("I Accept")',
    'button:has-text("Accept All")',
    'button:has-text("Allow all")',
    '#onetrust-accept-btn-handler',
    '.cky-btn-accept, .cmplz-accept'
  ].join(',');
  try {
    const b = await page.$(sels);
    if (b) { await b.click({ delay: 30 }); await sleep(400); }
  } catch {}
}

// Fallback: fetch detail image via og:image or JSON-LD
async function fetchDetailImage(detailUrl) {
  try {
    const res = await fetch(detailUrl, { headers: { 'user-agent': UA_DESKTOP, 'accept': 'text/html' } });
    if (!res.ok) return '';
    const html = await res.text();
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (og && og[1]) return toAbs(og[1], detailUrl);

    const ldBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
      .map(m => (m[1] || '').trim());
    for (const raw of ldBlocks) {
      try {
        const json = JSON.parse(raw);
        const candidates = Array.isArray(json) ? json : [json, ...(Array.isArray(json['@graph']) ? json['@graph'] : [])];
        for (const node of candidates) {
          if (!node) continue;
          if (node['@type'] === 'Event' || node['@type'] === 'Article' || node['@type'] === 'WebPage') {
            let img = '';
            const ri = node.image;
            if (typeof ri === 'string') img = ri;
            else if (ri && typeof ri === 'object' && ri.url) img = ri.url;
            else if (Array.isArray(ri) && ri.length) img = typeof ri[0] === 'string' ? ri[0] : (ri[0]?.url || '');
            if (img) return toAbs(safe(img), detailUrl);
          }
        }
      } catch {}
    }
  } catch {}
  return '';
}

async function saveDebug(page, cfg, reason) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const html = await page.content();
    fs.writeFileSync(path.join(DEBUG_DIR, `${cfg.key}-${reason}.html`), html, 'utf8');
    await page.screenshot({ path: path.join(DEBUG_DIR, `${cfg.key}-${reason}.png`), fullPage: true });
    console.log(`Saved debug → ${path.join('docs/debug', `${cfg.key}-${reason}.html/png`)}`);
  } catch (e) {
    console.warn(`Could not save debug for ${cfg.key}: ${e.message}`);
  }
}

// ----------------------------- RSS builder -----------------------------
function buildRSS(items, channel = {
  title: 'North ATL Events (JS-capable Feed)',
  link: 'https://example.com',
  description: 'Combined events rendered with Playwright'
}) {
  const builder = new XMLBuilder({ ignoreAttributes: false, suppressEmptyNode: true });
  const rssObj = {
    rss: {
      '@_version': '2.0',
      '@_xmlns:media': 'http://search.yahoo.com/mrss/',
      channel: {
        title: channel.title,
        link: channel.link,
        description: channel.description,
        lastBuildDate: new Date().toUTCString(),
        item: items.map(i => {
          const imgTag = i.image ? `<p><img src="${i.image}" alt=""/></p>` : '';
          const descHtml = `${imgTag}${i.description || ''}`;
          const node = {
            title: i.title,
            link: i.link,
            guid: i.guid,
            pubDate: i.pubDate,
            description: { '#text': cdata(descHtml) }
          };
          const cats = [];
          if (i.town)  cats.push({ '#text': i.town });
          if (i.venue) cats.push({ '#text': i.venue });
          if (cats.length) node.category = cats;

          if (i.image) {
            node['media:content'] = { '@_url': i.image, '@_medium': 'image' };
            node.enclosure = {
              '@_url': i.image,
              '@_type': isImg(i.image)
                ? `image/${i.image.split('.').pop().toLowerCase().replace('jpg','jpeg')}`
                : 'image/jpeg'
            };
          }
          return node;
        })
      }
    }
  };
  return builder.build(rssObj);
}

// ----------------------------- Modes -----------------------------
async function scrapeJSONLD(page, cfg) {
  await page.goto(cfg.url, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(cfg.waitMs);
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
  const out = [];
  for (const e of events) {
    const title = safe(e.name);
    const url   = toAbs(safe(e.url) || cfg.url, cfg.url);
    const start = safe(e.startDate || e.startTime);
    const venue = safe(e?.location?.name || cfg.venue);

    let img = '';
    const ri = e.image;
    if (typeof ri === 'string') img = ri;
    else if (ri && typeof ri === 'object' && ri.url) img = ri.url;
    else if (Array.isArray(ri) && ri.length) img = typeof ri[0] === 'string' ? ri[0] : (ri[0]?.url || '');
    img = toAbs(safe(img), cfg.url);

    const textBlob = `${title} ${venue}`;
    if (!cfg._filter(textBlob)) continue;

    out.push({
      title: (cfg.town ? `[${cfg.town}] ` : '') + title,
      link: url,
      guid: url + '#' + norm(title) + '#' + norm(start),
      pubDate: rfc822(start),
      description: [venue, start].filter(Boolean).join(' — '),
      image: img,
      town: cfg.town || '',
      venue: cfg.venue || venue || ''
    });
  }
  return out;
}

async function scrapeDOM(page, cfg) {
  await page.goto(cfg.url, { waitUntil: 'networkidle', timeout: 60000 });

  // UA override per site
  if (cfg.ua === 'mobile') await page.context().setExtraHTTPHeaders({ 'User-Agent': UA_MOBILE });
  else await page.context().setExtraHTTPHeaders({ 'User-Agent': UA_DESKTOP });

  await page.context().addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await clickCookieBanners(page);
  await sleep(cfg.waitMs);
  await autoScroll(page);

  // Try load-more buttons (MEC/Tribe/common)
  try {
    const loadMoreSel = [
      '.mec-load-more a',
      '.mec-load-more-button',
      '.tribe-events-c-nav__next, .tribe-events-c-nav__next a',
      '.load-more a', 'button.load-more'
    ].join(',');
    const btn = await page.$(loadMoreSel);
    if (btn) {
      await btn.click({ delay: 50 });
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      await autoScroll(page);
      await sleep(1200);
    }
  } catch {}

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  if (/Checking your browser|cf-error|enable cookies/i.test(bodyText)) {
    await saveDebug(page, cfg, 'cf-block');
    return [];
  }

  // If jsonldFirst is set, try JSON-LD before DOM
  if (cfg.jsonldFirst) {
    const jsonldItems = await scrapeJSONLD(page, cfg);
    if (jsonldItems.length > 0) return jsonldItems;
  }

  // DOM scrape
  const itemSel = await firstExistingSelector(page, cfg.item, 8000);
  if (!itemSel) { await saveDebug(page, cfg, 'no-selector'); return []; }

  const cards = await page.locator(itemSel).elementHandles();
  const take = Math.min(cards.length, cfg.max || 220);
  const out = [];

  for (let i = 0; i < take; i++) {
    const el = cards[i];

    // title
    let title = '';
    for (const tSel of cfg.title.split(',').map(s => s.trim())) {
      const tEl = await el.$(tSel);
      title = await innerTextSafe(tEl);
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
      if (dEl) { try { date = safe(await dEl.innerText()); } catch {} if (date) break; }
    }

    // image
    let imageUrl = '';
    for (const iSel of cfg.image.split(',').map(s => s.trim())) {
      const iEl = await el.$(iSel);
      if (!iEl) continue;
      const cand = await Promise.all([
        iEl.getAttribute('src'),
        iEl.getAttribute('data-src'),
        iEl.getAttribute('data-original'),
        iEl.getAttribute('data-lazy'),
        iEl.getAttribute('data-image'),
        iEl.getAttribute('srcset'),
        iEl.getAttribute('style')
      ]);
      let [src, dataSrc, dataOrig, dataLazy, dataImage, srcset, styleAttr] = cand.map(x => safe(x));
      if (!src && srcset) src = pickFirstFromSrcset(srcset);
      if (!src && styleAttr) {
        const m = styleAttr.match(/background-image:\s*url\((['"]?)([^'")]+)\1\)/i);
        if (m && m[2]) src = m[2];
      }
      imageUrl = toAbs(src || dataSrc || dataOrig || dataLazy || dataImage || '', cfg.url);
      if (imageUrl) break;
    }

    if (!title && !href) continue;

    const textBlob = `${title} ${date} ${cfg.venue || ''}`;
    if (!cfg._filter(textBlob)) continue;

    if (!imageUrl && href) imageUrl = await fetchDetailImage(href);

    out.push({
      title: (cfg.town ? `[${cfg.town}] ` : '') + title,
      link: href || cfg.url,
      guid: (href || cfg.url) + '#' + norm(title) + '#' + norm(date),
      pubDate: rfc822(date),
      description: [cfg.venue, date].filter(Boolean).join(' — '),
      image: imageUrl || '',
      town: cfg.town || '',
      venue: cfg.venue || ''
    });
  }

  if (out.length === 0) {
    // one more try: soft reload + more wait (handles MEC autoload)
    await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
    await clickCookieBanners(page);
    await sleep(cfg.waitMs + 1200);
    await autoScroll(page);
    const again = await firstExistingSelector(page, cfg.item, 4000);
    if (!again) { await saveDebug(page, cfg, 'empty'); return []; }
  }

  return out;
}

async function scrapeJSON(cfg) {
  const res = await fetch(cfg.api, { headers: { 'user-agent': UA_DESKTOP, 'accept': 'application/json' } });
  if (!res.ok) throw new Error(`JSON ${res.status} ${cfg.api}`);
  const data = await res.json();

  const list = Array.isArray(pick(data, cfg.map?.path))
    ? pick(data, cfg.map.path)
    : (Array.isArray(data) ? data : []);

  const out = [];
  for (const e of list) {
    const title = safe(cfg.map?.title ? pick(e, cfg.map.title) : (e.title || e.name));
    const link  = toAbs(safe(cfg.map?.link ? pick(e, cfg.map.link) : (e.url || e.link)) || cfg.api, cfg.api);
    const date  = safe(cfg.map?.date ? pick(e, cfg.map.date) : (e.start_date || e.start || e.date || ''));
    const venue = safe(cfg.map?.venue ? pick(e, cfg.map.venue) : (e?.venue?.name || e.venue || cfg.venue || ''));

    let img = '';
    if (cfg.map?.image) img = safe(pick(e, cfg.map.image) || '');
    else img = safe(e.image || e.featured_image || (Array.isArray(e.images) ? e.images[0] : ''));
    img = toAbs(img, link);

    const textBlob = `${title} ${venue}`;
    if (!cfg._filter(textBlob)) continue;

    out.push({
      title: (cfg.town ? `[${cfg.town}] ` : '') + title,
      link,
      guid: link + '#' + norm(title) + '#' + norm(date),
      pubDate: rfc822(date),
      description: [venue, date].filter(Boolean).join(' — '),
      image: img,
      town: cfg.town || '',
      venue: cfg.venue || venue || ''
    });
  }
  return out;
}

async function scrapeICS(cfg) {
  const res = await fetch(cfg.ics, { headers: { 'user-agent': UA_DESKTOP } });
  if (!res.ok) throw new Error(`ICS ${res.status} ${cfg.ics}`);
  const text = await res.text();

  const events = text.split('BEGIN:VEVENT').slice(1).map(block => {
    const get = (k) => (block.match(new RegExp(`${k}:(.*)`)) || [, ''])[1].trim();
    const summary = get('SUMMARY');
    const url     = get('URL') || cfg.ics;
    const dtstart = get('DTSTART') || '';
    const venue   = get('LOCATION') || cfg.venue || '';
    return { summary, url, dtstart, venue };
  });

  const out = [];
  for (const ev of events) {
    const title = safe(ev.summary);
    const link  = toAbs(ev.url || cfg.ics, cfg.ics);
    const date  = safe(ev.dtstart);
    const desc  = [cfg.venue || ev.venue || '', date].filter(Boolean).join(' — ');

    const textBlob = `${title} ${desc}`;
    if (!cfg._filter(textBlob)) continue;

    out.push({
      title: (cfg.town ? `[${cfg.town}] ` : '') + title,
      link,
      guid: link + '#' + norm(title) + '#' + norm(date),
      pubDate: rfc822(date),
      description: desc,
      image: '',
      town: cfg.town || '',
      venue: cfg.venue || ''
    });
  }
  return out;
}

async function scrapeRSS(cfg) {
  const res = await fetch(cfg.rss, {
    headers: { 'user-agent': UA_DESKTOP, 'accept': 'application/rss+xml, application/atom+xml, text/xml;q=0.9' }
  });
  if (!res.ok) throw new Error(`RSS ${res.status} ${cfg.rss}`);
  const xml = await res.text();

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", allowBooleanAttributes: true });
  const parsed  = parser.parse(xml);
  const channel = parsed.rss?.channel || parsed.feed || {};
  const entries = channel.item || channel.entry || [];
  const arr     = Array.isArray(entries) ? entries : [entries];

  const out = [];
  for (const e of arr) {
    const title = safe(e.title?.['#text'] || e.title || e['media:title'] || '');
    const link =
      e.link?.['@_href'] ||
      (Array.isArray(e.link) ? (e.link.find(l => l['@_href'])?.['@_href'] || e.link[0]) : e.link) ||
      e.guid || cfg.rss;

    const desc = safe(e['content:encoded']?.['#text'] || e['content:encoded'] || e.description?.['#text'] || e.description || e.summary?.['#text'] || e.summary || '');
    const pub  = safe(e.pubDate || e.updated || e.published || new Date().toUTCString());

    let img =
      e['media:content']?.['@_url'] ||
      (Array.isArray(e['media:content']) ? e['media:content'][0]?.['@_url'] : '') ||
      (e.enclosure && e.enclosure['@_type'] && (''+e.enclosure['@_type']).startsWith('image/') ? e.enclosure['@_url'] : (e.enclosure?.['@_url'] || '')) ||
      (() => {
        const html = (e['content:encoded']?.['#text'] || e['content:encoded'] || desc || '') + '';
        const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
        return m ? m[1] : '';
      })();

    const prettyTitle = (cfg.town ? `[${cfg.town}] ` : '') + title;
    const prettyDesc  = [cfg.venue, desc].filter(Boolean).join(' — ');
    const imageAbs    = img ? toAbs(img, link) : '';

    const textBlob = `${title} ${prettyDesc}`;
    if (!cfg._filter(textBlob)) continue;

    out.push({
      title: prettyTitle,
      link: toAbs(link, cfg.rss),
      guid: (link || cfg.rss) + '#' + norm(title),
      pubDate: rfc822(pub),
      description: prettyDesc,
      image: imageAbs,
      town: cfg.town || '',
      venue: cfg.venue || ''
    });
  }
  return out;
}

// ----------------------------- Main -----------------------------
(async () => {
  if (!fs.existsSync(OUT_DIR))   fs.mkdirSync(OUT_DIR,   { recursive: true });
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    userAgent: UA_DESKTOP,
    locale: 'en-US',
    viewport: { width: 1366, height: 900 }
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();

  const items = [];

  for (const rawCfg of SITES) {
    const cfg = { ...rawCfg };
    applyDefaults(cfg);

    try {
      let part = [];

      if (cfg.mode === 'dom') {
        part = await scrapeDOM(page, cfg);
      } else if (cfg.mode === 'jsonld') {
        part = await scrapeJSONLD(page, cfg);
      } else if (cfg.mode === 'json') {
        part = await scrapeJSON(cfg);
      } else if (cfg.mode === 'ics') {
        part = await scrapeICS(cfg);
      } else if (cfg.mode === 'rss') {
        part = await scrapeRSS(cfg);
      } else {
        console.warn(`Unknown mode for ${cfg.key}`);
        continue;
      }

      if (part.length === 0) await saveDebug(page, cfg, 'empty');
      items.push(...part);
      console.log(`OK: ${cfg.key} → ${part.length} items`);
    } catch (e) {
      console.error(`FAIL: ${cfg.key} → ${e.message}`);
      try { await saveDebug(page, cfg, 'error'); } catch {}
    }
  }

  await browser.close();

  // De-dup
  const seen  = new Set();
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
