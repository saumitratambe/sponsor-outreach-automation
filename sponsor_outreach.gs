/**********************************************************
 * SponsorTool.gs (clean & hardened build)
 * Sheets required:
 *  - config (A:key, B:value)  keys: daily_cap, pause_flag, sender_email, fu_days, cse_id, cse_key, active_niche
 *  - leads_raw (A:brand, B:website, C:found_email, D:source_url, E:discovered_at)
 *  - leads (A:lead_id, B:brand, C:website, D:email, E:status, F:sequence_stage, G:queued_at, H:sent_at)
 *  - rules (optional)
 *  - suppressed (A:domain, B:reason, C:added_at)
 *  - niche (A:niche, B:queries (comma), C:include (comma), D:exclude (comma))
 **********************************************************/

/* =========================
   CONFIG HELPERS
========================= */

function getConfigValue(key) {
  const ss = SpreadsheetApp.getActive();
  const cfg = ss.getSheetByName('config');
  if (!cfg) throw new Error('Missing sheet: config');
  const last = cfg.getLastRow();
  if (last < 2) return '';
  const rows = cfg.getRange(2,1,last-1,2).getValues();
  for (let i=0;i<rows.length;i++){
    if (String(rows[i][0]).trim().toLowerCase() === String(key).trim().toLowerCase()) {
      return String(rows[i][1]).trim();
    }
  }
  return '';
}

function _getActiveNiche() {
  const s = String(getConfigValue('active_niche') || '').trim().toLowerCase();
  return s || 'general';
}

function _getFollowupDays() {
  const raw = String(getConfigValue('fu_days') || '3,7').trim();
  const parts = raw.split(',').map(x => Number(x.trim())||0);
  return [parts[0]||3, parts[1]||7];
}

/* =========================
   BRAND & URL HELPERS
========================= */

function _normalizeUrl_(u) {
  u = String(u||'').trim();
  if (!u) return '';
  // collapse many protocols to https
  u = u.replace(/^(?:\w+:\/\/)+/i,'https://');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  // normalize double slashes
  u = u.replace(/([^:]\/)\/+/g, '$1');
  return u;
}

