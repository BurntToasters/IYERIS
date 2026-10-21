/**
 * Keep the root crate's version in Cargo.lock aligned with Cargo.toml.
 * Cargo rewrites this on the next build; leaving it stale dirties the tree
 * mid-release and breaks locked builds.
 */
export function updateCargoLockPackageVersion(lockfile, packageName, version) {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(\\[\\[package\\]\\]\\r?\\nname = "${escapedName}"\\r?\\nversion = )"[^"]*"`
  );
  if (!pattern.test(lockfile)) {
    throw new Error(`Cargo.lock is missing [[package]] name = "${packageName}"`);
  }
  return lockfile.replace(pattern, `$1"${version}"`);
}

function parseReleaseSemver(version, target) {
  const match = version.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(beta)\.(0|[1-9]\d*))?$/
  );
  if (!match) {
    throw new Error(`Version cannot be represented as a ${target} version: ${version}`);
  }

  const [, major, minor, patch, stage, sequence] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    stage,
    prereleaseNumber: stage ? Number(sequence) : null,
  };
}

/**
 * Convert beta/stable SemVer into Apple's numeric-only CFBundleVersion.
 * Betas sort below the corresponding stable release.
 */
export function macBundleVersionFromSemver(version) {
  const parsed = parseReleaseSemver(version, 'macOS bundle');
  if (parsed.prereleaseNumber !== null && parsed.prereleaseNumber > 6998) {
    throw new Error(`macOS bundle prerelease sequence must be 0-6998: ${version}`);
  }

  let build = parsed.patch * 10_000;
  if (!parsed.stage) {
    build += 9999;
  } else {
    build += 3000 + parsed.prereleaseNumber;
  }
  return `${parsed.major}.${parsed.minor}.${build}`;
}

/** Apple's CFBundleShortVersionString accepts exactly three numeric fields. */
export function macMarketingVersionFromSemver(version) {
  const match = version.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(?:0|[1-9]\d*))?$/
  );
  if (!match) {
    throw new Error(`Version cannot be represented as a macOS marketing version: ${version}`);
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/** Replace exactly one string-valued plist key, failing closed on drift. */
export function updatePlistStringValue(plist, key, value) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(<key>${escapedKey}</key>\\s*<string>)[^<]*(</string>)`, 'g');
  const matches = plist.match(pattern);
  if (matches?.length !== 1) {
    throw new Error(
      `plist key ${key} must have exactly one string value; found ${matches?.length ?? 0}`
    );
  }
  return plist.replace(pattern, `$1${value}$2`);
}

/** Align the download table and release heading with package.json. */
export function syncChangelogForVersion(changelog, version) {
  const tag = `v${version}`;
  const sectionHeading = `## Changes in \`${tag}:\``;
  const tableStart = changelog.indexOf('# ⬇️ Downloads');
  if (tableStart === -1) {
    throw new Error('CHANGELOG.md download table marker not found');
  }

  const tableOffset = changelog.slice(tableStart).search(/\n(?:> |## |### )/u);
  if (tableOffset === -1) {
    throw new Error('CHANGELOG.md download table end marker not found');
  }

  const tableEnd = tableStart + tableOffset;
  const before = changelog.slice(0, tableStart);
  const table = changelog.slice(tableStart, tableEnd);
  const after = changelog.slice(tableEnd);
  const syncedTable = table.replace(
    /\/releases\/download\/v[^/]+\//g,
    `/releases/download/${tag}/`
  );
  let updated = before + syncedTable + after;

  if (!updated.includes(sectionHeading)) {
    const firstSectionOffset = updated.search(/^## Changes in `v[^`]+:`$/mu);
    if (firstSectionOffset === -1) {
      throw new Error('CHANGELOG.md release section insertion marker not found');
    }
    updated = `${updated.slice(0, firstSectionOffset)}${sectionHeading}\n\n- **Fix:** (add release notes)\n\n${updated.slice(firstSectionOffset)}`;
  }

  return updated;
}

/** Keep both npm lockfile version fields aligned with package.json. */
export function syncNpmLockfileVersion(lockText, version) {
  let parsed;
  try {
    parsed = JSON.parse(lockText);
  } catch (error) {
    throw new Error(
      `package-lock.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('package-lock.json root must be an object');
  }
  if (!parsed.packages || typeof parsed.packages !== 'object') {
    throw new Error('package-lock.json is missing packages');
  }
  if (!parsed.packages[''] || typeof parsed.packages[''] !== 'object') {
    throw new Error('package-lock.json is missing packages[""]');
  }
  if (parsed.version === version && parsed.packages[''].version === version) {
    return lockText;
  }
  parsed.version = version;
  parsed.packages[''].version = version;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
