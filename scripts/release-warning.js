#!/usr/bin/env node
/*
 * M13: blocking confirmation prompt for the destructive release:* scripts.
 *
 * The previous version printed a red banner and a 3-second setTimeout.
 * It was clearly meant to be a guard but wasn't actually blocking — a
 * mistyped `npm run release:win` on the wrong branch would wipe local
 * commits and untracked files with no recoverable interaction.
 *
 * Now we require the user to type YES (case-sensitive) before proceeding.
 * CI and non-interactive runs can bypass with one of:
 *   - CI=1 (or CI=true) in env
 *   - IYERIS_RELEASE_CONFIRM=YES in env
 *   - `--yes` on argv
 *
 * The user's prior instruction is that the destructive intent of these
 * scripts is intentional — this commit doesn't change that. It only
 * adds a hand-on-the-wheel before the destructive bit fires.
 */
import { createInterface } from 'node:readline';

const red = '\x1b[31m';
const yellow = '\x1b[33m';
const reset = '\x1b[0m';

const banner =
  '[!!WARNING!!] The release scripts are DESTRUCTIVE.\n' +
  '              Any local changes to this branch will be lost, including\n' +
  '              uncommitted edits, staged work, and untracked files.';
console.error(`\n${red}${banner}${reset}\n`);

const argvBypass = process.argv.includes('--yes') || process.argv.includes('-y');
const envBypass =
  process.env.CI === '1' ||
  process.env.CI === 'true' ||
  process.env.IYERIS_RELEASE_CONFIRM === 'YES';

if (argvBypass || envBypass) {
  console.error(`${yellow}(non-interactive bypass active — proceeding)${reset}\n`);
  process.exit(0);
}

if (!process.stdin.isTTY) {
  console.error(
    `${red}stdin is not a TTY and no bypass flag was provided. Re-run with --yes or set IYERIS_RELEASE_CONFIRM=YES.${reset}\n`
  );
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stderr });
rl.question(`${yellow}Type ${reset}YES${yellow} to continue: ${reset}`, (answer) => {
  rl.close();
  if (answer === 'YES') {
    process.exit(0);
  }
  console.error(`${red}Aborted by user.${reset}`);
  process.exit(1);
});