function _cleanDomain_(urlOrDomain) {
  try {
    const u = new URL(_normalizeUrl_(urlOrDomain));
    return u.hostname.replace(/^www\./,'').toLowerCase();
  } catch(e) {
    return String(urlOrDomain||'')
      .replace(/^https?:\/\//,'')
      .replace(/^www\./,'')
      .split('/')[0]
      .toLowerCase();
  }
}

// Title → brand (remove “About/Contact/…” words, punctuation, title-case)
function _cleanTitleToBrand_(s) {
  s = String(s||'').trim();
  // remove boilerplate words
  s = s.replace(/\b(about|contact|support|help|press|blog|news|media|affiliate|affiliates|partner|partners|partnership|team|policy|privacy|terms|sponsorship|marketing|manager)\b/gi,' ');
  // kill separators & symbols
  s = s.replace(/[|–—\-•:_]+/g,' ').replace(/&nbsp;/gi,' ').replace(/\s{2,}/g,' ').trim();
  if (s.length < 2) return '';
  // Title Case
  s = s.split(' ').map(w => w ? (w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()) : '').join(' ').trim();
  return s;
}

// Domain → brand (smart: skip social domains, strip subdomain labels, remove Inc/LLC, etc.)
function _brandFromDomain_(urlOrDomain) {
  const d = _cleanDomain_(urlOrDomain);
  const skip = [
    'reddit.com','facebook.com','instagram.com','twitter.com','x.com','linkedin.com',
    'youtube.com','medium.com','github.com','notion.site','google.com','mailchimp.com',
    'eventbrite.com','play.google.com','apps.apple.com','support.google.com','help.line.me',
    'wix.com','wixpress.com','sentry.io'
  ];
  if (!d || skip.some(s => d.endsWith(s))) return '';

  // take first label up to TLD, but drop obvious non-brand subdomains
  let core = d.split('.').slice(0,-1).join('.') || d.split('.')[0];
  core = core.replace(/^(cdn|app|dev|blog|en|jp|kr|in|uk|de|fr|es|it|eu|shop|store|info|support|help|about)$/i,'');
  core = core || d.split('.')[0];

  // turn hyphen/camel to words; strip corporate suffixes
  let words = core.split(/[\.-_]+/g).map(w => w ? (w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()) : '').join(' ');
  words = words.replace(/\b(Inc|Co|Corp|LLC|Ltd|GmbH|SAS|SA|PLC)\b/gi,'').replace(/\s{2,}/g,' ').trim();
  return words;
}

// Try best brand: provided string → title clean; else derive from domain/title
function _prettyBrand_(brand, fallbackUrl) {
  let b = _cleanTitleToBrand_(brand);
  if (!b && fallbackUrl) {
    // try from domain
    b = _brandFromDomain_(fallbackUrl);
  }
  // final safety trims
  b = String(b||'').replace(/\s{2,}/g,' ').trim();
  return b;
}

/* =========================
   SUPPRESSION HELPERS
========================= */

function _domainOf_(uOrEmail) {
  try {
    if (String(uOrEmail||'').includes('@')) return String(uOrEmail).split('@').pop().toLowerCase();
    const u = new URL(_normalizeUrl_(uOrEmail));
    return u.hostname.replace(/^www\./,'').toLowerCase();
  } catch(e) {
    return String(uOrEmail||'')
      .replace(/^https?:\/\//,'')
      .replace(/^www\./,'')
      .split('/')[0]
      .toLowerCase();
  }
}

function _loadSuppressed_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName('suppressed') || ss.insertSheet('suppressed');
  if (sh.getLastRow() < 1) sh.getRange(1,1,1,3).setValues([[ 'domain','reason','added_at' ]]);
  const last = sh.getLastRow();
  const set = new Set();
  if (last >= 2) sh.getRange(2,1,last-1,1).getValues().forEach(r => set.add(String(r[0]||'').toLowerCase()));
  return set;
}

/* =========================
   NICHE QUERIES
========================= */

function _getQueriesForActiveNiche() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName('niche');
  const active = _getActiveNiche();
  if (!sh) return ['brand partnerships contact email','sponsorship inquiry email'];

  const last = sh.getLastRow();
  if (last < 2) return ['brand partnerships contact email','sponsorship inquiry email'];

  const rows = sh.getRange(2,1,last-1,4).getValues(); // A:niche B:queries C:include D:exclude
  for (let i=0;i<rows.length;i++){
    const n   = String(rows[i][0]||'').trim().toLowerCase();
    if (n !== active) continue;
    const qs  = String(rows[i][1]||'').trim().split(',').map(s=>s.trim()).filter(Boolean);
    const inc = String(rows[i][2]||'').trim();
    const exc = String(rows[i][3]||'').trim();
    if (!qs.length) break;
    // weave include/exclude to each query
    const cooked = qs.map(q => {
      let base = q;
      if (inc) base += ' ' + inc.split(',').map(w=>`"${w.trim()}"`).join(' ');
      if (exc) base += ' ' + exc.split(',').map(w=>`-"${w.trim()}"`).join(' ');
      return base;
    });
    return cooked;
  }
  return ['brand partnerships contact email','sponsorship inquiry email'];
}

/* =========================
   CUSTOM SEARCH COLLECTOR
========================= */

function cseSearch_(query, maxNum) {
  const key = getConfigValue('cse_key');
  const cx  = getConfigValue('cse_id');
  const num = Math.min(Math.max(Number(maxNum)||10, 1), 10); // API max 10
  const url = 'https://customsearch.googleapis.com/customsearch/v1'
    + '?key=' + encodeURIComponent(key)
    + '&cx='  + encodeURIComponent(cx)
    + '&q='   + encodeURIComponent(query)
    + '&num=' + num;

  try {
    const res  = UrlFetchApp.fetch(url, { muteHttpExceptions:true });
    const code = res.getResponseCode();
    if (code !== 200) { Logger.log('CSE HTTP '+code+': '+res.getContentText()); return []; }
    const json = JSON.parse(res.getContentText() || '{}');
    if (json.error) { Logger.log('CSE API error: '+JSON.stringify(json.error)); return []; }
    return (json.items || []).map(it => it.link);
  } catch (e) {
    Logger.log('CSE exception: '+e.message);
    return [];
  }
}

// try a few pages, pull emails with regex; block images, beacons
function fetchEmailsFromUrl_(url) {
  const emails = new Set();
  const tryUrls = [url];
  try {
    const u = new URL(url);
    const base = u.origin;
    ['/','/contact','/contact-us','/about','/about-us','/support','/privacy','/team','/partners','/affiliate'].forEach(p => {
      tryUrls.push(base + p);
    });
  } catch(e) {}

  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

  for (let i=0;i<tryUrls.length;i++){
    try {
      const html = UrlFetchApp.fetch(tryUrls[i], { followRedirects:true, muteHttpExceptions:true, timeout: 15000 }).getContentText();
      const found = html.match(re) || [];
      found.forEach(e => {
        const clean = String(e).toLowerCase().replace(/\s/g,'');
        const isImageName = /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(clean);
        const isBeacon = /@sentry\.io$|@sentry[-\w]*\.wixpress\.com$/i.test(clean);
        if (isImageName || isBeacon) return;
        emails.add(clean);
      });
    } catch(e) {}
  }
  return Array.from(emails);
}

