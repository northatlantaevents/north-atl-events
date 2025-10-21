import { chromium } from '@playwright/test';
import { XMLBuilder } from 'fast-xml-parser';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

// ------------ config / constants ------------
const SITES = JSON.parse(fs.readFileSync('./sites.json', 'utf8'));
const OUT_DIR = path.join(process.cwd(), 'docs');
const OUT_FILE = path.join(OUT_DIR, 'feed.xml');
const DEBUG_DIR = path.join(OUT_DIR, 'debug');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// ------------ tiny helpers ------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (v) => (typeof v === 'string' ? v.trim() : (v ?? '') + '');
const toAbs = (href, base) => {
  try { return new URL(href, base).href; } catch { return href || base; }
};
const norm = (s) => safe(s).toLowerCase().replace(/\s+/g, ' ').trim();
const rfc822 = (d) => (d ? new Date(d) : new Date()).toUTCString();
const isImg = (u) => /\.(png|jpe?g|gif|webp|avif)(\?.*)?$/i.test(u || '');
const cdata = (s) => `<![CDATA[${s || ''}]]>`;
const pickFirstFromSrcset = (srcset) => {
  if (!srcset) return '';
  const first = srcset.split(',')[0] || '';
  return first.trim().split(/\s+/)[0] || '';
};

// deep getter: "venue.name" → obj.venue.name
const pick = (obj, pathStr) => {
  if (!pathStr) return undefined;
  return pathStr.split('.').reduce((o, k) => (o && (k in o) ? o[k] : undefined), obj);
};

