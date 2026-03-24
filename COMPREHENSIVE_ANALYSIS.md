# Prompt Widget: Comprehensive Feedback & Evolution Analysis

**Date**: March 2, 2026
**Scope**: 278 feedback items + 419 JSONL session logs (Feb 8 – Mar 2, 2026)

---

## Part I: Feedback Clustering & Action Plans

### Cluster 1: Terminal Panel Resize, Focus & Layout Bugs
**Count**: 28 items | **Priority**: HIGH

**Item IDs**: [01KJPBC334HBX7M1Z9M0MK5TQA], [01KJNWFWYKB16HB4CD10024CN6], [01KJNV05K98VAW2EVSH9XEBE46], [01KJEV41ZTTKQ2HSSQBDKD4MG3], [01KJESJ70F8JZYEMH681628XH2], [01KJE2REN1X747F9R1R8KVKFH2], [01KJE2HCVCPPF5T6QPQE98YBT7], [01KJGQ40H4MXMW297MSHF9VM81], [01KJGPE3C04DMPP8ZQWS1KYWR4], [01KJEYJ9NDYAWX3YHW8D53DYT2], [01KJK23JSZGR0Y0S62F236DDCC], [01KJKR9E0KK3KBBFXH9GA6YWGN], [01KJBDWQBAX6X0F9M9Y9KQW3G6], [01KJBDQNBTFTXTJT1MVKTN7H4Y], [01KJBDFXXQQ0MSK2C2VC7V3QBM], [01KJK836D8SZGWV2GDFD3MBPA8], [01KJK2M23FQR0AM6A31QFBGZ22], [01KJ1YE76PYW4TKC43A9KD4PX2], [01KJ206GQX2000PGQ7SEBTJC1Q], [01KHZA37RMESDM3QK1T04B9TDM], [01KHZAXC41J444D8SPSY0K6C7S], [01KHY9WMP5G1ZCB91W4S56CM5X], [01KHYPRTXW7V74K6XSZVH0STT3], [01KHYB95W4FPRD6YR3Z95T0JQQ], [01KHYRQ2B69ENNXSPACR0VZ3B6], [01KHAYF349K4EDN83NCXKG30JH], [01KHVME8AGS0A7T9R3AJ2SC2DS], [01KJ6E4QW47RHW2P2HRSFEM1RT]

**Recurring Sub-issues**:
- Mouse tracking cancels when cursor moves over companion panel
- Panel width/height not persisted across auto-jump switches
- Focus indicator (indigo border) not showing on active panel
- Flickering from periodic tmux resize activity
- Drawer handle disconnects from panel during resize
- Scrollbar wiggling from width changes
- Terminal not extending to bottom
- Drag position jumps when dragging windows
- Split pane header missing on one side
- Panel handle z-index: not occluded by panels on top

**Action Plan**:
1. Create a `PanelLayoutManager` service that centralizes all panel geometry (width, height, position, dock side) and persists to localStorage with a debounced save
2. Fix mouse tracking: use `pointer-events: none` on companion overlay during resize operations, or capture pointer on the resize handle
3. Replace periodic tmux resize polling with event-driven resize: only trigger on focus, tab switch, or manual resize — never on a timer
4. Standardize focus indicator: every panel/tab gets the same indigo-2px-border treatment via a shared CSS class, driven by a single `focusedPaneId` signal
5. Fix drawer handle z-index: make handle part of the panel's stacking context, not a sibling
6. Add E2E tests for panel resize, split, dock, and undock operations

---

### Cluster 2: Waiting-for-Input Detection & Auto-Jump System
**Count**: 22 items | **Priority**: HIGH

**Item IDs**: [01KJNWBVS8J3VEDS5Q04XXP070], [01KJNVNEH84EYGN1PPRKQYGXVS], [01KJNV35VTQXYT401M230R4HZH], [01KJK8V03FNQKWJZZG1AB6EM7Y], [01KJK8DAKF0WZCH7D7VX6D2Z74], [01KJK5TD9P4EJXYVYSY0QVZRAZ], [01KJDQSNWYF9A4Z2DXVHK4PX80], [01KJEY1BFC76C69V4C5M4Q9NTJ], [01KJEX7CEAKPZBR75F6SDW35A1], [01KJEVNBENG7BBY0DZKZMG0QNX], [01KJE1PA9WRSXXRPZR98E78Z10], [01KJC20HMNJBAJWHP3TNN8CGJP], [01KJBBN2CBRXWYGK4FHJ9PPX5R], [01KJ9Q8HKPD5TV4AZ00BQ31FPA], [01KJ8GP7FVGATD001A2DHDGGNM], [01KJ6GM02MQJYJ5RMD02CYN2QV], [01KJ6BEVZMG25CS4D8YZ9X4XK4], [01KJ4HYH4TXSW39167QQ8VSXH4], [01KJ2AZ56EPMWMAKVEENKSA7T9], [01KJ5YY330NEWTA8BMSBZKCZAS], [01KJF02HCX78GFPMD2HYMX6W0M], [01KJDSPQTAVHSYQGTF76FERJ71]

**Recurring Sub-issues**:
- Sessions showing as waiting when they aren't (false positives)
- Sessions NOT showing as waiting when they are (false negatives: "Enter to select", "auto-accept edits")
- Auto-jump firing when toggle is off
- Auto-jump not closing panels it didn't open
- Clicking waiting session doesn't focus existing tab
- Auto-jump panel not appearing on top of active panel
- Two pw-triggers appearing after hide/show cycle
- Notifications system for rapid permission granting