/* =========================
   1) COLLECT → leads_raw
========================= */

function CollectLeads() {
  const ss = SpreadsheetApp.getActive();
  const raw = ss.getSheetByName('leads_raw') || ss.insertSheet('leads_raw');
  if (raw.getLastRow() < 1) raw.getRange(1,1,1,5).setValues([[ 'brand','website','found_email','source_url','discovered_at' ]]);

  const queries = _getQueriesForActiveNiche();
  let rows = [];
  for (let q of queries) {
    const links = cseSearch_(q, 8);
    links.forEach(link => {
      const site = _normalizeUrl_(link);
      const emails = fetchEmailsFromUrl_(link);
      const now = new Date();
      const brand = _prettyBrand_('', site); // we’ll refine during curate
      if (!emails.length) rows.push([brand, site, '', link, now]);
      emails.forEach(em => rows.push([brand, site, em, link, now]));
    });
  }

  if (rows.length) {
    const last = raw.getLastRow();
    raw.insertRowsAfter(Math.max(1,last), rows.length);
    raw.getRange(last+1,1,rows.length,5).setValues(rows);
  }
  SpreadsheetApp.getActive().toast('Collected: '+rows.length+' raw rows', 'CollectLeads', 5);
}

/* =========================
   2) ENRICH + CURATE → leads
========================= */

function EnrichAndCurate() {
  const ss = SpreadsheetApp.getActive();
  const raw = ss.getSheetByName('leads_raw');
  const leads = ss.getSheetByName('leads') || ss.insertSheet('leads');
  if (leads.getLastRow() < 1) leads.getRange(1,1,1,8).setValues([[ 'lead_id','brand','website','email','status','sequence_stage','queued_at','sent_at' ]]);
  if (!raw || !leads) return;

  const rawLast = raw.getLastRow();
  if (rawLast < 2) { SpreadsheetApp.getActive().toast('No raw leads','Curate',5); return; }

  const data = raw.getRange(2,1,rawLast-1,5).getValues(); // brand|site|found_email|source_url|discovered_at
  const leadsLast = leads.getLastRow();
  const existingEmails = new Set();
  if (leadsLast >= 2) {
    leads.getRange(2,4,leadsLast-1,1).getValues().forEach(r => existingEmails.add(String(r[0]||'').toLowerCase()));
  }

  const suppressed = _loadSuppressed_();
  const batchEmails = new Set();
  const batchDomains = new Set();

  let nextId = (leadsLast >= 2)
    ? Math.max.apply(null, leads.getRange(2,1,leadsLast-1,1).getValues().map(r => Number(r[0])||0)) + 1
    : 1;

  const out = [];
  const badHosts = [
    'sentry.io','wixpress.com','wix.com','sentry-next.wixpress.com',
    'play.google.com','apps.apple.com','support.google.com','help.line.me',
    'facebook.com','twitter.com','x.com','linkedin.com','youtube.com',
    'medium.com','github.com','notion.site','mailchimp.com','eventbrite.com'
  ];
  const rejectRoles = /(no-?reply|abuse|security|postmaster|daemon|bounce)@/i;

  const niche = _getActiveNiche();

  for (let r of data) {
    const rawSite = String(r[1]||'').trim();
    const site = _normalizeUrl_(rawSite);
    let email = String(r[2]||'').toLowerCase().trim();
    // Prefer partner/affiliate/marketing sorts (soft pass on info/support later)
    if (rejectRoles.test(email)) continue;

    // host filters
    let host = '';
    try { host = new URL(site).hostname.replace(/^www\./,'').toLowerCase(); } catch(e) {}
    if (host && badHosts.some(b => host.endsWith(b))) continue;

    // optional niche filters for TLDs
    if (['anime','gaming','manhwa','manga','webtoon'].includes(niche)) {
      if (/\.(edu|mil)$/i.test(host)) continue;
    }

    // domain suppression
    const dom = email ? _domainOf_(email) : (host||'');
    if (dom && suppressed.has(dom)) continue;

    // batch de-dupe: by domain and by email
    if (email) {
      if (batchEmails.has(email) || existingEmails.has(email)) continue;
    }
    if (host) {
      if (batchDomains.has(host)) continue;
      batchDomains.add(host);
    }

    // brand
    let brand = _prettyBrand_(String(r[0]||'').trim(), site);
    if (!brand) brand = _brandFromDomain_(site);

    // minimal quality: skip empty email if we already captured another from same host (handled by domain set)
    if (!email) {
      // allow a host row with blank email once; useful for manual follow-up
      // but don’t allow many blanks from same host (domain set already prevents)
    }

    // accept
    if (email) batchEmails.add(email);
    out.push([ nextId++, brand, site, email, 'new', 0, '', '' ]);
  }

  if (out.length) {
    leads.insertRowsAfter(leadsLast || 1, out.length);
    leads.getRange((leadsLast||1)+1, 1, out.length, 8).setValues(out);
  }
  SpreadsheetApp.getActive().toast('Added to leads: '+out.length, 'Curate', 5);
}

