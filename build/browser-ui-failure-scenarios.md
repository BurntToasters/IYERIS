# IYERIS 3.1.0 browser evidence failure inventory

Written before the full-app harness changes. This is the failure inventory for an isolated Chromium run of the shipped renderer. The run uses the complete `src/index.html` body, the actual `src/tauri-api.ts` and `src/renderer.ts` modules, and deterministic native-boundary fixtures. It is not a controller-only DOM simulation.

## Harness and fixture failures

- The complete app body may not mount, required element IDs may be absent or duplicated, or the real renderer entry may not execute after the mount.
- Renderer startup may stop on a missing or malformed `__TAURI_INTERNALS__` surface, browser-only API, event registration, theme lookup, settings response, or home-directory response. A startup error dialog, uncaught exception, or failure to reach the first directory is a failed case.
- A native mock may return a structurally invalid IPC response, mutate saved settings unexpectedly, omit a file or directory needed by navigation, or fail to preserve state across reload. Responses and mutations must be deterministic and identified in the artifact.
- Any `invoke` command outside the explicit fixture allowlist is a failure with the command and arguments recorded. Expected fixture commands whose response is intentionally an error are enumerated and asserted; errors are never converted to successful empty responses by a catch-all.
- Browser, file URL, CSS, screenshot binding, or temporary-profile startup failures are environment/harness failures, distinct from UI assertion failures. Temporary browser data must be removed even after failure.
- Screenshot requests may race an assertion, use a stale viewport, duplicate a file name, or return incomplete PNG data. The full-window baseline capture for each viewport must finish and be verified before any redesign assertion runs.
- Existing smoke suites may regress or be accidentally omitted when the full-app suite is appended. The runner must keep the original suite modes, result validation, and artifact verification.
- Legacy controller suites may install window/document listeners that survive `document.body` replacement and retain stale fixture closures. The full renderer must run in a new JavaScript realm/page after the legacy suites; body replacement alone is not isolation. Aggregate both result sets without dropping the original 14 suites or screenshot bindings.

## Product failure cases to assert

- At 800, 1200, and 1600 CSS-pixel widths, the shared cross-platform file-browser shell may hide the address or primary navigation, clip controls, or expose an action that cannot be reached by pointer or keyboard.
- Back, forward, up, direct editable-path navigation, directory history, and browser history may disagree about the current path, active tab, or enabled state.
- The primary toolbar may expose too many actions or fail to expose navigation, view selection, new folder, search, and More. Refresh, new file, and sort must be reachable through More. At narrow width, view, new-folder, and up actions may be hidden without a keyboard or menu route.
- More may fail to open, contain the wrong actions, close incorrectly, trap focus, fail Escape, or provide no predictable keyboard navigation.
- Tabs may fail to create, switch, close, or preserve their location/history. The new-tab action and tab list may become unreachable at narrow widths.
- Grid/list/column view changes, row selection, selection status, and clearing selection may drift. Selection-only status may leave unrelated destructive or frequent actions permanently in the primary toolbar.
- Search may not open, submit, return deterministic results, close, or keep local/global scope understandable. Search errors may leave stale results or an unusable input.
- Home may show broken sections or noisy empty content, fail to navigate to an item, or lose its saved visibility/order preferences.
- A delayed Home preference save may reconcile against stale current settings and discard edits made while the response is in flight. Hold the first deterministic save, change a different preference, release the response, and assert the first value is canonical while the newer value remains pending in an open dialog. A second save must persist both values and close the dialog; release the fixture gate in cleanup even when an assertion fails.
- Settings may fail to open, switch relevant tabs, apply all saved/default/custom theme values, apply all density values and supported zoom levels, persist changes, or restore accessibility preferences after reload. Liquid Glass may stop applying or be overwritten by another preference.
- Representative native operation failures (new-folder creation and an additional file operation) may disappear without a visible, actionable error or leave stale success/selection/progress state.
- At 125% and 150% zoom, and with large text, high contrast, visible focus, reduced motion, and reduced transparency enabled, key controls may clip, become unreachable, lose focus visibility, or ignore the saved setting. The 100% baseline must remain usable.
- A redesign may regress the existing controller and visual behavior covered by the 14 existing suites. Preserve those suites and assertions; change an old aesthetic assertion only if the approved redesign makes it demonstrably obsolete, and record that reason here before changing it.
- Selection status may appear stale if a row is clicked while a view switch is still rebuilding the file surface, or if the test clicks a detached row. Wait for the requested view, all directory work, and the connected current row before selecting; then wait for a visible status update and keep the visible-status assertion strict.
- The active pane in dual-pane mode may not be the pane receiving selection, keyboard focus, or copy/move commands. Exercise a real secondary-pane directory with uniquely named rows, select there, issue a representative native copy or move, and verify both the targeted source identity and native destination arguments. Keep both pane datasets deterministic and fail closed on unmocked IPC.
- At 125% and 150% zoom, clipped or overlapping toolbar controls may be hidden by `overflow` while `scrollWidth` remains unchanged. At those zooms, and at the 800x500 accessibility profile, measure visible control rectangles against the toolbar and viewport and assert they remain in bounds and do not overlap.
- Settings, operation failure, and preview views may regress outside their default dark appearance. Capture those states and check representative panel surface opacity/visibility for named themes; treat Liquid Glass as its explicit transparency exception, and assert reduced transparency takes precedence when enabled.

