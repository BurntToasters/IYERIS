//! Views, frame polling and keys. Rows are built only where they are mounted (`virtual_rows`).

use std::borrow::Cow;

use rune::tok::{self, Theme, type_};
use rune::{Cx, El, GrowthSpec, Key, KeyEvent, ScrollSpec, Tx, col, el, row, text};

use crate::model::{self, State, TOTAL, ViewMode};

const ROW_HEIGHT: f32 = 32.0;
const TILE_WIDTH: f32 = 120.0;
const TILE_HEIGHT: f32 = 132.0;
const GAP: f32 = 12.0;
const LIST_VIEWPORT: &str = "list-viewport";
const GRID_VIEWPORT: &str = "grid-viewport";

pub fn view(s: &State, cx: &mut Cx<State>) -> El {
    let dark = cx.system_dark();
    let t = tok::theme(dark);
    let body = match s.mode {
        ViewMode::List => list(dark),
        ViewMode::Grid => grid(s, cx, dark),
    };
    col()
        .w_full()
        .h_full()
        .fill(t.bg)
        .child(toolbar(s, &t, dark))
        .child(body)
}

fn toolbar(s: &State, t: &Theme, dark: bool) -> El {
    row()
        .w_full()
        .h(44.0)
        .px(12.0)
        .gap(8.0)
        .center_y()
        .child(mode_button(
            "List view",
            "mode-list",
            ViewMode::List,
            s.mode,
            t,
            dark,
        ))
        .child(mode_button(
            "Grid view",
            "mode-grid",
            ViewMode::Grid,
            s.mode,
            t,
            dark,
        ))
}

fn mode_button(
    label: &'static str,
    key: &'static str,
    mode: ViewMode,
    current: ViewMode,
    t: &Theme,
    dark: bool,
) -> El {
    let active = mode == current;
    el().key(key)
        .role("button")
        .label(label)
        .focusable(true)
        .checked(active)
        .h(28.0)
        .px(12.0)
        .radius(tok::radius::MD)
        .center()
        .fill(if active {
            tok::accent(0, dark)
        } else {
            t.control_off
        })
        .on_press(move |s: &mut State| {
            s.mode = mode;
            s.reveal = Some(s.selected);
        })
        .child(text(label).font(type_::LABEL).color(t.text))
}

fn list(dark: bool) -> El {
    col()
        .key(LIST_VIEWPORT)
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(
            col()
                .key("list-rows")
                .w_full()
                .growth(GrowthSpec::default())
                .virtual_rows_version("list")
                .virtual_rows(TOTAL, ROW_HEIGHT, list_key, move |s: &State, i| {
                    list_row(s, i, dark)
                }),
        )
}

/// List keys are the entry names, which never change, so the version above is constant.
fn list_key(_: &State, i: usize) -> Cow<'_, str> {
    Cow::Owned(model::entry(i).name)
}

fn list_row(s: &State, i: usize, dark: bool) -> El {
    let t = tok::theme(dark);
    let e = model::entry(i);
    let size = e.size.map_or_else(|| "—".to_owned(), model::human_size);
    let label = format!("{}, {}, {}", e.name, e.kind.label(), size);
    let selected = s.selected == i;
    let name_color = if selected { t.bg } else { t.text };
    let meta_color = if selected { t.bg } else { t.text_secondary };
    row()
        .key(e.name.clone())
        .role("row")
        .label(label)
        .focus_selected(selected)
        .w_full()
        .h(ROW_HEIGHT)
        .px(12.0)
        .gap(12.0)
        .center_y()
        .fill(if selected { tok::accent(0, dark) } else { t.bg })
        .on_press(move |s: &mut State| s.select(i))
        .child(
            text(e.name)
                .font(type_::BODY)
                .color(name_color)
                .grow(1.0)
                .truncate(),
        )
        .child(
            text(e.kind.label())
                .font(type_::LABEL)
                .color(meta_color)
                .w(72.0),
        )
        .child(text(size).font(type_::LABEL).color(meta_color).w(96.0))
}

fn grid(s: &State, cx: &mut Cx<State>, dark: bool) -> El {
    let width = cx.layout_size(GRID_VIEWPORT).map_or(0.0, |size| size[0]);
    let cols = columns_for(width);
    s.grid_cols.set(cols);
    let rows = if cols == 0 { 0 } else { TOTAL.div_ceil(cols) };
    col()
        .key(GRID_VIEWPORT)
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(
            col()
                .key("grid-rows")
                .w_full()
                .growth(GrowthSpec::default())
                .virtual_rows_version(("grid", cols))
                .virtual_rows(
                    rows,
                    TILE_HEIGHT + GAP,
                    move |_: &State, r| Cow::Owned(grid_row_key(cols, r)),
                    move |s: &State, r| grid_row(s, r, cols, dark),
                ),
        )
}

/// How many tiles of `TILE_WIDTH` with `GAP` between them fit in `width`. Zero when the width
/// is unknown, so no row is built before the first layout.
fn columns_for(width: f32) -> usize {
    if width <= 0.0 {
        return 0;
    }
    ((width + GAP) / (TILE_WIDTH + GAP)).floor().max(1.0) as usize
}

fn grid_row_key(cols: usize, r: usize) -> String {
    format!("grid-{cols}-{r}")
}

fn grid_row(s: &State, r: usize, cols: usize, dark: bool) -> El {
    let mut line = row().w_full().h(TILE_HEIGHT).gap(GAP);
    for c in 0..cols {
        let i = r * cols + c;
        if i >= TOTAL {
            break;
        }
        line = line.child(tile(s, i, dark));
    }
    line
}

fn tile(s: &State, i: usize, dark: bool) -> El {
    let t = tok::theme(dark);
    let e = model::entry(i);
    let selected = s.selected == i;
    let glyph = match e.kind {
        model::Kind::Folder => t.text_secondary,
        model::Kind::File => t.control_off,
    };
    let label = format!("{}, {}", e.name, e.kind.label());
    col()
        .key(format!("tile-{i}"))
        .role("gridcell")
        .label(label)
        .focus_selected(selected)
        .w(TILE_WIDTH)
        .h(TILE_HEIGHT - GAP)
        .px(8.0)
        .gap(6.0)
        .center()
        .radius(tok::radius::MD)
        .fill(if selected {
            tok::accent(0, dark)
        } else {
            t.card
        })
        .on_press(move |s: &mut State| s.select(i))
        .child(el().size(56.0, 56.0).radius(10.0).fill(glyph))
        .child(
            text(e.name)
                .font(type_::LABEL)
                .color(t.text)
                .w_full()
                .single_line()
                .truncate(),
        )
}

/// Runs each frame before the view: scrolls the pending row into view once its key exists.
/// A grid row's key needs the column count, which is unknown until the view has laid out the
/// grid, so the reveal waits for it.
pub fn poll(s: &mut State, _now: f64, tx: &mut Tx) -> bool {
    let Some(index) = s.reveal else {
        return false;
    };
    let key = match s.mode {
        ViewMode::List => model::entry(index).name,
        ViewMode::Grid => {
            let cols = s.grid_cols.get();
            if cols == 0 {
                return false;
            }
            grid_row_key(cols, index / cols)
        }
    };
    tx.scroll_into_view(key);
    s.reveal = None;
    true
}

/// Up and Down move the selection by one row (list) or one row of tiles (grid).
pub fn on_key(s: &mut State, ev: &KeyEvent, _tx: &mut Tx) -> bool {
    match ev.key {
        Key::Up => {
            s.move_selection(false);
            true
        }
        Key::Down => {
            s.move_selection(true);
            true
        }
        _ => false,
    }
}