/* =========================
   3) AUTO SEND (first touch)
========================= */

function _pickTemplateFor(niche, stageIndex) {
  // stageIndex: 0 = first touch, 1 = FU1, 2 = FU2
  const common = {
    subject: 'Collaboration Inquiry – {{ brand }}',
    body:
`Hi {{ brand }} Team,

I run User on YouTube. We help viewers discover high-quality manhwa/manga stories.
We’re exploring brand partnerships and thought {{ brand }} may be a good fit.

Would you be open to a short conversation?

Warm regards,
User`
  };

  const fu1 = {
    subject: 'Re: {{ subject }}',
    body:
`Hi {{ brand }} Team,

Just following up on my earlier note about a possible collaboration.
If now isn’t a fit, no worries—happy to reconnect later.

Thanks,
User`
  };

  const fu2 = {
    subject: 'Re: {{ subject }}',
    body:
`Hi {{ brand }} Team,

Last quick nudge from me. If you’d like to explore a sponsorship later, just email anytime.
Appreciate your time!

User`
  };

  return [common, fu1, fu2][stageIndex] || common;
}

function _render(tpl, vars) {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_,k)=> (vars[k]||''));
}

function autoSend() {
  const ss = SpreadsheetApp.getActive();
  const leads = ss.getSheetByName('leads');
  const state = ss.getSheetByName('state') || ss.insertSheet('state');
  if (state.getLastRow() < 2) state.getRange(1,1,2,2).setValues([[ 'key','value' ],[ 'today_sent', 0 ]]);

  const dailyCap = Number(getConfigValue('daily_cap') || 20);
  const paused   = String(getConfigValue('pause_flag')||'0').trim() === '1';
  if (paused) { SpreadsheetApp.getActive().toast('Paused','autoSend',5); return; }

  const last = leads.getLastRow();
  if (last < 2) return;

  let todaySent = Number(state.getRange('B2').getValue() || 0);
  const rows = leads.getRange(2,1,last-1,8).getValues();
  const niche = _getActiveNiche();

  for (let i=0;i<rows.length;i++){
    if (todaySent >= dailyCap) break;

    const rowNum  = i+2;
    const brand   = String(rows[i][1]||'').trim();
    const email   = String(rows[i][3]||'').trim();
    const status  = String(rows[i][4]||'').trim().toLowerCase();
    const stage   = Number(rows[i][5]||0);

    if (!email || status === 'sent') continue;

    const tpl = _pickTemplateFor(niche, 0);
    const subject = _render(tpl.subject, { brand });
    const body    = _render(tpl.body,    { brand, subject });

    GmailApp.sendEmail(email, subject, body);

    leads.getRange(rowNum,5).setValue('sent');
    leads.getRange(rowNum,6).setValue(0);
    leads.getRange(rowNum,7).setValue(new Date());
    state.getRange('B2').setValue(++todaySent);

    SpreadsheetApp.getActive().toast('Auto Sent → '+email, 'Success', 3);
  }
}

function resetDailyCounter() {
  const state = SpreadsheetApp.getActive().getSheetByName('state') || SpreadsheetApp.getActive().insertSheet('state');
  if (state.getLastRow() < 2) state.getRange(1,1,2,2).setValues([[ 'key','value' ],[ 'today_sent', 0 ]]);
  state.getRange('B2').setValue(0);
}

/* =========================
   4) FOLLOW-UPS (stage 1 & 2)
========================= */

