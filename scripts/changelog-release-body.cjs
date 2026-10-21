function isPrereleaseVersion(version) {
  return /-(?:beta|alpha|rc)(?:[.-]?\d+)?/i.test(String(version || ''));
}

function releaseTag(version) {
  const normalized = String(version || '').replace(/^v/iu, '');
  if (!normalized) {
    throw new Error('A package version is required to build release notes.');
  }
  return 'v' + normalized;
}

const DOWNLOAD_TAG_RE =
  /https:\/\/github\.com\/BurntToasters\/IYERIS\/releases\/download\/v[^/\s"'<>)]+\/[^\s"'<>)]+/giu;
const COMMENTED_BETA_NOTE_RE = /<!--\s*(>\s*\[!NOTE\][\s\S]*?This is a Beta build\.)\s*-->/iu;
const VISIBLE_BETA_NOTE_RE = /^>\s*\[!NOTE\][\s\S]*This is a Beta build\./imu;

function buildChangelogReleaseBody(changelog, version) {
  if (typeof changelog !== 'string' || !changelog.trim()) {
    throw new Error('CHANGELOG.md is empty; refusing to set blank release notes.');
  }
  const tag = releaseTag(version);
  let body = changelog;

  if (isPrereleaseVersion(version)) {
    body = body.replace(COMMENTED_BETA_NOTE_RE, '$1\n');
    if (!VISIBLE_BETA_NOTE_RE.test(body)) {
      throw new Error(
        'Beta release notes must include a visible GitHub beta warning before publishing.'
      );
    }
  }

  body = body.replace(DOWNLOAD_TAG_RE, (url) => {
    return url.replace(/\/download\/v[^/]+/u, '/download/' + tag);
  });

  const leftover = body.match(DOWNLOAD_TAG_RE) || [];
  const mismatched = leftover.filter((url) => !url.includes('/releases/download/' + tag + '/'));
  if (mismatched.length > 0) {
    throw new Error('Release notes still point at ' + mismatched[0] + '; expected ' + tag + '.');
  }
  return body;
}

module.exports = {
  buildChangelogReleaseBody,
  isPrereleaseVersion,
  releaseTag,
};