## Approved visual expectation update

- The shared Finder redesign keeps Home surfaces quiet on hover and removes hover elevation. The existing visual suite only checked an unhovered Home tile's transform, so it did not test that behavior. Before production styling changes, extend this E2E check to exercise the actual hover state and assert that Home tiles do not gain elevation; this replaces the obsolete allowance for elevated Home hover treatment without weakening other visual assertions.

## Additional full-app assertions

- A view selection is asynchronous. The full-app suite must wait until the selected view has rendered, all relevant loading work has ended, and the row is still connected before testing selection status. It must then wait for the status UI to settle and assert that status is visible.
- Dual-pane evidence must route selection and its native command from the active secondary pane while preserving the command's source path and destination. Use an explicit IPC fixture and record the scenario identifier and invocation arguments in the artifact.
- Zoom and accessibility geometry must be checked at the rendered zoom sizes, including 125%, 150%, and the 800x500 accessibility profile. Geometry checks complement the no-horizontal-scroll check because overflow clipping can conceal loss of reachability.
- Capture and inspect representative settings, native-operation error, and preview surfaces across named themes. Liquid Glass is allowed its translucency; `reduceTransparency` must override that appearance.
- The expanded full-app matrix may exceed the browser runner's existing 120-second evaluation deadline. If more time is required for its additional deterministic cases, increase the explicit deadline only enough to keep the suite bounded; retain each case's own timeout so a stalled renderer remains a failure.
- The full renderer may reach native APIs beyond the happy-path startup set while exercising dual-pane work and preview properties. Add each newly exercised command to its explicit fixture contract with a response matching the real IPC schema; keep unexpected invokes as hard failures.
- Preview properties and file content are read at different points in the real flow. Select the row and verify its property fixture, then open the preview and wait for its file-content IPC; do not require a preview read before the user action that opens it.
- A successful copy can report a different status if the fixture does not match the native operation contract. Verify the API wrapper's resolved result and both pane refreshes before asserting UI state; preserve the refresh assertion so real renderer regressions remain visible.
- Tauri `copy_items`, `move_items`, and `clear_drag_data` resolve Rust unit results as `null` over IPC. Return that value from the fixture so the renderer's complete successful-operation path, including drag cleanup and refresh, can run.
- Search may issue its native query before rendering the asynchronous result. Wait until the expected match is visible and search loading has ended, then assert content; IPC dispatch alone is not proof of a completed search.
- View controls can update their selected appearance before the async directory load completes, and selection status can briefly appear before a later render clears it. Wait for the load to finish, the requested view state to remain stable across frames, and the current connected row before asserting selected accessibility state and status.
- The redesigned shared modal overlay removes unnecessary blur from the default appearance. Update the old shared-overlay expectation of an 8px blur to require no default overlay blur; retain checks for blur on surfaces where Liquid Glass explicitly enables it.

## Evidence contract

- Capture the full-app baseline screenshot and basic render metadata at each viewport before checking redesign expectations, including on a baseline that is expected to fail the new design assertions.
- Add the full-app suite after the existing suites. Its artifact entries identify case, viewport, zoom, theme, density, accessibility flags, and native fixture scenario/identifier.
- Assert semantic structure, visibility, reachability, state, and bounded layout geometry. Do not compare screenshots pixel-for-pixel or encode CSS implementation details as product requirements.
- Zoom cases cross the real Tauri API wrapper and deterministic `set_zoom_level` mock. The mock applies CSS `documentElement.style.zoom` to approximate WebView scaling; this does not certify native zoom behavior on macOS, Windows, or Linux.
- The browser fixture runs the shared renderer with a Linux platform response. It gives shared-DOM evidence, not separate native-window evidence for each operating system.
- `node scripts/smoke-browser.js` remains the repeatable entry point and must persist both passing and failing run artifacts plus every captured PNG.