function _daysSince(dateCell) {
  if (!dateCell) return 9999;
  const then = new Date(dateCell);
  const now  = new Date();
  return Math.floor((now.getTime()-then.getTime())/(1000*60*60*24));
}

function sendFollowUps() {
  const ss  = SpreadsheetApp.getActive();
  const sh  = ss.getSheetByName('leads');
  if (!sh) return;
  const fuDays = _getFollowupDays();

  const last = sh.getLastRow();
  if (last < 2) return;
  const rows = sh.getRange(2,1,last-1,8).getValues();

  for (let i=0;i<rows.length;i++){
    const rowNum = i+2;
    let brand = String(rows[i][1]||'').trim();
    brand = _prettyBrand_(brand, String(rows[i][2]||''));
    const email  = String(rows[i][3]||'').trim();
    const status = String(rows[i][4]||'').trim().toLowerCase();
    const stage  = Number(rows[i][5]||0);
    const sentAt = rows[i][7];

    if (status !== 'sent' || !email.includes('@')) continue;
    const days = _daysSince(sentAt);

    // FU1
    if (stage === 0 && days >= (fuDays[0]||3)) {
      const tpl = _pickTemplateFor(_getActiveNiche(), 1);
      const subject = _render(tpl.subject, { brand, subject: 'Collaboration Inquiry – '+brand });
      const body    = _render(tpl.body,    { brand });
      GmailApp.sendEmail(email, subject, body);
      sh.getRange(rowNum,6).setValue(1);
      sh.getRange(rowNum,8).setValue(new Date());
      SpreadsheetApp.getActive().toast('FU1 sent → '+email,'Follow-up',3);
      continue;
    }

    // FU2
    if (stage === 1 && days >= (fuDays[1]||7)) {
      const tpl = _pickTemplateFor(_getActiveNiche(), 2);
      const subject = _render(tpl.subject, { brand, subject: 'Collaboration Inquiry – '+brand });
      const body    = _render(tpl.body,    { brand });
      GmailApp.sendEmail(email, subject, body);
      sh.getRange(rowNum,6).setValue(2);
      sh.getRange(rowNum,8).setValue(new Date());
      SpreadsheetApp.getActive().toast('FU2 sent → '+email,'Follow-up',3);
      continue;
    }
  }
}

/* =========================
   5) REPLY DETECTOR → suppress domain
========================= */

function RepliesSync() {
  const ss = SpreadsheetApp.getActive();
  const cfg = ss.getSheetByName('config');
  const leadsSheet = ss.getSheetByName('leads');
  if (!leadsSheet) return;
  const lastRow = leadsSheet.getLastRow();
  if (lastRow < 2) return;

  const me = String(cfg.getRange('B3').getValue()||'').trim() || Session.getActiveUser().getEmail();
  const data = leadsSheet.getRange(2,1,lastRow-1,8).getValues(); // A..H

  for (let i=0;i<data.length;i++){
    const rowNum = i+2;
    const email  = String(data[i][3]||'').trim();
    const status = String(data[i][4]||'').trim().toLowerCase();
    const stage  = Number(data[i][5]||0);
    if (!email || status !== 'sent') continue;

    const query = 'to:'+email+' newer_than:30d -in:drafts';
    const threads = GmailApp.search(query, 0, 20);
    let replied = false;
    threads.forEach(t => {
      const msgs = t.getMessages();
      for (let m=0;m<msgs.length;m++){
        const msg = msgs[m];
        const from = String(msg.getFrom()||'').toLowerCase();
        const to   = String(msg.getTo()||'').toLowerCase();
        const isThem = from.includes('@') && !from.includes(me.toLowerCase());
        const isReplyToUs = to.includes(me.toLowerCase());
        if (isThem && isReplyToUs) { replied = true; break; }
      }
    });

    if (replied) {
      leadsSheet.getRange(rowNum,5).setValue('replied');
      // suppress entire domain going forward
      const dom = _domainOf_(email);
      const sup = ss.getSheetByName('suppressed') || ss.insertSheet('suppressed');
      sup.appendRow([ dom, 'replied', new Date() ]);
    }
  }
}

/* =========================
   OPTIONAL: Pause/Resume
========================= */
function pauseBot(){ const cfg=SpreadsheetApp.getActive().getSheetByName('config'); cfg.getRange('B2').setValue(1); }
function resumeBot(){ const cfg=SpreadsheetApp.getActive().getSheetByName('config'); cfg.getRange('B2').setValue(0); }
