// scraper.mjs
// Universal JS-capable event feed builder for GitHub Actions + Pages
// Modes: "dom", "jsonld", "json", "ics", "rss"

import { chromium } from '@playwright/test';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

// ----------------------------- Config & constants -----------------------------
const OUT_DIR   = path.join(process.cwd(), 'docs');
const OUT_FILE  = path.join(OUT_DIR, 'feed.xml');
const DEBUG_DIR = path.join(OUT_DIR, 'debug');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const DEFAULT_SELECTORS = {
  item:  "article, .event, .event-card, .event-item, li.event, li.EventList-item, .tribe-events-calendar-list__event, .mec-event-list li, .card, .listing, .tile",
  title: "h1, h2, h3, .title, .event-title, .entry-title, .card-title, [itemprop='name']",
  link:  "a[href]",
  date:  "time, [datetime], .date, .event-date, .card-date, .tribe-event-date-start, .mec-start-date, [class*='date'], [class*='time']",
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

// Allow comments in sites.json if you want
function stripJsonComments(str) {
  str = str.replace(/\/\*[\s\S]*?\*\//g, '');       // /* block */
  str = str.replace(/(^|\s)\/\/.*$/gm, '');         // // line
  return str;
}

// Load sites.json (with optional comments)
const rawSites = fs.readFileSync('./sites.json', 'utf8');
const SITES = JSON.parse(stripJsonComments(rawSites));

// Apply universal defaults and simple include/exclude filters
function applyDefaults(cfg) {
  if (cfg.mode === 'dom') {
    cfg.item  = cfg.item  || DEFAULT_SELECTORS.item;
    cfg.title = cfg.title || DEFAULT_SELECTORS.title;
    cfg.link  = cfg.link  || DEFAULT_SELECTORS.link;
    cfg.date  = cfg.date  || DEFAULT_SELECTORS.date;
    cfg.image = cfg.image || DEFAULT_SELECTORS.image;
  }
  if (cfg.waitMs == null) cfg.waitMs = 2000;

  if (cfg.filters) {
    // { include: ["music","live"], exclude: ["bingo","trivia"] }
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

// Choose the first selector that exists on the page (for item list)
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

// Fallback to detail page <meta property="og:image"> or JSON-LD image
async function fetchDetailImage(detailUrl) {
  try {
    const res = await fetch(detailUrl, { headers: { 'user-agent': USER_AGENT, 'accept': 'text/html' } });
    if (!res.ok) return '';
    const html = await res.text();

    // og:image
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (og && og[1]) return toAbs(og[1], detailUrl);

    // JSON-LD
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

// Save snapshot when empty for tuning selectors
async function saveDebugSnapshot(page, cfg, reason = 'empty') {
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

// ----------------------------- Mode: DOM -----------------------------
async function scrapeDOM(page, cfg) {
  await page.goto(cfg.url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await sleep(cfg.waitMs);

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
      if (dEl) {
        try { date = safe(await dEl.innerText()); } catch {}
        if (date) break;
      }
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

    // Fallback to detail page image if card image missing
    if (!imageUrl && href) {
      imageUrl = await fetchDetailImage(href);
    }

    out.push({
      title: (cfg.town ? `[${cfg.town}] ` : '') + title,
      link: href || cfg.url,
      guid: (href || cfg.url) + '#' + norm(title) + '#' + norm(date),
      pubDate: rfc822(date),
      description: [cfg.venue, date].filter(Boolean).join(' — '),
      image: imageUrl || ''
    });
  }

  return { items: out, debug: { itemSelectorChosen: itemSel, itemCount: take } };
}

// ----------------------------- Mode: JSON-LD -----------------------------
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
      image: img
    });
  }
  return out;
}

// ----------------------------- Mode: JSON (public API) -----------------------------
async function scrapeJSON(cfg) {
  const res = await fetch(cfg.api, { headers: { 'user-agent': USER_AGENT, 'accept': 'application/json' } });
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
    if (cfg.map?.image) {
      img = safe(pick(e, cfg.map.image) || '');
    } else {
      img = safe(e.image || e.featured_image || (Array.isArray(e.images) ? e.images[0] : ''));
    }
    img = toAbs(img, link);

    const textBlob = `${title} ${venue}`;
    if (!cfg._filter(textBlob)) continue;

    out.push({
      title: (cfg.town ? `[${cfg.town}] ` : '') + title,
      link,
      guid: link + '#' + norm(title) + '#' + norm(date),
      pubDate: rfc822(date),
      description: [venue, date].filter(Boolean).join(' — '),
      image: img
    });
  }
  return out;
}

// ----------------------------- Mode: ICS (calendars) -----------------------------
async function scrapeICS(cfg) {
  const res = await fetch(cfg.ics, { headers: { 'user-agent': USER_AGENT } });
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
      image: '' // ICS rarely provides images
    });
  }
  return out;
}

// ----------------------------- Mode: RSS/Atom (via RSS-Bridge, native feeds) -----------------------------
async function scrapeRSS(cfg) {
  const res = await fetch(cfg.rss, {
    headers: { 'user-agent': USER_AGENT, 'accept': 'application/rss+xml, application/atom+xml, text/xml;q=0.9' }
  });
  if (!res.ok) throw new Error(`RSS ${res.status} ${cfg.rss}`);
  const xml = await res.text();

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    allowBooleanAttributes: true
  });
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
      image: imageAbs
    });
  }
  return out;
}

// ----------------------------- Main -----------------------------
(async () => {
  if (!fs.existsSync(OUT_DIR))   fs.mkdirSync(OUT_DIR,   { recursive: true });
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
  const page = await ctx.newPage();

  const items = [];

  for (const rawCfg of SITES) {
    const cfg = { ...rawCfg };
    applyDefaults(cfg);

    try {
      let part = [];

      if (cfg.mode === 'dom') {
        const result = await scrapeDOM(page, cfg);
        part = result.items;
        if ((part?.length || 0) === 0) {
          const alt = await scrapeJSONLD(page, { url: cfg.url, venue: cfg.venue, town: cfg.town, waitMs: cfg.waitMs, filters: cfg.filters });
          if (alt.length > 0) {
            console.log(`Fallback JSON-LD used for ${cfg.key} → ${alt.length} items`);
            // pass through the same filter function
            part = alt.filter(it => cfg._filter(`${it.title} ${it.description}`));
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
        part = await scrapeICS(cfg);
      } else if (cfg.mode === 'rss') {
        part = await scrapeRSS(cfg);
      } else {
        console.warn(`Unknown mode for ${cfg.key}`);
        continue;
      }

      items.push(...part);
      console.log(`OK: ${cfg.key} → ${part.length} items`);
    } catch (e) {
      console.error(`FAIL: ${cfg.key} → ${e.message}`);
      try { await saveDebugSnapshot(page, rawCfg, 'error'); } catch {}
    }
  }

  await browser.close();

  // De-dup (title|desc|link)
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
