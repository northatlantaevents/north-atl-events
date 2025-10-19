import { chromium } from '@playwright/test';
import { XMLBuilder } from 'fast-xml-parser';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

const SITES = JSON.parse(fs.readFileSync('./sites.json','utf8'));
const OUT_DIR = path.join(process.cwd(), 'docs');
const OUT_FILE = path.join(OUT_DIR, 'feed.xml');
const USER_AGENT = 'Mozilla/5.0 (NorthATL-EventsBot; +https://example.com)';

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

async function scrapeDOM(page, cfg) {
  await page.goto(cfg.url, { waitUntil: 'networkidle', timeout: 60000 });
  if (cfg.waitMs) await sleep(cfg.waitMs);
  const cards = await page.locator(cfg.item).elementHandles();
  const take = Math.min(cards.length, cfg.max || 120);
  const out = [];
  for (let i = 0; i < take; i++) {
    const el = cards[i];
    const tEl = await el.$(cfg.title);
    const aEl = await el.$(cfg.link);
    const dEl = await el.$(cfg.date);

    const title = tEl ? safe(await (await tEl.getProperty('innerText')).jsonValue()) : '';
    let href = aEl ? safe(await (await aEl.getAttribute('href'))) : '';
    if (href.startsWith('/')) href = toAbs(href, cfg.url);
    const date = dEl ? safe(await (await dEl.innerText()).trim()) : '';

    if (!title && !href) continue;
    out.push({
      title: (cfg.town ? `[${cfg.town}] ` : '') + title,
      link: href || cfg.url,
      guid: (href || cfg.url) + '#' + norm(title) + '#' + norm(date),
      pubDate: rfc822(date),
      description: [cfg.venue, date].filter(Boolean).join(' — ')
    });
  }
  return out;
}

async function scrapeJSONLD(page, cfg) {
  await page.goto(cfg.url, { waitUntil: 'networkidle', timeout: 60000 });
  if (cfg.waitMs) await sleep(cfg.waitMs);
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
  return events.map(e => {
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

async function scrapeICS(cfg) {
  const res = await fetch(cfg.ics, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`ICS ${res.status} ${cfg.ics}`);
  const text = await res.text();
  const events = text.split('BEGIN:VEVENT').slice(1).map(block => {
    const get = (k) => (block.match(new RegExp(`${k}:(.*)`)) || [,''])[1].trim();
    const summary = get('SUMMARY');
    const url = get('URL') || cfg.ics;
    const dtstart = get('DTSTART') || '';
    const venue = get('LOCATION') || cfg.venue || '';
    return { summary, url, dtstart, venue };
  });
  return events.map(ev => ({
    title: (cfg.town ? `[${cfg.town}] ` : '') + safe(ev.summary),
    link: toAbs(ev.url || cfg.ics, cfg.ics),
    guid: (ev.url || cfg.ics) + '#' + norm(ev.summary) + '#' + norm(ev.dtstart),
    pubDate: rfc822(ev.dtstart),
    description: [ev.venue, ev.dtstart].filter(Boolean).join(' — ')
  }));
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: USER_AGENT });
  const page = await ctx.newPage();

  const items = [];
  for (const cfg of SITES) {
    try {
      let part = [];
      if (cfg.mode === 'dom') part = await scrapeDOM(page, cfg);
      else if (cfg.mode === 'jsonld') part = await scrapeJSONLD(page, cfg);
      else if (cfg.mode === 'json')) part = await scrapeJSON(cfg);
      else if (cfg.mode === 'ics') part = await scrapeICS(cfg);
      else { console.warn(`Unknown mode for ${cfg.key}`); continue; }

      items.push(...part);
      console.log(`OK: ${cfg.key} → ${part.length} items`);
    } catch (e) {
      console.error(`FAIL: ${cfg.key} → ${e.message}`);
    }
  }

  await browser.close();

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