**Action Plan**:
1. Formalize waiting detection into a state machine with explicit states: `idle`, `running`, `waiting_permission`, `waiting_selection`, `waiting_input`
2. Define pattern matchers for each waiting type: permission prompts ("Allow", "Yes/No"), selection prompts ("Enter to select", "Arrow keys"), free-text input
3. Add confidence scoring: only transition to `waiting` state when confidence > 0.8, with a debounce of 500ms
4. Fix auto-jump lifecycle: track `jumpedBy` metadata on panels so auto-jump only closes panels it opened
5. Build a notification queue: when a session enters waiting state, emit a notification that can be acted on with a single keypress (y/n/Enter)
6. Add integration tests with recorded terminal output fixtures for each waiting pattern

---

### Cluster 3: Session List, Status & Sidebar UX
**Count**: 19 items | **Priority**: HIGH

**Item IDs**: [01KJE3TWJDBFMDHS6H2ZM0QNCQ], [01KJ8V5WSRHK40Y42K22RHJBZB], [01KJ8SFS4WCB3MQZQ0MDEQQT7R], [01KJ8EERVK1N7SP4MK0NW4WKP1], [01KJ8DSDF2TPJ3JDEYJT8BX10C], [01KJ8DDMW3DTSX549JTS4V4NXF], [01KJ76EQFJPY0VT0W1B8Z0MM4M], [01KJ66WV4DEMVK5YP3KF63D85S], [01KJ6GPT8SDMTZ64CMHG6WZ9TX], [01KJ6C57BNBXXY27A7MYGEK0KM], [01KJ9S90H6N1YESNTZ9KFCHDYZ], [01KJ60TQ4CTFVG2GAC1BNMDSRC], [01KJ4JYPB74MB9AAG4FBCJCQAT], [01KHVMTQAC21THN1641D8GH5AE], [01KHVNM0ZVEVS9P8JJEYZ72776], [01KHKYRJ49QW5EVN5TAR3G2STX], [01KHY4GBPJRRHA1R2HF4D9WV4V], [01KHWV5GYP1FC3EJ43D2SHNN7D], [01KJD0RQQP63AAFEHZB7RHTFZB]

**Recurring Sub-issues**:
- Sessions showing status "session" instead of actual state
- Running sessions showing as "failed"
- Killed sessions should show "terminated" not "failed"
- Flickering session count (250 vs 182)
- Active sessions not on top of sidebar list
- Session IDs useless — need short task summaries
- Separate lists for terminals vs agent sessions needed
- Status light colors/animations unclear
- Redundant horizontal session scrollbar when sidebar exists
- Killing a tab should auto-close it

**Action Plan**:
1. Define a canonical session status enum: `starting`, `running`, `waiting`, `completed`, `terminated`, `failed` — with clear exit-code-based determination (exit 0 = completed, SIGKILL = terminated, non-zero = failed)
2. Show session labels as: `[status-dot] [short-title or first 40 chars of prompt]` instead of raw IDs
3. Sidebar sections: "Waiting for Input" (top, blinking), "Running" (middle, green pulse), "Completed" (bottom, collapsible)
4. Remove horizontal session scrollbar — sidebar is the canonical list
5. Auto-close tab on kill (with 500ms fade-out animation)
6. Fix status update latency: emit status changes via WebSocket, not polling

---

### Cluster 4: Keyboard Shortcuts & Hotkey System
**Count**: 17 items | **Priority**: MEDIUM

**Item IDs**: [01KJKR51T58QRJTN7RY8YSHFCH], [01KJM0VP2CZBPCFBNH5GWRE8V4], [01KJMW4N98KWDR5XFYRDJY7HD0], [01KJ8F352ZD881J5BBZJGZE9B3], [01KJ94638ER548PTQ09J6EMDAT], [01KJ693HCYGMZ0PG5FKAK66SJ1], [01KJ28SH82J30ZE30TVCMR4V82], [01KJ1WQX0HB3W72MF489JJ2PF6], [01KJ1YC5PCPT6GCVWM4NBKM7T5], [01KHYAYT2R2YGNR7VEKMVHG1Y1], [01KHZA0RQ1TYQGN5NJQ4Y7KNVT], [01KHZ57Z3M9HA30J2YEZBTJ8H1], [01KHZCRJYBV4588HW7CQYM87ZC], [01KJ3V24CEVQRB11Y8N94Q05RG], [01KJ3V0PVSBFSW11TWG37AB95P], [01KHYNXEPZYGZ5A43XQ3BS5V9E], [01KHYN1P4C19D83PEHACMX230H]

**Recurring Sub-issues**:
- Ctrl-Shift-P overloaded (previous tab vs panel menu)
- Ctrl-Shift helpers should only apply to focused panel
- Hotkeys don't work when text box is focused
- Triple-shift accessible nav mode not reliable
- Need hotkeys for resolve (R), kill (K), close (W)
- Hotkey helper badges resize the session list
- Need keyboard shortcut to close active popup/panel
- Spotlight search (Ctrl-Shift-Space)
- Hotkey hints for feedback filter pills

