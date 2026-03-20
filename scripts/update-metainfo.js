#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, '..');
const pkgPath = path.join(repoRoot, 'package.json');
const xmlPath = path.join(repoRoot, 'com.burnttoasters.iyeris.metainfo.xml');

function formatDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function run({ now = new Date() } = {}) {
  if (!fs.existsSync(pkgPath)) throw new Error(`package.json not found at ${pkgPath}`);
  if (!fs.existsSync(xmlPath)) throw new Error(`AppStream metadata not found at ${xmlPath}`);

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse package.json: ${error?.message || error}`);
  }

  const version = pkg.version;
  if (!version) throw new Error('package.json has no version field');

  const dateStr = formatDate(now);
  const xml = fs.readFileSync(xmlPath, 'utf8');

  const releasesLineMatch = xml.match(/^(\s*)<releases>\s*$/m);
  if (!releasesLineMatch) throw new Error('Could not find <releases> block in AppStream metadata');

  const baseIndent = releasesLineMatch[1] || '';
  const releaseIndent = `${baseIndent}  `;
  const newReleaseTag = `${releaseIndent}<release version="${version}" date="${dateStr}"/>`;

  const releasesSectionRegex = /<releases>[\s\S]*?<\/releases>/;
  const releasesSectionMatch = xml.match(releasesSectionRegex);
  if (!releasesSectionMatch) throw new Error('Could not locate releases section');

  const releaseTagRegex = /<release\b[^>]*\/>|<release\b[^>]*>[\s\S]*?<\/release>/g;
  const releaseVersionRegex = /version="([^"]+)"/;
  const existingReleaseTags = releasesSectionMatch[0].match(releaseTagRegex) || [];

  const rebuiltEntries = [];
  let replacedCurrentVersion = false;
  for (const rawTag of existingReleaseTags) {
    const tag = rawTag.trim();
    const versionMatch = tag.match(releaseVersionRegex);
    const tagVersion = versionMatch ? versionMatch[1] : '';
    if (tagVersion === version) {
      if (!replacedCurrentVersion) {
        rebuiltEntries.push(newReleaseTag.trim());
        replacedCurrentVersion = true;
      }
      continue;
    }
    rebuiltEntries.push(tag);
  }
  if (!replacedCurrentVersion) rebuiltEntries.unshift(newReleaseTag.trim());

  const updatedSection = `<releases>\n${rebuiltEntries.map((tag) => `${releaseIndent}${tag}`).join('\n')}\n${baseIndent}</releases>`;
  if (updatedSection === releasesSectionMatch[0]) return { updated: false, version, date: dateStr };

  const updatedXml = xml.replace(releasesSectionRegex, updatedSection);
  fs.writeFileSync(xmlPath, updatedXml, 'utf8');
  return { updated: true, version, date: dateStr };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    const result = run();
    if (result.updated)
      console.log(`Updated AppStream release to ${result.version} (${result.date})`);
    else console.log('AppStream metadata already up to date');
  } catch (error) {
    console.error(`Failed: ${error?.message || error}`);
    process.exit(1);
  }
}

export { formatDate, run };