// choose the first selector that actually exists on the page
async function firstExistingSelector(page, candidates, timeoutMs = 8000) {
  if (!candidates) return null;
  const list = candidates.split(',').map((s) => s.trim()).filter(Boolean);
  const start = Date.now();
  for (;;) {
    for (const sel of list) {
      try {
        const count = await page.locator(sel).count();
        if (count > 0) return sel;
      } catch (_) {}
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

// ------------ RSS builder ------------
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
        item: items.map((i) => {
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
                ? `image/${i.image.split('.').pop().toLowerCase().replace('jpg', 'jpeg')}`
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

// ------------ scrapers by mode ------------
async function scrapeDOM(page, cfg) {
  const waitMs = cfg.waitMs ?? 2000;

  await page.goto(cfg.url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await sleep(waitMs); // allow lazy loaders to fire

  const itemSel = await firstExistingSelector(page, cfg.item, 8000);
  if (!itemSel) return { items: [], debug: { itemSelectorChosen: null, itemCount: 0 } };

  const cards = await page.locator(itemSel).elementHandles();
  const take = Math.min(cards.length, cfg.max || 120);
  const out = [];

  for (let i = 0; i < take; i++) {
    const el = cards[i];

    // title
    let title = '';
    if (cfg.title) {
      for (const tSel of cfg.title.split(',').map((s) => s.trim())) {
        const tEl = await el.$(tSel);
        title = await innerTextSafe(tEl);
        if (title) break;
      }
    }

    // link
    let href = '';
    if (cfg.link) {
      for (const aSel of cfg.link.split(',').map((s) => s.trim())) {
        const aEl = await el.$(aSel);
        if (aEl) {
          href = safe(await aEl.getAttribute('href'));
          if (href) break;
        }
      }
    }
    if (href && href.startsWith('/')) href = toAbs(href, cfg.url);

    // date
    let date = '';
    if (cfg.date) {
      for (const dSel of cfg.date.split(',').map((s) => s.trim())) {
        const dEl = await el.$(dSel);
        if (dEl) {
          try { date = safe(await dEl.innerText()); } catch {}
          if (date) break;
        }
      }
    }

    // image
    let imageUrl = '';
    if (cfg.image) {
      for (const iSel of cfg.image.split(',').map((s) => s.trim())) {
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

        let [src, dataSrc, dataOrig, dataLazy, dataImage, srcset, styleAttr] = cand.map((x) => safe(x));
        if (!src && srcset) src = pickFirstFromSrcset(srcset);
        if (!src && styleAttr) {
          const m = styleAttr.match(/background-image:\s*url\((['"]?)([^'")]+)\1\)/i);
          if (m && m[2]) src = m[2];
        }
        imageUrl = toAbs(src || dataSrc || dataOrig || dataLazy || dataImage || '', cfg.url);
        if (imageUrl) break;
      }
    }

    if (!title && !href) continue;

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

async function scrapeJSONLD(page, cfg) {
  await page.goto(cfg.url, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(cfg.waitMs ?? 1000);

  const scripts = await page.$$eval('script[type="application/ld+json"]', (els) =>
    els.map((e) => e.textContent || '')
  );

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
        if (Array.isArray(node.event)) {
          node.event.forEach((e) => { if (e['@type'] === 'Event') events.push(e); });
        }
      }
    } catch (_) {}
  }

  const out = events.map((e) => {
    const title = safe(e.name);
    const url = toAbs(safe(e.url) || cfg.url, cfg.url);
    const start = safe(e.startDate || e.startTime);
    const venue = safe(e?.location?.name || cfg.venue);

    // image can be string/object/array
    let img = '';
    const rawImg = e.image;
    if (typeof rawImg === 'string') img = rawImg;
    else if (rawImg && typeof rawImg === 'object' && rawImg.url) img = rawImg.url;
    else if (Array.isArray(rawImg) && rawImg.length) {
      const first = rawImg[0];
      img = typeof first === 'string' ? first : (first?.url || '');
    }
    img = toAbs(safe(img), cfg.url);

    return {
      title: (cfg.town ? `[${cfg.town}] ` : '') + title,
      link: url,
      guid: url + '#' + norm(title) + '#' + norm(start),
      pubDate: rfc822(start),
      description: [venue, start].filter(Boolean).join(' — '),
      image: img
    };
  });

  return out;
}

async function scrapeJSON(cfg) {
  const res = await fetch(cfg.api, {
    headers: { 'user-agent': USER_AGENT, 'accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`JSON ${res.status} ${cfg.api}`);
  const data = await res.json();

  // Map array: use cfg.map.path (e.g., "events") or assume the whole JSON is an array
  const list = Array.isArray(pick(data, cfg.map?.path))
    ? pick(data, cfg.map.path)
    : (Array.isArray(data) ? data : []);

  return list.map((e) => {
    const title = safe(cfg.map?.title ? pick(e, cfg.map.title) : (e.title || e.name));
    const link  = toAbs(
      safe(cfg.map?.link ? pick(e, cfg.map.link) : (e.url || e.link)) || cfg.api,
      cfg.api
    );
    const date  = safe(cfg.map?.date ? pick(e, cfg.map.date) : (e.start_date || e.start || e.date || ''));
    const venue = safe(cfg.map?.venue ? pick(e, cfg.map.venue) : (e?.venue?.name || e.venue || cfg.venue || ''));

    let img = '';
    if (cfg.map?.image) {
      img = safe(pick(e, cfg.map.image) || '');
    } else {
      img = safe(e.image || e.featured_image || (Array.isArray(e.images) ? e.images[0] : ''));
    }
    img = toAbs(img, link);

    return {
      title: (cfg.town ? `[${cfg.town}] ` : '') + title,
      link,
      guid: link + '#' + norm(title) + '#' + norm(date),
      pubDate: rfc822(date),
      description: [venue, date].filter(Boolean).join(' — '),
      image: img
    };
  });
}

async function scrapeICS(cfg) {
  const res = await fetch(cfg.ics, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`ICS ${res.status} ${cfg.ics}`);
  const text = await res.text();

  const events = text.split('BEGIN:VEVENT').slice(1).map((block) => {
    const get = (k) => (block.match(new RegExp(`${k}:(.*)`)) || [, ''])[1].trim();
    const summary = get('SUMMARY');
    const url = get('URL') || cfg.ics;
    const dtstart = get('DTSTART') || '';
    const venue = get('LOCATION') || cfg.venue || '';
    return { summary, url, dtstart, venue };
  });

  return events.map((ev) => ({
    title: (cfg.town ? `[${cfg.town}] ` : '') + safe(ev.summary),
    link: toAbs(ev.url || cfg.ics, cfg.ics),
    guid: (ev.url || cfg.ics) + '#' + norm(ev.summary) + '#' + norm(ev.dtstart),
    pubDate: rfc822(ev.dtstart),
    description: [ev.venue, ev.dtstart].filter(Boolean).join(' — '),
    image: '' // ICS rarely contains images
  }));
}

// save page HTML to debug empty results
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

// ------------ main ------------
(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
  const page = await ctx.newPage();

  const items = [];

  for (const cfg of SITES) {
    try {
      let part = [];

      if (cfg.mode === 'dom') {
        const result = await scrapeDOM(page, cfg);
        part = result.items;
        if ((part?.length || 0) === 0) {
          // fallback to JSON-LD if DOM yielded nothing
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
        part = await scrapeICS(cfg);
      } else {
        console.warn(`Unknown mode for ${cfg.key}`);
        continue;
      }

      items.push(...part);
      console.log(`OK: ${cfg.key} → ${part.length} items`);
    } catch (e) {
      console.error(`FAIL: ${cfg.key} → ${e.message}`);
      try { await saveDebugSnapshot(page, cfg, 'error'); } catch (_) {}
    }
  }

  await browser.close();

  // de-dup (title|desc|link)
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
