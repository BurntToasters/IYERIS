# Dependency update safety

`npm run u` is a lockfile-only dependency proposal. It does not install npm packages, run npm lifecycle scripts, compile Rust, execute Cargo build scripts or procedural macros, format source files, or run tests.

The command requires npm 12.0.1 or newer and an already-installed Rust 1.97.1 toolchain. It performs these steps:

1. Resolve npm updates with `--package-lock-only`, `--ignore-scripts`, and a three-day minimum release age in a disposable npm cache.
2. Reject high-severity npm audit findings without populating the project `node_modules` directory.
3. Resolve Cargo updates through the local crates.io age-filter proxy in a disposable Cargo home.
4. Reject releases younger than 72 hours, unknown registries, unapproved Git revisions, concurrent lock edits, and unverifiable publication metadata.
5. Atomically install only the validated lockfile and remove temporary caches.

Both updaters serialize their own runs. npm rollback and final Cargo lock installation compare expected bytes, preserving a concurrent process's lockfile edit instead of overwriting it.

Review both lockfile diffs before committing. Push the update branch and let GitHub-hosted CI perform code-executing validation. CI installs npm packages with lifecycle scripts disabled, verifies registry signatures, and only then runs dependency code. CI is intentionally the first environment that installs or executes newly selected dependency code.

Do not run `npm run workspace:prepare`, `npm run test:all`, Cargo checks, builds, or tests on a workstation immediately after updating locks. Those commands execute dependency code. If local validation is necessary, use a disposable VM with no credentials, mounted home directory, SSH agent, signing keys, cloud metadata access, or persistent package caches.

The three-day delay reduces exposure to newly published supply-chain attacks; it cannot prove that an older package is benign. Emergency young-crate and Git overrides must name one exact version or revision and include a written reason.
