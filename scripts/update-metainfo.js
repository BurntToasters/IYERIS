#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution } from './direct-execution.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function writeFileAtomic(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let ownsTemporaryPath = false;
  try {
    fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    ownsTemporaryPath = true;
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (ownsTemporaryPath) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The rename succeeded, so there is no temporary file left to clean.
      }
    }
  }
}

export function formatDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function withReleaseDate(tag, date) {
  if (/\bdate="[^"]*"/u.test(tag)) return tag.replace(/\bdate="[^"]*"/u, `date="${date}"`);
  return tag.replace(/<release\b[^>]*>/u, (openingTag) =>
    openingTag.endsWith('/>')
      ? openingTag.replace(/\s*\/>$/u, ` date="${date}"/>`)
      : openingTag.replace(/>$/u, ` date="${date}">`)
  );
}

export function updateMetainfoXml(xml, version, { now = new Date(), refreshDate = false } = {}) {
  const sectionMatch = xml.match(/^(\s*)<releases>\s*$([\s\S]*?)^\s*<\/releases>\s*$/mu);
  if (!sectionMatch) throw new Error('Could not locate <releases> block in AppStream metadata');
  const baseIndent = sectionMatch[1] || '';
  const releaseIndent = `${baseIndent}  `;
  const date = formatDate(now);
  const tags =
    sectionMatch[2].match(/<release\b[^>]*\/>|<release\b[^>]*>[\s\S]*?<\/release>/gu) || [];
  const versionPattern = /\bversion="([^"]+)"/u;
  let currentTag = null;
  const remaining = [];

  for (const rawTag of tags) {
    const tag = rawTag.trim();
    if (tag.match(versionPattern)?.[1] === version) {
      if (!currentTag) currentTag = refreshDate ? withReleaseDate(tag, date) : tag;
    } else {
      remaining.push(tag);
    }
  }

  currentTag ||= `<release version="${version}" date="${date}"/>`;
  const entries = [currentTag, ...remaining];
  const updatedSection = `${baseIndent}<releases>\n${entries
    .map((tag) => `${releaseIndent}${tag}`)
    .join('\n')}\n${baseIndent}</releases>`;
  const originalSection = sectionMatch[0];
  const updatedXml = xml.replace(originalSection, updatedSection);
  return { xml: updatedXml, updated: updatedXml !== xml, version, date };
}

export function run({ now = new Date(), refreshDate = false, root = repoRoot } = {}) {
  const packagePath = path.join(root, 'package.json');
  const xmlPath = path.join(root, 'run.rosie.iyeris.metainfo.xml');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (!packageJson.version) throw new Error('package.json has no version field');
  const result = updateMetainfoXml(fs.readFileSync(xmlPath, 'utf8'), packageJson.version, {
    now,
    refreshDate,
  });
  if (result.updated) writeFileAtomic(xmlPath, result.xml);
  return result;
}

if (isDirectExecution(import.meta.url)) {
  try {
    const result = run({ refreshDate: process.argv.includes('--refresh-date') });
    console.log(
      result.updated
        ? `Updated AppStream release ${result.version}`
        : `AppStream release ${result.version} already current`
    );
  } catch (error) {
    console.error(`Failed: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
