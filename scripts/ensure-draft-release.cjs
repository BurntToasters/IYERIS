// For some reason, I needed to make this script because GitHub started to split my releases into two drafts.
// make ONE machine the single creator (win), this script has two modes:
//   (default)  create-or-reuse the single draft. Run by the Windows machine only.
//   --wait     poll until that draft exists; NEVER create. Run by mac/linux so
//              they only ever reuse the draft Windows created (no duplicates).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { assertGitHubCliAuthenticated, githubApi } = require('./github-cli.cjs');

const { buildChangelogReleaseBody } = require('./changelog-release-body.cjs');

require('dotenv').config();

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const CHANGELOG_PATH = path.join(REPOSITORY_ROOT, 'CHANGELOG.md');

const REPO_OWNER = process.env.GH_REPO_OWNER || 'BurntToasters';
const REPO_NAME = process.env.GH_REPO_NAME || 'IYERIS';
const GH_REQUEST_RETRIES = Number.parseInt(process.env.GH_REQUEST_RETRIES || '3', 10);
const GH_REQUEST_RETRY_DELAY_MS = Number.parseInt(
  process.env.GH_REQUEST_RETRY_DELAY_MS || '1500',
  10
);

// --wait mode: how long mac/linux will wait for the Windows machine to create
// the draft before giving up (defaults to 30 minutes, polling every 15s).
const WAIT_MODE = process.argv.slice(2).includes('--wait');
const WAIT_TIMEOUT_MS = Number.parseInt(process.env.RELEASE_DRAFT_WAIT_TIMEOUT_MS || '1800000', 10);
const WAIT_POLL_INTERVAL_MS = Number.parseInt(
  process.env.RELEASE_DRAFT_WAIT_POLL_MS || '15000',
  10
);

const packageJson = require('../package.json');
const VERSION = packageJson.version;
const TAG_NAME = 'v' + VERSION;
const IS_PRERELEASE = /-(?:beta|alpha|rc)(?:[.-]?\d+)?/i.test(VERSION);

function currentCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  }).trim();
}

const RELEASE_COMMIT = currentCommit();

function assertReleaseCommit(release) {
  if (release?.target_commitish !== RELEASE_COMMIT) {
    throw new Error(
      `Release ${TAG_NAME} is pinned to ${release?.target_commitish || '<missing>'}, expected ${RELEASE_COMMIT}. Recreate the draft from this commit.`
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readChangelogReleaseBody(changelogPath = CHANGELOG_PATH) {
  let body;
  try {
    body = fs.readFileSync(changelogPath, 'utf8');
  } catch (error) {
    throw new Error(
      'CHANGELOG.md is required for GitHub release notes: ' +
        (error && error.message ? error.message : String(error)),
      { cause: error }
    );
  }
  return buildChangelogReleaseBody(body, VERSION);
}

async function syncReleaseNotesBody(release, body) {
  if (!release || typeof release.id !== 'number') {
    throw new Error('Cannot sync release notes without a GitHub release id.');
  }
  if (!release.draft) {
    throw new Error(`Release ${TAG_NAME} is already published; refusing to mutate it.`);
  }
  assertReleaseCommit(release);
  // Always resend tag_name + target_commitish. Editing a draft whose git tag does
  // not exist yet with only {name, body} makes GitHub rewrite its tag_name to
  // "untagged-<hash>"; gpg-sign then could not find it and created a second draft.
  const updated = await githubRequestWithRetry(
    'PATCH',
    '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases/' + release.id,
    { tag_name: TAG_NAME, target_commitish: RELEASE_COMMIT, name: VERSION, body }
  );
  if (!updated || updated.tag_name !== TAG_NAME || !updated.draft) {
    throw new Error(
      `GitHub returned release ${release.id} as tag "${updated?.tag_name || '<missing>'}" ` +
        `(draft=${updated?.draft}) after the notes sync; expected draft ${TAG_NAME}. ` +
        'Fix the tag on GitHub before building, or the next upload step cannot find it.'
    );
  }
  console.log(
    '   Synced CHANGELOG.md into release notes (' +
      body.length +
      ' chars) for ' +
      (release.name || TAG_NAME) +
      '.'
  );
  return updated;
}

function isRetryableGithubError(error) {
  if (!error) return false;

  const retryableStatusCodes = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
  const retryableCodes = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'EPIPE',
  ]);

  if (typeof error.statusCode === 'number' && retryableStatusCodes.has(error.statusCode)) {
    return true;
  }
  if (typeof error.code === 'string' && retryableCodes.has(error.code)) {
    return true;
  }

  const msg = String(error.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('socket hang up') || msg.includes('aborted');
}

function githubRequest(method, endpoint, body) {
  return Promise.resolve(githubApi(method, endpoint, body));
}

async function githubRequestWithRetry(method, endpoint, body) {
  const attempts = Math.max(1, GH_REQUEST_RETRIES);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await githubRequest(method, endpoint, body);
    } catch (error) {
      const canRetry = attempt < attempts && isRetryableGithubError(error);
      if (!canRetry) {
        throw error;
      }

      const backoffMs = GH_REQUEST_RETRY_DELAY_MS * attempt;
      console.log(
        '   Retry ' +
          attempt +
          '/' +
          (attempts - 1) +
          ' in ' +
          backoffMs +
          'ms (' +
          error.message +
          ')'
      );
      await sleep(backoffMs);
    }
  }
}

// A draft of this version that GitHub has untagged ("untagged-<hash>"); see
// syncReleaseNotesBody. Name covers both this script and old gpg-sign drafts.
function isOrphanedDraft(release) {
  return (
    release?.draft === true &&
    typeof release.tag_name === 'string' &&
    release.tag_name.startsWith('untagged-') &&
    release.target_commitish === RELEASE_COMMIT &&
    (release.name === VERSION || release.name === 'IYERIS ' + VERSION)
  );
}