**Action Plan**:
1. Create a keyboard shortcut registry with scope awareness: `global`, `panel`, `terminal`, `input` — only fire shortcuts for the current scope
2. Define non-conflicting shortcut map:
   - `Ctrl-Shift-Left/Right`: switch tabs
   - `Ctrl-Shift-B`: back (previous tab)
   - `Ctrl-Shift-A`: cycle to next waiting session
   - `Ctrl-Shift-W`: close active panel/tab
   - `Ctrl-Shift-\``: toggle terminal panel
   - `Ctrl-Shift-Space`: spotlight search
   - `R/K/W` when status menu is open: resolve/kill/close
3. Ctrl-Shift helper overlay: show only shortcuts relevant to focused panel, don't resize other elements (use absolute positioning)
4. In text inputs: only global shortcuts (Cmd-Shift-N) work, panel-scoped shortcuts are suppressed
5. Document all shortcuts in a searchable help panel

---

### Cluster 5: Screenshot & Image System
**Count**: 15 items | **Priority**: MEDIUM

**Item IDs**: [01KJHAZWH6KKA85NGYVTX378G2], [01KJDRWFYCGMCXGHEEZ674ETR8], [01KJD35W18F65NBQZVEPRPQR5N], [01KJ9QFDXQ3K70EHM6075WV3JR], [01KJ6F5EEVSS4JAPQWJVB6PZYF], [01KJ6F2TTKSTED0PWKZCDT8WY8], [01KJ6CE4Q46E5EVYGAW117XFZH], [01KJ6ASTZBYE0YEN8D1PJNB6R3], [01KJ3X8M58403W6R81DQQRZM0V], [01KJ3MTX7P48NRR616KGKBDGFZ], [01KJ23X5TV0FYDMEHE7K5Q8MW7], [01KJ291F2MW3RE20AXMVC0ZN9M], [01KJ1RSYBBC3R17MFXD52RFNKK], [01KHY5FFVFEKZF73XF2ZJM0WAT], [01KHYA4KZH2YKJMK5G033S4C1W]

**Recurring Sub-issues**:
- html-to-image SVG load failures (1.3MB SVG)
- Screenshot not capturing widget overlay
- Chrome artifact appearing briefly before screenshot
- Cursor inclusion/exclusion option not working
- Timed screenshot for capturing tooltips/menus
- Image editing: crop, annotate, highlight, resize, save
- getDisplayMedia permission asked every time
- Scroll position not captured

**Action Plan**:
1. Dual screenshot backend: keep html-to-image as fallback, prefer getDisplayMedia when permission is granted, cache permission state in sessionStorage
2. Fix widget capture: when `includeWidget=true`, temporarily set widget z-index to max before capture
3. Add timed screenshot: countdown overlay (3/5/10 sec options) with visual countdown, auto-capture at zero
4. Image editor improvements: resize handles on edges, crop tool with aspect ratio lock option, save-as-new or apply-to-existing
5. Chrome artifact fix: add a 200ms delay after getDisplayMedia resolves before capturing the frame
6. Persist screenshot permission: use the Permissions API to check `display-capture` state, skip the prompt if already granted

---

### Cluster 6: Feedback Widget Input UX
**Count**: 13 items | **Priority**: MEDIUM

**Item IDs**: [01KJPB2EQFG2649QHD5HTT2T9R], [01KJBBXDPGVEGW4WP6XSDAQJNE], [01KJ6C6TPQC8CMHEGJ7E25S941], [01KJ24K0Z081GVBKNJ3ZMG09ZB], [01KJ209N6PZJE3JTFA1BSC0VM2], [01KJ2BSS3GKQA2VQ8ZHBD0A7G7], [01KJ76JDPXAF24Q72F49FJJ87D], [01KJ6F753ZR79E41WQ5FJXB9DE], [01KJ6EB2RXC21RPV17J7E7X4X8], [01KJ24SZ266GRXM9R0NCWMPC19], [01KHW83X6WZ4RS5BDFJ0XBM7YV], [01KHD4HWK1CF8YVKN8MVV5750V], [01KHARH3R3MN5RWKMRJ039CWVF]

**Recurring Sub-issues**:
- Feedback box positioned weirdly (too far left, scrolls with page)
- Close button overlapping scrollable area
- Advanced options take up too much space
- Checkbox poorly positioned on submit
- Need text-area with send button (not just input)
- DOM selector: click-to-select unclear, "Done" doesn't exit mode
- Selected DOM elements should show full path in tooltip
- Should be able to edit feedback items post-submission (add screenshots, console info)
- Widget exclude option for DOM captures

**Action Plan**:
1. Redesign feedback input as a compact card with: resizable text-area, send button, collapsible advanced options row (screenshot/DOM/console as small icons with tooltips)
2. Fix positioning: use `position: fixed` with bottom-right anchor, never scroll with page
3. DOM selector: single-click-to-select by default, show full selector path in tooltip, "Space" to confirm, "Esc" to cancel
4. Post-submission editing: add edit button on feedback detail that opens the same card pre-filled, allow adding screenshots and console logs
5. Auto-dispatch option: green submit button when auto-dispatch is on, with confirmation toast

---

### Cluster 7: Dispatch & Agent Session Management
**Count**: 16 items | **Priority**: HIGH

