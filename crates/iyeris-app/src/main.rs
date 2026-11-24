//! IYERIS 4 Rune spike: a 100,000-entry synthetic folder in list and grid views, runnable headless.
//!
//! # Failure modes
//!
//! Every way this spike can fail, written before the code. Each names what would show it.
//!
//! 1. Rows missing or duplicated at a scroll offset: `virtual_rows` mounts the wrong window,
//!    or two rows share a key. Shown by `--tree` at `list-scrolled` (`file-050000` absent,
//!    or a key appearing twice).
//! 2. Wrong row selected: a row's `on_press` or the arrow keys write the wrong index. Shown by
//!    the selected highlight in `--snap` landing on a row other than the selected entry.
//! 3. Grid column count wrong for the width: `cols` is computed from the grid viewport's
//!    width. Shown by tiles overflowing the viewport, or a last row with too few tiles in
//!    `--snap --scene grid`. Before the first layout the width is unknown, so `cols` is 0
//!    and the grid falls back to one column until the view re-runs.
//! 4. Scrolling past the end: Up or Down move the selection outside `0..TOTAL`. Shown by a
//!    panic on index, or by the selection vanishing from the list.
//! 5. Label wrong for size or kind: a folder shows a byte size, a file shows no size, or the
//!    human-readable unit is wrong at a boundary (1023 B, 1 KB, 1 MB). Shown in `--tree`
//!    labels and in `--snap` text.
//! 6. Frame time too high at 100k rows: building every key or every row per commit. Shown by
//!    the debug-build timing line Rune prints per headless frame. Mitigated by a constant
//!    `virtual_rows_version`, so keys are not recomputed, and by building only mounted rows.
//! 7. Headless run needs a GPU or display: `--snap` or `--tree` fails without a GPU adapter
//!    or a display server. Shown as a startup error from `rune::run`, not as a wrong image.
//! 8. Scene does not scroll: `list-scrolled` sets the selection, but the scroll request
//!    (`scroll_into_view`) never runs, so entry 50,000 is not visible. Shown by `--tree`
//!    lacking `folder-050000`.
//! 9. Stale grid column count: the view writes `cols` only when it runs, so a resize without
//!    a view re-run leaves Up and Down stepping by the old count. Shown by a grid selection
//!    jumping by the wrong number of tiles after a window resize.

#![forbid(unsafe_code)]

mod model;
mod view;

use rune::AppSpec;

fn main() {
    rune::run(AppSpec {
        scenes: &[
            ("list", scene_list),
            ("grid", scene_grid),
            ("list-scrolled", scene_list_scrolled),
            ("grid-selected", scene_grid_selected),
        ],
        poll: Some(view::poll),
        on_key: Some(view::on_key),
        ..AppSpec::new("IYERIS", (960.0, 640.0), model::State::default, view::view)
    });
}

fn scene_list(_: &mut model::State) {}

fn scene_grid(s: &mut model::State) {
    s.mode = model::ViewMode::Grid;
}

fn scene_list_scrolled(s: &mut model::State) {
    s.mode = model::ViewMode::List;
    s.select(50_000);
    s.reveal = Some(50_000);
}

fn scene_grid_selected(s: &mut model::State) {
    s.mode = model::ViewMode::Grid;
    s.select(7);
    s.reveal = Some(7);
}