function describeRelease(release) {
  return `id ${release.id} "${release.name}" tag ${release.tag_name}, ${release.assets ? release.assets.length : 0} assets`;
}

async function findExistingRelease({ adoptOrphan = false } = {}) {
  // Draft releases are not returned by the "get release by tag" endpoint
  // (no git tag exists yet), so we list and match on tag_name.
  const releases = await githubRequestWithRetry(
    'GET',
    '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases?per_page=100'
  );

  if (!Array.isArray(releases)) {
    throw new Error('Unexpected releases payload type');
  }

  const published = releases.find((r) => r.tag_name === TAG_NAME && !r.draft);
  if (published) return published;

  const drafts = releases.filter((r) => r.draft && r.tag_name === TAG_NAME);
  const orphans = releases.filter(isOrphanedDraft);
  const candidates = adoptOrphan ? [...drafts, ...orphans] : drafts;

  // Never pick one of several drafts: uploads address the release by tag, so
  // GitHub would choose for us and split assets across drafts.
  if (candidates.length > 1 || (!adoptOrphan && drafts.length === 1 && orphans.length > 0)) {
    throw new Error(
      `Found ${drafts.length + orphans.length} draft releases for ${TAG_NAME}:\n  - ` +
        [...drafts, ...orphans].map(describeRelease).join('\n  - ') +
        '\nDelete the extras on GitHub so exactly one remains, then rerun "npm run release:draft" on Windows.'
    );
  }
  if (!adoptOrphan && orphans.length > 0) {
    console.log(
      '   Found an untagged draft for this version (' +
        describeRelease(orphans[0]) +
        '). "npm run release:draft" on Windows will re-tag it.'
    );
  }
  return candidates[0] || null;
}

async function ensureDraftRelease() {
  console.log('Ensuring draft release exists for ' + TAG_NAME + '...');
  const body = readChangelogReleaseBody();

  const existing = await findExistingRelease({ adoptOrphan: true });
  if (existing) {
    if (existing.draft && existing.tag_name !== TAG_NAME) {
      console.log(
        '   Re-tagging untagged draft ' + describeRelease(existing) + ' as ' + TAG_NAME + '.'
      );
    }
    if (!existing.draft) {
      throw new Error(`Release ${TAG_NAME} is already published; refusing to reuse it.`);
    }
    console.log(
      '   Draft already exists: ' +
        (existing.name || TAG_NAME) +
        ' (id ' +
        existing.id +
        ', ' +
        (existing.assets ? existing.assets.length : 0) +
        ' assets) - refreshing release notes.'
    );
    return syncReleaseNotesBody(existing, body);
  }

  console.log('   No release found. Creating draft...');
  try {
    const release = await githubRequestWithRetry(
      'POST',
      '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases',
      {
        // Match electron-builder's createRelease() so it reuses this draft:
        // tag = "v" + version, name defaults to the version, draft:true.
        tag_name: TAG_NAME,
        target_commitish: RELEASE_COMMIT,
        name: VERSION,
        body,
        draft: true,
        prerelease: IS_PRERELEASE,
      }
    );
    assertReleaseCommit(release);
    console.log(
      '   Created draft release: ' +
        (release.name || TAG_NAME) +
        ' (id ' +
        release.id +
        ') with CHANGELOG.md release notes.'
    );
    return release;
  } catch (error) {
    // Another concurrent run may have created it (422 already_exists) - re-fetch.
    if (error.statusCode === 422) {
      console.log('   Create returned 422; re-checking for existing draft...');
      await sleep(2000);
      const afterRetry = await findExistingRelease({ adoptOrphan: true });
      if (afterRetry) {
        if (!afterRetry.draft) {
          throw new Error(`Release ${TAG_NAME} is already published; refusing to reuse it.`, {
            cause: error,
          });
        }
        console.log('   Found existing draft after retry: id ' + afterRetry.id);
        return syncReleaseNotesBody(afterRetry, body);
      }
    }
    throw error;
  }
}

async function waitForDraftRelease() {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  console.log(
    'Waiting for draft release ' +
      TAG_NAME +
      ' (created by the Windows machine); will NOT create it here...'
  );

  let attempt = 0;
  for (;;) {
    attempt += 1;
    const existing = await findExistingRelease();
    if (existing) {
      if (!existing.draft) {
        throw new Error(`Release ${TAG_NAME} is already published; refusing to build into it.`);
      }
      assertReleaseCommit(existing);
      console.log(
        '   Found draft: ' +
          (existing.name || TAG_NAME) +
          ' (id ' +
          existing.id +
          ', ' +
          (existing.assets ? existing.assets.length : 0) +
          ' assets). Proceeding.'
      );
      return existing;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        'Timed out after ' +
          Math.round(WAIT_TIMEOUT_MS / 1000) +
          's waiting for draft ' +
          TAG_NAME +
          '. Run "npm run release:draft" on the Windows machine first (or run it here once), then retry.'
      );
    }

    console.log(
      '   Draft not found yet (attempt ' +
        attempt +
        '); re-checking in ' +
        Math.round(WAIT_POLL_INTERVAL_MS / 1000) +
        's...'
    );
    await sleep(WAIT_POLL_INTERVAL_MS);
  }
}

async function main() {
  assertGitHubCliAuthenticated();

  if (WAIT_MODE) {
    await waitForDraftRelease();
  } else {
    await ensureDraftRelease();
  }
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error('✗ ERROR: Failed to ensure draft release: ' + message);
  process.exit(1);
});