**Item IDs**: [01KJK6Q5WVTEQC4GMD6JX9FR1R], [01KJKBZFW3F3BR0G8Y2Z3W5WZZ], [01KJ6756MK99HP6GDZ6MP33DAF], [01KJ3SY9EXAB8B9D2CTMNB8G4J], [01KJ262FVEJWR8ZGG74HNX1260], [01KJ24QE501TNE4YX2A7PKDW0A], [01KJ244D8CX1CEFCG17GTCFYAP], [01KHWQSJGJXAXQM7RGY73B0JF2], [01KHW855WKR598BZ92X1RVN6T4], [01KHKWMWRGF4X1VF0X6QZJA95T], [01KHYKACS7WEPXETHE1CG2JTPX], [01KHAXS3ENE22H6KN4STD0BRXP], [01KHAXPX0Y28K4ZYPNMKCC0CGA], [01KHAS0PDTSTSMET2A5B21T6X5], [01KHARVBWBMBYB2KNSJQHEQWBS], [01KHD4E12N76E8JTH91DD6SN5J]

**Recurring Sub-issues**:
- Dispatch creating duplicate sessions
- Dispatch not using the default agent for the correct application
- "Play" icon not making it obvious Enter is also needed
- Session resume not working (should use Claude Code's continue feature)
- Status not updating immediately after dispatch (needs refresh)
- Dispatched items still showing as "new"
- Can't resume killed/exited sessions
- Need "auto-plan" mode where agent plans first, user reviews
- Container mode: clone repo, run dangerously, submit PR

**Action Plan**:
1. Fix dispatch deduplication: check if a session already exists for the same feedback item before creating a new one
2. Agent resolution: always use the app's default agent, not the global default; remove cross-app agent dropdown
3. Immediate status updates: dispatch endpoint should return the created session with status `starting`, emit WebSocket event for real-time UI update
4. Session resume: call Claude Code's `--continue` flag with the session ID, pass the previous JSONL as context
5. Auto-plan mode: add a `planFirst: true` option to dispatch that instructs the agent to output a plan and wait for approval before executing
6. Container mode: separate dispatch target type "container" that spins up a Docker container, clones the repo, runs the agent with `--dangerously-skip-permissions`, and creates a PR on completion

---

### Cluster 8: Remote Terminals, Machines & Harnesses
**Count**: 10 items | **Priority**: HIGH (current focus area)

**Item IDs**: [01KJQW3ZXFFWJC4NRWNQ841Q71], [01KJQ69BN55603MH4MC9DA40BB], [01KJPBX88G2NJZ10FC1RGWBDZM], [01KJKBZ2V4KYY6H9NRT432G6E3], [01KJK1F7F0D0NK0SD8M90BYXED], [01KJCZVNA4JPH0VFAB8H3JWKBG], [01KHAZ06BXD8D3Q3AC8FJ0KN7B], [01KHARGND9NCNX6J08F3FVS8TV], [01KHD4ATD03EAR0Q93XZJENE6M], [01KJ6BRNR9HX5G0G6ZVC6675HT]

**Recurring Sub-issues**:
- Remote session labels need machine/harness info in tooltip
- Terminal companion needs submenu for selecting remote machine or harness
- Need to load terminals on remote machines from settings and sidebar
- Setup assistant for SSH/harness configuration
- Docker harness for headless browser testing
- Agent endpoint UI too confusing — simplify to "Claude on laptop" vs "Claude on cloud"
- Default allowed permissions not applying correctly

**Action Plan**:
1. Remote session indicators: add machine hostname badge (emoji + tooltip showing `machine: dl, path: /home/amir/work/...`, PID)
2. Terminal companion picker: submenu with sections — "Local Terminals", "Remote Machines" (from machine registry), "Harnesses" (from harness configs)
3. Setup assistant flow: "Add Machine" → AI assist button → companion terminal opens SSH session → agent walks through setup (auth, capabilities, directory structure) → auto-fills machine config
4. Simplify agent endpoint UI: preset cards ("Local Claude Code", "Remote Machine", "Docker Harness") instead of raw configuration forms
5. Default permissions: store per-app permission profiles in the application config, inject into every dispatch for that app

---

### Cluster 9: Per-App Settings & Configuration
**Count**: 10 items | **Priority**: MEDIUM

**Item IDs**: [01KJK0SA4AWZGFFK7X8K55VK5C], [01KJGQSWH30Z1V8ZS1PEPAZJAH], [01KJBDARQEP42F7FFSTEM2DAKF], [01KHY7KEKQBQE9KDQ6T9VZX388], [01KHYAYT2R2YGNR7VEKMVHG1Y1], [01KHY50006V022PBE6BC7RA2RA], [01KJ3TSJR2R8Z8QSS1TYGCVNSP], [01KJ25D1XK7HG79G7XAB68E80F], [01KJ1YDP42RKG15YPYXD2H5ZGG], [01KHY2VANDWA9CFK9B4B4GGM0V]

**Recurring Sub-issues**:
- Applications settings under global settings instead of per-app
- Need per-app agent options, tmux options, widget options
- Tmux configuration not per-app
- Settings UI not scrollable
- Control bar overlay needs per-app custom actions
- pw-trigger preferences per app (draggable, hide behavior)

**Action Plan**:
1. Move application settings out of global settings into the per-app settings screen
2. Per-app config structure: `{ agent: { defaultEndpoint, permissions, planFirst }, terminal: { tmuxConf, defaultShell }, widget: { triggerPosition, hideOnIdle }, controlBar: { actions: [{label, command}] } }`
3. Make settings panels scrollable with sticky section headers
4. Control bar actions: define as `{label, icon, command}` tuples in app config, render as buttons in the control bar

---

### Cluster 10: Popout Panel System & Window Management
**Count**: 12 items | **Priority**: MEDIUM

**Item IDs**: [01KJK6Q5WVTEQC4GMD6JX9FR1R], [01KJGQY5TF96K3CVSC0SV32M35], [01KJGP3BXNE8S5F6826DM9SRFM], [01KJK116B7GSVZGQVSCSAY4X93], [01KJKQR0YH1ETH09HN1YQV3QQX], [01KJ1FB0B95BC78Y63WM32CNH3], [01KHZCRJYBV4588HW7CQYM87ZC], [01KJ2C8337HGJG50KRPCT9H4X7], [01KJK5HY3C627BRW4T76QVA6J7], [01KJK8P105FE3NSV4VGTPVZTWG], [01KJK73AAWG0N90WXWKPV81Y1Q], [01KJGKKYX0KTX4HA3ZS736H38C]

**Recurring Sub-issues**:
- Need maximize button (full height), not just minimize
- Panel options (popin, pin, min, left/right dock) should be a dropdown menu
- Unified pane model for tabs and popouts (single DRY component)
- Always-on-top checkbox for tabs and panels
- Close companion panel when switching away from its parent session
- No alerts/confirms for destructive actions — use undo-able list
- Popout tabs not showing when multiple exist
- Panel should overlay control bar ("how can i help" popup)

**Action Plan**:
1. Panel window controls: single dropdown menu next to close button with options: `Maximize | Restore | Pin to Top | Dock Left | Dock Right | Pop In | Minimize`
2. Maximize: panel takes full viewport height, button becomes "Restore"
3. Unified pane component: refactor `TabPanel` and `PopoutPanel` into a single `ManagedPane` component that supports both modes with shared tab bar, header, and content rendering
4. Companion lifecycle: when switching tabs, if the companion was auto-opened by the previous session, close it; if manually opened, keep it
5. Replace all `window.confirm()` calls with an undo-able toast pattern: action happens immediately, toast shows "Deleted machine X — Undo" for 5 seconds

---

### Cluster 11: Feedback List & Management
**Count**: 14 items | **Priority**: MEDIUM

**Item IDs**: [01KH384RCVR2XEJ28C5C3BKBB2], [01KJD2G6RNG7FM4NQVA05QACNT], [01KJBG099H3SS2B87RYBWJBAEE], [01KJBC8TMMCZ23Q0SKA3G78J2W], [01KJBE6R2C717XC9P3Z1YJ5FEV], [01KJ9Q50Z62TNMKYW00KREJPG6], [01KHZ9GCQFTKSN81G09406V8P0], [01KHYJ4VFJ31YHEJPBAS48ZQGM], [01KHYH3ZT50N5PSQ6A7TP0AK6X], [01KHYK5X1AYSQ8AM5GW2NJQ6Y2], [01KHY50WNGTRFMFDQY727XETK7], [01KHD4JEQQC3C4JQ6QP1WXM9GW], [01KHD4E12N76E8JTH91DD6SN5J], [01KHD4ATD03EAR0Q93XZJENE6M]

**Recurring Sub-issues**:
- Feedback not separated by application (all showing together)
- Filter pills ugly/need redesign
- Selection bar shifts content when checkbox is checked
- Need "dispatched session states" in sort options (idle, active, waiting)
- Truncation too aggressive — titles should stretch further
- Filter options should float/sticky when scrolled
- Feedback list not dynamically updating on new submission
- Need separate status for killed vs completed dispatches
- Duplicate menus (dispatch options in two places)

**Action Plan**:
1. Default view: per-app feedback (already exists at `/#/app/{appId}/feedback`), remove global unfiltered view
2. Filter bar: sticky at top during scroll, collapse into single-row pill bar, dispatch options slide in from right when checkbox is selected
3. Real-time updates: add WebSocket subscription for new feedback items, prepend with highlight animation
4. Dispatch status tracking: add sub-statuses to dispatched items: `dispatched.running`, `dispatched.waiting`, `dispatched.completed`, `dispatched.failed`
5. Title truncation: allow title to fill up to 70% of row width before truncating

---

### Cluster 12: Structured Session View & JSONL
**Count**: 8 items | **Priority**: MEDIUM

**Item IDs**: [01KJE1ZTZ69YNF75CQMJG74DQS], [01KJGM7XEJYBMZZ36QWRWH5VZ9], [01KJDPWRP6345GJMXPFHAWDBW8], [01KJDQ13HFRVAK58NBS7RNRAE8], [01KJC1TVT5QHNZJ8JBZETKS7TJ], [01KJ8EWM857S4YMA0T5H784Q9B], [01KJGP5NEQEA0R80JBE0P8MX16], [01KJKQVG7VBCBNEPPNZTGE0AYE]

**Recurring Sub-issues**:
- Structured view needs syntax highlighting, markdown rendering, image display
- JSONL companion stops tailing (file continues elsewhere?)
- Companion JSONL should always load in other split panel
- Opening one companion dropdown opens both panels
- Need to associate active session with its JSONL file path
- Clicking file names should open file in a new panel
- Session activity indexing (file tracking, time-based border coloring)
- Markdown support in views

**Action Plan**:
1. Structured view renderer: add syntax highlighting (Prism.js or highlight.js), markdown rendering (marked), and base64 image display for inline images
2. JSONL continuity: detect when a session continues in a new JSONL file (same session ID prefix), auto-follow the chain
3. File click handler: clicking a file path in structured view opens a `FileViewerPanel` as a companion or new tab
4. Activity indexing: background parser that extracts file paths from Read/Write/Edit tool calls, stores in SQLite `session_file_activity` table
5. Time-activity border: color strip at bottom of session card showing proportional time per tool category (gray=bash, blue=read, purple=edit, green=task)

---

### Cluster 13: Companion Panels & Terminal Picker
**Count**: 7 items | **Priority**: HIGH (recent development)

**Item IDs**: [01KJNTX4FSNHRFV0BKEEPCEFX2], [01KJNTC730FQ2QRY3MTKKS9Q8M], [01KJNTGD3QWTQHF7S60FYPBN49], [01KJKBZ2V4KYY6H9NRT432G6E3], [01KJM0VP2CZBPCFBNH5GWRE8V4], [01KJMX35SZVSNG0BEP7BB4YDVH], [01KJ1YXZG9P802W2QZM2F5YDW5]

**Recurring Sub-issues**:
- Feedback companion always fails to load feedback item
- Multiple companions conflict (can't add terminal companion when feedback companion exists)
- Companions should all be generic screens showing their main component
- Clicking ID labels should copy to clipboard
- Companion JSONL viewer needed
- MRU dropdown with focused session history
- Auto-load associated feedback when switching sessions

**Action Plan**:
1. Unified companion system: companions are just panes showing any component — FeedbackDetail, JSONL Viewer, FileViewer, Terminal
2. Fix feedback companion data fetching: ensure the feedback ID is resolved before mounting the component, add retry with exponential backoff
3. Multiple companions: allow N companions in a vertical stack on the right side, each independently closable
4. ID label click: always copies the full ID to clipboard with a brief "Copied!" toast
5. Session context loading: when switching to a session tab, auto-load its associated feedback item in the companion if "auto-load feedback" preference is enabled

---

### Cluster 14: Tmux Configuration & Terminal Behavior
**Count**: 8 items | **Priority**: MEDIUM

**Item IDs**: [01KJPBFCKWYCT2SAKREZZ72TDG], [01KJNTGD3QWTQHF7S60FYPBN49], [01KJ3NGW7CEZ04PTEECCF267PG], [01KJ3NF9W2GECE8R6QGS8PRN64], [01KHWQN0DXKFHDSQB0QKSFDPGV], [01KHWQE05XDHV5VXRFN003C8P7], [01KHYMXT8YN8Z0MY99EKEF9V5E], [01KHY2VANDWA9CFK9B4B4GGM0V]

**Recurring Sub-issues**:
- Scrollbar showing in terminal (tmux handles scrolling)
- Right-click context menu covering tmux
- Copy mode closes on mouse move (should stay until selection)
- Open in Terminal.app not working reliably
- Terminal colorscheme/theme not matching
- Junk characters in PTY (mouse escape codes)

**Action Plan**:
1. Hide browser scrollbar in terminal containers: `overflow: hidden` on xterm container, rely on tmux scrollback
2. Prevent right-click default: `e.preventDefault()` on contextmenu event in terminal, let tmux handle it
3. Fix tmux copy mode: ensure `.tmux.conf` has `set -g mouse on` with `bind -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-selection-no-clear`
4. Open in Terminal.app: use the proven `open.command` approach with sed substitution, make it a one-click button
5. Terminal theme: match xterm.js theme to the admin dashboard theme (dark mode colors)

---

### Cluster 15: Agent API Improvements
**Count**: 7 items | **Priority**: MEDIUM

**Item IDs**: [01KH5PFV6K82X9CRYVXEJ7NK1E], [01KH5PFV5QFZG9BN2R2WBT094K], [01KH5PFV533K099QZSKBJN5SNH], [01KH5PFV4EC5DX9ZZ5ZDSKZ17D], [01KJ1VWBTRACHEZH9Q273Q3F38], [01KHD4E12N76E8JTH91DD6SN5J], [01KH5PFV4VNH7PDEPNA8268JSD]

**Recurring Sub-issues**:
- Shadow DOM opaque to click/type commands
- No keyboard simulation (keydown/keyup events)
- Session discovery manual (no URL filter, no naming)
- No wait-for-ready primitives
- Need Playwright-level testing primitives
- Agent testing workflow too low-level

**Action Plan**:
1. Shadow DOM: add `pierceSelector` parameter that walks shadow roots: `host >>> .inner-element`
2. Keyboard simulation: implement full key event sequence (keydown → keypress → input → keyup) with modifier support — DONE for basic cases, extend to combo keys
3. Session discovery: add `GET /api/v1/agent/sessions?url=*admin*&tag=test-run-1` with URL pattern matching and session tagging
4. Wait primitives: `POST /api/v1/agent/sessions/:id/waitFor` with options: `{selector, text, timeout, networkIdle}`
5. High-level widget API: `POST /api/v1/agent/sessions/:id/widget/submit-feedback` that handles the full open-widget → fill-form → submit → close flow

---

### Cluster 16: Search & Navigation
**Count**: 5 items | **Priority**: LOW

**Item IDs**: [01KHYN1P4C19D83PEHACMX230H], [01KJ8MRJF7Q57E3N8K5FY8FEQ1], [01KJ8MPCBA02NW6ZGYV4G8W95C], [01KJBCC3ZFXR4J5B2J8WS9V33B], [01KJ6GPT8SDMTZ64CMHG6WZ9TX]

**Action Plan**:
1. Spotlight search (Ctrl-Shift-Space): search sessions, feedback items, applications in one unified search
2. Recent searches: show recent results (not terms), with match highlighting in light blue
3. Search result click should navigate to item without closing session list

---

### Cluster 17: Miscellaneous UI Polish
**Count**: 15 items | **Priority**: LOW

**Item IDs**: [01KJ25TQ20FHSPBS5W8YKTW8FR], [01KJ27KYTJXE5FNH7TZMQPM1D7], [01KJ27BW0M1PS3MBJNVXE4C8KT], [01KJ26TT58ZQB22NTXHQQ6A4KB], [01KJ1TCRHME6V7SKQZA03YBTQA], [01KJ1YJMMB3NKVQQ8P670R0BM5], [01KJ29ETHHA6H9HWYVJ00Q2A02], [01KJ292S4ASBHKCQZAVPRPB1N0], [01KJ29HHPRDJM3YNR73X03J72T], [01KJD2BSGFW5GW73557AJX8M9P], [01KJDRWFYCGMCXGHEEZ674ETR8], [01KHYRE8PDVAYCYJWA3APH34TW], [01KHYAHG61NE4RBV7SB8ZAGX4Q], [01KJ8KSKNTFCRH7HFCQJ68WQ66], [01KJ4JD963A7YJGTAYBXTSEJG5]

**Action Plan**: Consolidate into a UI polish sprint: favicon, collapsible sections, Esc-to-close on all modals, background transparency fixes, smooth tab scroll animation on reload, text wrapping/max-width, draggable title elements, resolve/kill color coding (green/red), process name in window titles.

---

### Cluster 18: Empty/Debug/Deleted Items (Skip)
**Count**: 15 items | **Priority**: SKIP

**Item IDs**: [01KJGT7GBKQG7QJFX5N39BMR18], [01KJD368N2CDR265TY0QRPWZSS], [01KJDSEZCGE486TG4ZAZQBMC6J], [01KJ8J87C29ND7PM931VWW2BCT], [01KJ670092EDXR5P3QM70D2470], [01KJ6EB2RXC21RPV17J7E7X4X8], [01KJ1VWBTRACHEZH9Q273Q3F38] (test items), [01KJ1VG9QQ1A1CRQXWEB1JQ8GE], [01KJ1S738BP1SNSQV1HWTEE3D1], [01KJ1WCWPPD990Y8DFQPQB923M], [01KJ1VPZP93V33DVAVT47DE4P7], [01KHZ91ZD5SS1CBQWPME0S8D25], [01KHWWMX519M8Y5HTYEXTC95AP], [01KHS4FKRC621897X4BCKHKX2J], [01KHPXBES7N2785HEY7J6TYCZ5], [01KHKWJ5RWW2DTBP3W6ZC6TAW1], [01KHJJ5XYSPKD9J4SKHMN18YPD], [01KHYKMGWZZ4AKA8CRAW9QRMPW]

These are test submissions, empty items, debug dumps, or automated analysis items. No action needed.

---

## Part II: Session Log Temporal Analysis

### Development Timeline & Focus Shifts

```
Week 1 (Feb 8-14):  FOUNDATION
  6 sessions → 30 sessions
  Focus: Widget + Server + Admin + Agent Dispatch
  Keywords: feedback(157), agent(146), widget(131), session(128)

Week 2 (Feb 15-21):  TERMINAL IDE
  52 sessions on Feb 20 alone
  Focus: Terminal panels, popouts, structured views, sidebar
  Keywords: feedback(521), widget(448), session(364), terminal(191), popout(110)

Week 3 (Feb 22-28):  SESSION ORCHESTRATION
  53 sessions on Feb 23 (peak day, 220MB of logs)
  Focus: Waiting detection, auto-jump, image editor, control bar
  Keywords: session(1347), waiting(387), auto-jump(203), screenshot(235)

Week 4 (Mar 1-2):   REMOTE & COMPANION
  21 sessions
  Focus: Companion terminals, MRU history, remote harness, machines
  Keywords: terminal(80), companion(49), harness(19)
```

### Frustration Heatmap

| Date | Frustration Signals | BrowserMCP Corrections | Request Interruptions |
|------|---------------------|------------------------|-----------------------|
| Feb 19 | 4 | **7** | **19** |
| Feb 20 | 3 | 2 | **19** |
| Feb 22 | 1 | 4 | **30** (peak) |
| Feb 23 | **6** (peak) | 3 | **28** |
| Feb 26 | 2 | 0 | 14 |

**Insight**: Feb 22-23 was the highest-friction period. The waiting-for-input detection went through 5+ implementation approaches in a single day. BrowserMCP corrections dropped after Feb 23 once CLAUDE.md instructions were added.

### Top 5 Recurring Issues (Cross-Session)

1. **BrowserMCP vs Widget Screenshot** — corrected 23+ times before CLAUDE.md fix
2. **Waiting-for-Input False Positives/Negatives** — 5+ implementation approaches, still fragile
3. **Terminal Disconnect/Reconnect** — recurred Feb 12, 22, 23, 27
4. **Panel Resize Bugs** — recurred Feb 22, 26, 28, Mar 1
5. **Dispatch Failures** — recurred Feb 12, 22 (bad gateway, missing prompt)

### Feature Evolution Map

| Feature | Started | Iterations | Current State |
|---------|---------|------------|---------------|
| Terminal Panel | Feb 9 | 7+ (embed→global→tabs→popout→split→companion→MRU) | Stable but complex |
| Screenshot | Feb 9 | 4 (html-to-image→getDisplayMedia→annotation→crop) | Works, some edge cases |
| Waiting Detection | Feb 23 | 5+ (bell→tmux flag→OSC→pipe-pane→3-state) | Functional but fragile |
| Panel Architecture | Feb 19 | 7+ (embed→popout→dock→split→companion→unified) | Most iterated subsystem |
| Dispatch | Feb 9 | 3 (webhook→local tmux→remote machine) | Working |
| Feedback Widget | Feb 8 | 2 (basic→advanced options) | Stable, UX needs polish |
| Aggregation | Feb 18 | 1 (LLM clustering) | Built, mostly untouched |

### What Was Steered Away From

1. **BrowserMCP for screenshots** → replaced with widget's own capability
2. **Headless agent mode** (`claude -p`) → replaced with interactive PTY sessions
3. **Chat-style feedback input** → built but attention moved to terminal management
4. **Getting Started onboarding** → deprioritized in favor of feature development
5. **Aggregate/clustering view** → built early, then left mostly untouched

---

## Part III: Forward-Looking Specification

### What the Project Has Become

Prompt Widget started as a "feedback overlay for web apps" and evolved into an **agent session management IDE** with these core capabilities:
1. **Feedback Collection** — embeddable widget with screenshots, DOM selection, console capture
2. **Agent Orchestration** — dispatch, monitor, and interact with AI agent sessions
3. **Terminal Management** — multi-session tmux management with auto-jump and companion views
4. **Remote Execution** — dispatch to local machines, remote SSH targets, Docker harnesses

### Recommended Next Priorities

#### Priority 1: Stability & Testing (Immediate)
**Rationale**: The session logs show a "commit and push, fix later" pattern. Many features are fragile (waiting detection, panel resize, companion loading). Before adding more features, stabilize what exists.

1. **Component-level E2E tests**: Use the harness system to test panel operations, tab switching, companion loading, and auto-jump in a contained browser
2. **Waiting detection test suite**: Record terminal output fixtures for each waiting pattern, run detection against them in CI
3. **Panel resize regression tests**: Automated tests for resize, dock, undock, split, and companion open/close
4. **Screenshot capture tests**: Verify widget inclusion/exclusion, cursor handling, timed capture

#### Priority 2: CI/CD Pipeline
**Rationale**: No CI/CD was mentioned in any session. All testing is manual through the embedded widget.

1. **Build validation**: `turbo build` on push, fail on TypeScript errors
2. **Harness-based UI tests**: Spin up a Docker harness, load the admin page, run scripted interactions via the agent API, assert on screenshots
3. **Deploy pipeline**: Build → test → deploy to staging → smoke test → production
4. **JSONL regression**: Compare structured view rendering against snapshot fixtures

#### Priority 3: Agent Autonomy Features
**Rationale**: This is where the user's vision is heading (container mode, auto-plan, remote dispatch).

1. **Auto-plan mode**: Agent creates a plan file, displays it for approval, then executes on approval
2. **Container dispatch**: One-click "clone repo + run agent in Docker + submit PR" workflow
3. **Multi-agent coordination**: Allow multiple agents to work on different feedback items simultaneously, with a dashboard showing all active agents
4. **Agent learning**: Track which feedback patterns lead to successful resolutions, suggest similar approaches for new items

#### Priority 4: Team & Hosting
**Rationale**: The tool is currently single-user on localhost. To be useful beyond the developer's own workflow:

1. **User roles**: Admin (full access), Developer (dispatch + view), Viewer (read-only)
2. **Authentication**: JWT with refresh tokens, OAuth2 for team sign-in
3. **Multi-tenant hosting**: Application isolation, per-team databases
4. **Webhook integrations**: Slack notifications for waiting sessions, GitHub PR creation on agent completion

#### Priority 5: Validation & Guardrails
**Rationale**: The session logs show the user wants agents to operate more autonomously, which requires safety guardrails.

1. **Permission profiles**: Pre-defined security levels (read-only, restricted, standard, dangerous) with per-file and per-command allowlists
2. **Output validation**: Before an agent's changes are applied, run lint/typecheck/test and present results
3. **Rollback capability**: Git-based undo for any agent session's changes
4. **Cost tracking**: Track API token usage per session, set budgets per dispatch

### Specification Guardrails for Development

Based on the patterns observed in the session logs, these guardrails would prevent the most common issues:

1. **No new panel/layout features until existing ones have E2E tests** — panel architecture has been iterated 7+ times; further changes without tests will regress
2. **Waiting detection changes require test fixtures** — the feature went through 5+ approaches; any change must pass a suite of recorded terminal output tests
3. **Screenshot changes must be tested with and without widget overlay** — this kept breaking
4. **Dispatch flow changes must update status in real-time** — the "needs refresh" pattern is a perennial complaint
5. **Every new keyboard shortcut must be registered in the shortcut registry** — conflicts (Ctrl-Shift-P) caused confusion
6. **Companion panels must be tested for: open, close, switch-away, switch-back, resize** — companion loading failures are frequent

---

## Summary Statistics

| Category | Count |
|----------|-------|
| Total feedback items analyzed | 278 |
| Actionable clusters identified | 17 |
| Empty/test/debug items (skip) | ~18 |
| Items marked resolved | ~160 |
| Items still dispatched/new | ~80 |
| Session logs analyzed | 419 |
| Peak sessions in one day | 53 (Feb 23) |
| Peak log volume in one day | 220.7 MB (Feb 23) |
| Most iterated feature | Panel architecture (7+ iterations) |
| Most recurring bug | BrowserMCP confusion (23+ corrections) |
| Hardest feature | Waiting-for-input detection (5+ approaches) |
