//! Entries and view state. Framework-free: no Rune types here.

use std::cell::Cell;

/// Entries in the synthetic folder.
pub const TOTAL: usize = 100_000;
/// Every entry whose index is a multiple of this is a folder.
const FOLDER_EVERY: usize = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Folder,
    File,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Folder => "Folder",
            Kind::File => "File",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub kind: Kind,
    /// `None` for folders: they have no byte size.
    pub size: Option<u64>,
}

/// The entry at `index`, generated from the index alone. `index` is clamped to the folder.
pub fn entry(index: usize) -> Entry {
    let index = index.min(TOTAL - 1);
    if index.is_multiple_of(FOLDER_EVERY) {
        Entry {
            name: format!("folder-{index:06}"),
            kind: Kind::Folder,
            size: None,
        }
    } else {
        Entry {
            name: format!("file-{index:06}.txt"),
            kind: Kind::File,
            size: Some(file_size(index)),
        }
    }
}

/// Deterministic bytes for a file: between 1 B and just under 50 MB.
fn file_size(index: usize) -> u64 {
    (index as u64).wrapping_mul(7_919) % 50_000_000 + 1
}

/// `512 B`, `1.5 KB`, `2.0 MB`, `3.0 GB` (binary units, one decimal above bytes).
pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ViewMode {
    #[default]
    List,
    Grid,
}

#[derive(Default)]
pub struct State {
    pub mode: ViewMode,
    /// Always in `0..TOTAL`.
    pub selected: usize,
    /// A row to scroll into view on the next frame, once its key is known.
    pub reveal: Option<usize>,
    /// Grid column count, written by the view from the grid's width. Zero until the view has
    /// seen a laid-out grid. `Cell` lets the view record it while only holding `&State`.
    pub grid_cols: Cell<usize>,
}

impl State {
    /// Selects `index`, clamped into the folder, and asks for it to be revealed.
    pub fn select(&mut self, index: usize) {
        self.selected = index.min(TOTAL - 1);
        self.reveal = Some(self.selected);
    }

    /// Moves the selection by `step` entries in the given direction, stopping at both ends.
    pub fn move_selection(&mut self, forward: bool) {
        let step = match self.mode {
            ViewMode::List => 1,
            ViewMode::Grid => self.grid_cols.get().max(1),
        };
        let next = if forward {
            self.selected.saturating_add(step)
        } else {
            self.selected.saturating_sub(step)
        };
        self.select(next);
    }
}
