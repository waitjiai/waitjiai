#!/usr/bin/env node
// Structural validation for web/ — no build system, no framework, so there's
// nothing else that would catch these classes of mistake before they ship.
// Each check here exists because it's exactly the kind of bug that actually
// shipped once: a sitemap that quietly stopped listing most of the site, a
// robots.txt Disallow that silently defeated a page's own noindex tag, and
// malformed inline JSON-LD/JS that a browser tolerates but a crawler or rich
// -result parser does not. Zero dependencies — plain Node only.
const fs = require('fs');
const path = require('path');

const WEB_DIR = path.join(__dirname, '..', 'web');
let failures = 0;

function fail(msg) {
  console.error('✖ ' + msg);
  failures++;
}
function ok(msg) {
  console.log('✔ ' + msg);
}

function listHtmlFiles() {
  const top = fs.readdirSync(WEB_DIR).filter(f => f.endsWith('.html')).map(f => path.join(WEB_DIR, f));
  const blogDir = path.join(WEB_DIR, 'blog');
  const blog = fs.existsSync(blogDir)
    ? fs.readdirSync(blogDir).filter(f => f.endsWith('.html')).map(f => path.join(blogDir, f))
    : [];
  return [...top, ...blog];
}

// Pages that are deliberately excluded from the sitemap/public index (auth,
// dashboards, admin) — keep this list in sync with the noindex tags/headers
// actually set on these files.
const EXCLUDED_FROM_SITEMAP = new Set([
  'login.html', 'advertiser.html', 'customer.html', 'admin.html', 'admin-login.html', 'api-instructions.html',
]);

function checkJsonLdBlocks(file, html) {
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m, count = 0;
  while ((m = re.exec(html))) {
    count++;
    try {
      JSON.parse(m[1]);
    } catch (e) {
      fail(`${path.relative(WEB_DIR, file)}: JSON-LD block #${count} does not parse — ${e.message}`);
    }
  }
  return count;
}

function checkInlineScripts(file, html) {
  // Only plain inline <script>...</script> blocks (no src=, no type= at all,
  // i.e. classic JS) — skip type="application/ld+json" (checked separately)
  // and any <script src="...">.
  const re = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g;
  let m, count = 0;
  while ((m = re.exec(html))) {
    const code = m[1].trim();
    if (!code) continue;
    count++;
    try {
      // eslint-disable-next-line no-new-func -- syntax check only, never executed
      new Function(code);
    } catch (e) {
      fail(`${path.relative(WEB_DIR, file)}: inline <script> block #${count} has a syntax error — ${e.message}`);
    }
  }
  return count;
}

function main() {
  const files = listHtmlFiles();
  let jsonLdBlocks = 0, scriptBlocks = 0;
  for (const file of files) {
    const html = fs.readFileSync(file, 'utf8');
    jsonLdBlocks += checkJsonLdBlocks(file, html);
    scriptBlocks += checkInlineScripts(file, html);
  }
  ok(`checked ${jsonLdBlocks} JSON-LD blocks and ${scriptBlocks} inline <script> blocks across ${files.length} HTML files`);

  // sitemap.xml: well-formed enough to parse, and covers every real public page.
  const sitemapPath = path.join(WEB_DIR, 'sitemap.xml');
  const sitemapXml = fs.readFileSync(sitemapPath, 'utf8');
  if (!sitemapXml.trim().startsWith('<?xml')) fail('sitemap.xml does not start with an XML declaration');
  const openTags = (sitemapXml.match(/<url>/g) || []).length;
  const closeTags = (sitemapXml.match(/<\/url>/g) || []).length;
  if (openTags === 0) fail('sitemap.xml has no <url> entries at all');
  if (openTags !== closeTags) fail(`sitemap.xml has mismatched <url>/</url> tags (${openTags} open, ${closeTags} close)`);
  const sitemapLocs = new Set([...sitemapXml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]));

  const publicPages = files
    .map(f => path.relative(WEB_DIR, f))
    .filter(rel => !EXCLUDED_FROM_SITEMAP.has(path.basename(rel)));
  for (const rel of publicPages) {
    const relUrl = rel === 'index.html' ? '' : rel.replace(/\\/g, '/');
    const expectedUrl = 'https://www.waitjiai.in/' + relUrl;
    if (!sitemapLocs.has(expectedUrl)) {
      fail(`sitemap.xml is missing a public page: ${expectedUrl} (add it, or add "${path.basename(rel)}" to EXCLUDED_FROM_SITEMAP in scripts/validate-web.js if it's meant to be unindexed)`);
    }
  }
  ok(`sitemap.xml covers all ${publicPages.length} public pages (${openTags} <url> entries)`);

  // robots.txt must not Disallow any URL that would defeat a page's own
  // noindex — a Disallow prevents the crawler from ever reading that tag.
  const robotsPath = path.join(WEB_DIR, 'robots.txt');
  const robotsTxt = fs.readFileSync(robotsPath, 'utf8');
  const disallows = [...robotsTxt.matchAll(/^Disallow:\s*(\S+)/gm)].map(m => m[1]);
  if (disallows.length > 0) {
    fail(`robots.txt has ${disallows.length} Disallow line(s) (${disallows.join(', ')}) — a Disallow'd page can never have its own noindex tag read by a crawler; use noindex meta/headers on the page itself instead`);
  } else {
    ok('robots.txt has no Disallow lines (pages that must stay unindexed rely on their own noindex tag/header instead)');
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll web/ structural checks passed.');
}

main();
