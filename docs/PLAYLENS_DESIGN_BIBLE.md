# PlayLens Design Bible

Design direction v1 · 30 September 2026

This is the canonical visual and interaction specification for PlayLens. The Masterbrain remains authoritative for model, data, and engineering contracts. This document defines their product presentation. Numerical examples are illustrative, never claims about implemented capabilities or measured performance. A capability appears as available only when its backing data or service exists.

## 1. Product Design Thesis

PlayLens is a precise instrument for studying movement. Its identity comes from a large, legible football field; disciplined typography; a temporal workspace; and evidence that can be inspected at the point of a claim.

The visual direction is **graphite, chalk, and restrained amber**. Graphite surfaces recede. Chalk players and markings describe observed play. Amber identifies the current analytical focus and model output. Muted field green belongs exclusively to the playing surface.

The experience should feel calm before it feels powerful. A user first sees what happened, then chooses what to investigate, then inspects what a model or Analyst adds. Every deeper layer preserves the play, frame, player, and source that give the information meaning.

## 2. Design Principles

1. **The field leads.** Replay, Compare, and PlayLab allocate the largest continuous region to spatial information. Metadata and controls support that region.
2. **Time is shared context.** The current frame and prediction origin are explicit. Evidence links lead back to an identifiable moment.
3. **Typography carries hierarchy.** Weight, size, alignment, and spacing precede backgrounds and borders.
4. **Reveal detail through intent.** Hover previews; selection persists; overlays add a specific analytical layer; the Analyst explains with evidence.
5. **Color has a job.** Amber means focus, action, or prediction. Team identity primarily uses names and shapes. Status colors appear only for status.
6. **Evidence types remain distinct.** Observations, predictions, counterfactuals, and interpretation retain visible labels and different graphic treatments.
7. **Controls describe consequences.** Use “Run inference,” “Jump to frame,” and “Show predicted path.” Avoid vague actions such as “Discover insights.”
8. **The instrument remains stable.** Seeking, loading, opening a panel, and streaming text must not unexpectedly move the field or steal focus.
9. **Absence is information.** Missing events, unavailable models, small samples, failed tools, and incomplete tracking receive explicit states rather than plausible substitutes.

## 3. Visual Identity

**Color palette — dark theme only for v1.** These are semantic tokens, not a collection of interchangeable grays.

| Token | Value | Purpose |
|---|---|---|
| Background | `#101214` | Application canvas |
| Surface | `#171A1D` | Inspectors, field surround, table header |
| Elevated surface | `#202428` | Menus, popovers, tooltips |
| Hover surface | `#252A2F` | Interactive row or control hover |
| Selected surface | `#302A20` | Selected rows and segmented controls |
| Subtle border | `#343A40` | Structural separators; not a control's sole affordance |
| Control border | `#737D87` | Input edges and meaningful control outlines |
| Primary text | `#F2F4F5` | Titles, values, active controls |
| Secondary text | `#B7C0C8` | Body support, labels |
| Muted text | `#8D98A3` | Metadata, captions, available placeholders |
| Accent | `#E7B66B` | Selected indicator, prediction, primary action |
| Accent hover | `#F0C889` | Primary action hover |
| Accent foreground | `#101214` | Text on filled accent controls |
| Success | `#8DC3A7` | Completed or healthy status, with text |
| Warning | `#E7B66B` | Caution, always with triangle and wording |
| Error | `#F09494` | Failure, with icon and actionable message |
| Field | `#142923` | Playing surface only |
| Field markings | `#728D81` | Yard lines and hash marks |
| Field labels | `#A8BCB2` | Yard numbers and field metadata |

Use opaque UI surfaces. Alpha is reserved for analytical layers and transient modal scrims. The accent should occupy less than roughly 5% of ordinary application chrome; prediction geometry is exempt. Default team rendering does not introduce team colors.

**Typography.** Use Geist Sans with system sans fallback, and Geist Mono with system monospace fallback. Use weights 400, 500, and 600. No condensed sports type, italic display headings, gradient text, or text wider than its role requires.

| Role | Size / line height | Weight | Family |
|---|---|---|---|
| Page title | 24 / 32 px | 600 | Sans |
| Section title | 18 / 24 px | 600 | Sans |
| Panel title | 14 / 20 px | 600 | Sans |
| Body | 14 / 22 px | 400 | Sans |
| Secondary body | 13 / 20 px | 400 | Sans |
| Control / label | 12 / 16 px | 500 | Sans |
| Inline primary metric | 20 / 28 px | 500 | Mono |
| Metadata / numeric cell | 12 / 18 px | 400 | Mono |
| Caption | 12 / 18 px | 400 | Sans |

Monospace is reserved for frames, time, coordinates, distances, probabilities, model versions, IDs, latency, down/distance, and quarter/clock. Names, explanations, navigation, and ordinary labels use sans. Numeric columns use tabular figures and right alignment. Units remain adjacent to values. Long identifiers truncate visually and expose their complete value on focus, hover, and copy.

Sentence case is standard. Evidence category labels may use 11 / 16 px uppercase, weight 600, tracking 0.06em; these are short supplementary labels, never the only place a distinction is communicated. The wordmark is “PlayLens,” 16 / 24 px, weight 600, tracking -0.02em.

**Spacing.** Use `4, 8, 12, 16, 24, 32, 48, 64 px`. Four aligns icon/text details; eight groups closely related controls; 12–16 structures a panel; 24 separates functional groups; 32–48 separates report sections. Do not introduce bespoke gaps to repair a weak layout.

**Radii.** 0 px for field geometry and charts; 4 px for buttons, inputs, labels, and menus; 8 px for drawers and dialogs only where an outer corner is exposed. Player tokens are circles. Pills are reserved for a true binary switch track, not navigation, filters, or ordinary buttons.

**Borders and elevation.** Use 1 px separators only at structural boundaries. Do not border every section. Inputs have a control border; flat buttons can establish their shape with fill and a label. Use no shadows in the main layout. Menus and floating inspectors may use `0 8px 24px rgba(0,0,0,0.24)`. Focus rings are not shadows or glows.

**Iconography.** Use Lucide outline icons consistently, normally 16 px with 1.5 px stroke; 20 px in a 40 px replay button. Pair unfamiliar actions with text. The Analyst uses a text trigger with a small panel icon. No sparkles, robot avatar, trophy decoration, or football-shaped logo is required.

**Common states.** Hover adds the hover surface without translation. Selection adds selected surface plus a 2 px amber edge or underline and an accessible selected state. Focus uses a 2 px amber ring with a 2 px background gap. Disabled actions use a readable muted label, muted boundary, and a nearby reason when availability is consequential; do not fade an entire panel. Loading preserves geometry with static tonal placeholders and a small progress label. Empty states explain the missing content and one useful next action. Errors appear at the affected region, retain existing usable content, and offer a specific retry. Toasts are for brief acknowledgments such as “Link copied,” not the only record of a failure.

**Imagery.** The field and real analytical graphics provide the imagery. Do not add stadium photography, stock players, decorative heatmaps, or generated sports illustrations. Team marks, if later introduced from an approved asset source, are optional small identifiers, never wallpaper.

## 4. Layout System

The application has a 56 px top navigation and a centered workspace capped at 1680 px. Explore and Evaluation cap at 1280 px. Reading columns cap at 680 px. Widths include internal columns but exclude outer page padding.

| Viewport | Outer padding | Grid gap | Workspace behavior |
|---|---:|---:|---|
| 1600 px and up | 32 px | 24 px | Expanded workbench |
| 1440–1599 px | 24 px | 24 px | Primary desktop composition |
| 1280–1439 px | 24 px | 16 px | Compact workbench |
| 1024–1279 px | 16 px | 16 px | Field-first, details below |
| 768–1023 px | 16 px | 16 px | Stacked tablet workspace |
| Below 768 px | 16 px | 12 px | Review and discovery mode |

Use a 12-column grid for page composition, but do not force the field to arbitrary column spans. Play and PlayLab use a flexible field column plus a fixed inspector: 320 px at 1440 and up, 288 px at 1280–1439. The Analyst replaces that inspector with a 384 px pane at 1440 and up, or 360 px at 1280–1439. Never show inspector and Analyst as two simultaneous right rails.

At 1440 px, the usable 1392 px workbench gives Play a 1048 px field column, a 24 px gap, and a 320 px inspector. With Analyst open, the field column is 984 px. At 1512 px, these become 1120 px and 1056 px. At 1728 px with 32 px outer padding, the default field column is 1320 px. Size the field stage at a preferred 16:9 aspect ratio, capped at 640 px high and fitted within the stage; never distort physical coordinates to fill it.

Play's vertical stack is 56 px navigation, a 72 px play heading, a 40 px field toolbar, the field stage, and a 96 px replay dock. At short window heights, reduce the stage to keep the dock visible where possible; allow normal page scrolling before shrinking the stage below 300 px. Secondary material follows below. Do not lock the whole page to viewport height or make the timeline disappear behind a drawer.

Use one page scrollbar. Only a tall inspector, Analyst transcript, or open menu may scroll internally. Keep its heading and essential controls stationary. Headings, field edges, timeline edges, and support sections share alignment lines.

## 5. Global Navigation

The left side reads **PlayLens · Explore · Evaluation**. PlayLens returns to Explore. The right side contains **Analyst** and a compact keyboard-shortcuts control. There is no permanent sidebar.

Explore and Evaluation are destinations. Play, Compare, and PlayLab are contextual workspaces reached through a play. A second line within the page heading shows a breadcrumb such as `Explore / Play …` or `Play … / Compare`; it is not another global navigation bar. A Play heading exposes `Compare` and `Open PlayLab` as quiet actions.

The active global destination uses primary text and a 2 px amber underline at the bottom of the navigation. Hover changes the background without moving the underline. Inside a play workspace, neither Explore nor Evaluation is falsely marked active; the breadcrumb provides location.

Opening Analyst captures the current workspace context. On Explore it can help with available search tools; it does not pretend a play is selected. On Evaluation it can reference the report's model and run. Closing it returns focus to its trigger and preserves the question history for that context.

Below 768 px, retain the wordmark and Analyst text action; group Explore and Evaluation in a labeled navigation menu. No bottom tab bar.

## 6. Explore Screen

**Goal:** locate a useful play and enter replay quickly.

Use a search-led index, with a 72 px page heading followed by a 40 px search input spanning up to 640 px. Search supports identifiers, teams, and supplied play-description text. Do not imply semantic natural-language search before a backing service exists. Place a 36 px filter row 16 px below search: season, offense, defense, down/distance, play type, then More filters. Filters are rectangular controls; active values appear in their control labels. Put Clear filters at the end.

Below a 24 px gap, show the result count and sort control. Default sort is most recent game, then play order. Similarity entry changes sorting to similarity and names the source play and retrieval model. Use explicit pagination with 50 results per page; retain filters, sort, and page in the URL.

Results are a 56 px-high list/table with no outer card, 12 px cell padding, and separators between rows. The first column carries matchup and a one-line supplied play description. Remaining columns show quarter/clock, down/distance, outcome when known, and a quiet preview action. A trailing Compare action appears on focus as well as hover. Metadata cannot be larger or brighter than the play identity.

The play title is the primary link. Clicking it or pressing Enter when it is focused opens Play. A dedicated preview control opens a 360 px side pane at 1440 and up; below that it expands a preview beneath the row. Preview is a static snap frame with metadata and an Open play button, never autoplay on hover. An explicitly started preview may replay. Remember the result list's scroll position when returning from Play.

Recent plays are at most three compact text rows above the results on the initial unfiltered visit. Hide that group during an active search. No tile gallery.

```text
PlayLens    Explore  Evaluation                              Analyst
-------------------------------------------------------------------
Explore
[ Search teams, play descriptions, or play ID                  ]
[Season v] [Offense v] [Defense v] [Down / distance v] [More v]

Recent   Play reference     Play reference     Play reference
Results: {count}                                  Sort: Recent v
-------------------------------------------------------------------
Matchup / description          Q / clock    Down / dist   Result
Team A at Team B                Q2 06:18     3rd & 7       +12 yd  >
Supplied play description...
-------------------------------------------------------------------
Team C at Team D                Q1 10:04     2nd & 4        +3 yd  >
Supplied play description...
-------------------------------------------------------------------
Previous                         Page {n} of {n}               Next
```

Loading shows six static row placeholders in the existing table. Updating filters keeps old rows visible but marked “Updating results”; stale rows cannot be mistaken for the new result set. No matches shows “No plays match these filters” and Clear filters. No ingested data shows “No tracking plays available” with dataset status if exposed by the API. A request failure preserves filters and provides Retry search. Cancel superseded searches and commit only the latest response.

## 7. Play Screen

**Goal:** understand one play in space and time, then inspect a specific relationship or prediction.

**Heading.** The 72 px heading contains breadcrumb, matchup, and a one-line supplied description. Its second line is compact mono metadata: quarter/clock, down/distance, field position when supplied, and play ID. Keep game clock distinct from replay time. Right-align Compare and Open PlayLab. Do not put statistics in separate boxes above the field.

**Field toolbar.** A 40 px row immediately above the stage contains View (`Action` or `Full field`), Fit, and Overlays. At the right it shows a compact legend and the current mode: Observed replay or Forecast review. Overlays opens a grouped checklist with labels, not an unlabeled icon strip. Selected layers remain summarized in one quiet line. Default replay has player tokens, ball, yard markings, supplied events, and no analytical overlays.

**Viewport.** The default Action view uses a stable camera determined by the observed sequence extent plus 5 yd padding. It may crop irrelevant field space but must include all tracked players across the replay, within field bounds. In forecast review, compute the initial framing from the allowed observed prefix, not the hidden future. Fit recomputes framing only on explicit request. Full field preserves the entire 120 × 53⅓ yd geometry and letterboxes within the stage. The camera never automatically follows a player or zooms when selected.

Normalize presentation so offense moves left to right. Show `Attack →` and `Direction normalized` in the field corner. This is a display transform; source coordinates and provenance remain available in the inspector. Do not infer direction if metadata cannot establish it. A compact orientation control allows Source view, with a persistent label when active.

**Replay dock.** The dock is attached directly below the stage. Its upper 40 px row has Play/pause, Previous frame, Next frame, speed (`0.25×`, `0.5×`, `1×`, `2×`), elapsed time relative to snap, and source frame ID. The lower 56 px region contains an observed-duration rail, event markers, a 2 px amber playhead, and keyboard-focusable seek control. Use real timestamps. A missing snap changes the time origin label to `From recording start`.

The seek target is at least 32 px high even when the rail is only 4 px. Clicking or dragging seeks immediately and pauses; the user explicitly resumes. Tooltips show time, source frame, and event. Snap, throw, and arrival/catch markers use distinct shapes plus text. Close markers stack into two label lanes; never overwrite each other. Loop is optional and off by default. Reaching the final frame stops.

**Inspector.** The default 320 px rail is separated by one vertical rule, with 16 px internal padding. It has a persistent heading and three plain sections: Play context, Model availability, and a cue to select a player. Selecting a player changes the heading to jersey/name/role and shows current position, speed, nearest-opponent distance, and relevant modeled outputs when available. Missing fields read “Unavailable.” The selected frame and player ID remain at the top while the content scrolls. Press Escape to clear selection when no higher-level popup is open.

Player hover shows a compact anchored tooltip after 150 ms: jersey/name, side/role, and current speed. It does not open the rail. Player selection persists through playback and seeking; an absent player at a later frame is labeled “Not tracked at this frame,” without an invented position. Keyboard users get the same selection through a roster list linked to the field.

**Forecast review.** Activating Predicted path pauses playback and opens a compact model control group in the inspector. The user chooses an eligible forecast origin and a supported horizon. Show observed input window, model version, and horizon before results. The origin remains pinned while the user reviews subsequent observed frames. Future data beyond that origin is explicitly `Observed future`; enabling it cannot silently change model input. Scrubbing before the origin exits forecast review with a visible mode change, preserving the last forecast for re-entry. Selecting a new origin requires an explicit Update forecast action.

Predictions are opt-in, normally for the selected player. Uncertainty requires a compatible model output. “Show observed future” is a separate toggle. Results show input window, valid horizon, latency, and an Evaluation link; do not show a meaningless single “confidence” value. Failed inference leaves the observed replay usable.

**Below the dock.** One aligned evidence strip shows selected-player separation, relative speed, and forecast error only when defined. A Similar plays section follows with five 48 px rows, retrieval scope/model metadata, score, Open, and Compare. These sections can scroll below the fold; they do not compete with the field's first-screen prominence. Similarity retrieval starts on request, with a Find similar plays action, rather than implying a result is always available.

**Analyst.** Opening Analyst replaces the inspector. Selection persists, and a compact selected-player context line appears in the Analyst header. Closing restores the previous inspector state. The field, toolbar, dock, orientation, current frame, and provenance category remain visible while interacting.

```text
PlayLens    Explore  Evaluation                              Analyst
-------------------------------------------------------------------
Explore / Play {id}                         Compare    Open PlayLab
Team A at Team B · Supplied description
Q2 06:18   3rd & 7   Ball position   Play {id}
-------------------------------------------------------------------
[Action v] [Fit] [Overlays]              Observed replay | Player
                                                       | #18 Name
  Attack ->                                            | Role
  +-----------------------------------------------+    | Frame {id}
  |           |           |           |           |    |
  |       o        o      |      o                 |    | OBSERVED
  |   o       o     <>    |          o             |    | Speed
  |       o        o      |      o                 |    | Separation
  |           |           |           |           |    |
  +-----------------------------------------------+    | MODEL
                                                       | Availability
[Play] [<] [>] 1x          +{t}s       Frame {id}        | [Prediction]
------S----------T--------------A----------|---------   | [Ask Analyst]
      Snap       Throw          Arrival                |
-------------------------------------------------------------------
Evidence at selected frame · source / definition available
Similar plays                                      Find similar plays
Matchup / play reference            Cosine {score}     Open   Compare
```

**Failure and loading.** Keep the stage dimensions while loading and label “Loading tracking frames.” Do not animate invented player motion. Missing tracking intervals appear as hatched timeline gaps; pause before crossing them and offer Skip gap. A missing ball remains absent with a note. Do not silently bridge analytical gaps. If the renderer fails, retain a frame/player table and metadata, plus Retry replay.

## 8. Compare Screen

Use the full workspace width with two equal columns and a 24 px gap, reduced to 16 px below 1440. Each column has a 48 px play header, source ID, and field with identical coordinate scale, orientation, viewport extent, and overlay choices. A longer play must not appear more spread out because its camera independently zoomed out. Compute a common framing extent in the two display coordinate systems. Do not translate actual field locations into false alignment.

Default synchronization is elapsed seconds from snap. If either snap is missing, explicitly switch to “From recording start” for both plays. Offer normalized phase only when the necessary event anchors exist; label it “Phase aligned · playback speeds differ.” Source timestamps and frames remain visible for both sides. Do not invent phase events.

A shared 96 px replay dock spans both columns. Its two event lanes show each play's markers, with one common cursor. After one play ends, hold its last valid frame and label Ended while the other continues. An Unlink control allows independent seeking and exposes two local docks; Relink restores the left play's time reference. Preserve each play's native sampling without implying frames are simultaneous measurements.

Below the dock, show similarity as text: `Cosine similarity {0.000} · retrieval model {version}`. It is neither a percent nor a probability. No circular gauge or arbitrary “92% alike” label. Structural differences are a three-column table: Measure, Left, Right, with a signed delta and units. Include only computed measures, the comparison window, and source definitions.

Selecting a player highlights an available computed correspondence with a thin ring and labels the mapping method. If no correspondence exists, the user can choose a manual counterpart; identify it as Manual pairing. Never suggest a mapping is ground truth or a defensive assignment. Divergence markers appear only for an available defined measure and threshold, with the measure exposed on hover/focus.

Opening Analyst changes the layout to a 384 px right pane only if each remaining field would stay at least 480 px wide; otherwise it uses the lower-pane behavior in Section 17. An action from a comparison response names both play IDs and the alignment mode.

```text
PlayLens    Explore  Evaluation                              Analyst
Play {id} / Compare                             Replace right play
Alignment: Snap-relative v                          [Linked]
-------------------------------------------------------------------
LEFT · Play {id}                   RIGHT · Play {id}
Team / clock / down                Team / clock / down
+-----------------------------+    +-----------------------------+
|     o        o              |    |     o          o            |
|        o    <>     o        |    |         o <>      o         |
|     o           o           |    |      o        o             |
+-----------------------------+    +-----------------------------+
Frame {left} · +{t}s               Frame {right} · +{t}s
[Play] [<] [>] 1x                                  [Unlink]
Left  ---S--------T-----------A--------|------------------------
Right ---S----------T------------A-----|------------------------
Cosine similarity {score} · model {version} · window {scope}
-------------------------------------------------------------------
Structural differences         Left          Right         Delta
Defined spacing measure        {value}       {value}       {value}
```

Loading or failure affects the relevant half. The other play remains inspectable; linked playback waits until both are valid. Missing measurements display an em dash with an explanatory label, not zero.

## 9. PlayLens Analyst

The Analyst is an analytical notebook beside the current object. Its default desktop width is 384 px, with 16 px internal padding. It replaces Play's inspector. It is a nonmodal pane: no page scrim, no dimmed field, no floating chat launcher.

Its 48 px header reads “Analyst,” includes Close, and shows a compact context line beneath it: play or comparison, selected player, and frame. Each submitted question snapshots its context. Changing the selection updates the next-question context but never rewrites older evidence. A context change is indicated beside older results.

Questions appear as plain text, 14 px, weight 500, separated by 24 px spacing. Responses use 14 / 22 px text, usually a short conclusion followed by evidence. No speech bubbles, assistant portraits, typing dots, or alternating colored containers. Dense technical detail lives in an expandable Sources row.

Each response has up to four visible evidence rows, then “Show all evidence.” Generative UI is limited to compact play references, comparison references, metric rows, and action buttons. A bottom composer is 80 px minimum, grows to 144 px, then scrolls. Enter sends; Shift+Enter adds a line. Include a Stop control during an active request. Keep a two-line failure message near the failed response with Retry.

During tool execution, show real progress such as “Reading selected frames” only when that operation is reported. Never manufacture progress percentages or tool success. Keep partial responses visually marked In progress. Do not mount an actionable evidence block until its complete payload and provenance are validated. Append streaming text without moving focus. Follow the bottom only when the user is already there; otherwise show New response below.

```text
Analyst                                               [Close]
Play {id} · Player {id} · Frame {id}
------------------------------------------------------------
Why did this receiver become open?

AI INTERPRETATION
The observed spacing increased during the selected window.
The evidence supports separation, not a claim about intent.

OBSERVED DATA · Frame {id}
Separation                         {value} yd           [1]
Relative velocity                  {value} yd/s         [2]

[Jump to frame {id}]  [Show nearest opponent]
Sources (2) v

MODEL PREDICTION · {model version}
Forecast summary and supported horizon, when available.
------------------------------------------------------------
[ Ask about this play...                                   ]
Context: current play / player / frame                [Send]
```

An unavailable Analyst shows a concise service state and retains earlier responses. Replay and model controls remain usable. An empty Analyst offers two contextual prompts as text links, such as “Explain this player's separation” and “Find similar plays,” only when those tools are available.

## 10. PlayLab

PlayLab is a constrained experiment with one defender at one permitted pre-snap frame. The heading reads “PlayLab” with source play metadata and a persistent line: **“Model counterfactual, not causal inference.”** This line remains visible in editing and results, and accompanies shared or exported results.

Entering PlayLab pauses at the configured editable frame. If there is no supported frame/model combination, show the reason and Return to play. Never choose a plausible frame on the user's behalf. The timeline shows the editable marker; playback is unavailable during an active edit. A Back to replay action leaves the workspace without modifying source tracking.

The right inspector has a defender selector, original and modified coordinates, displacement, model/horizon metadata, validation text, and Run inference. Eligible defenders receive a neutral ring when hovered or keyboard focused. Selecting one exposes its allowed movement region: intersection of field bounds, model-configured displacement radius, and any supplied eligibility constraints. Show the actual limit in yards. The UI must not invent a universal permitted radius.

Dragging uses a grab/grabbing cursor and a 44 px pointer target. A dashed neutral ghost remains at the original position. The proposed token is filled amber with a dark label; a thin connector and `Δx / Δy` readout relate it to the original. Invalid destinations get a stop glyph, error outline, and reason. Releasing outside the allowed region restores the last valid position and announces why. No elastic bounce. Numeric coordinate inputs and arrow-key movement provide an equivalent interaction; arrows move 0.25 yd, Shift+arrow 1 yd, subject to the same validation.

Run inference is enabled only after a valid, changed position exists. Its label remains “Run inference,” followed by “Running inference…” during submission. Keep the source model version, input window, and horizon identical for original and modified predictions. Results remain associated with the exact edit that produced them. Further edits mark existing results Out of date and require another run; stale results cannot appear current.

Original prediction is neutral dashed; modified prediction is amber dashed. End labels identify them. The original ghost persists. Show uncertainty for only one selected variant at a time. Observed future is off by default; if enabled it is labeled “Observed source play · not a modified outcome.” An inline comparison table shows displacement and supported prediction differences, not claims of a prevented catch or optimal defense.

Reset edit returns the defender to its source location and clears the active counterfactual result. It is reversible through a short-lived Undo action and needs no confirmation modal. Only one defender can be modified: changing selection after editing offers an explicit “Reset edit and select” action in the rail. A failed inference retains the valid edit and offers Retry. An out-of-distribution warning remains attached to its result; a server-rejected edit cannot run.

```text
PlayLens    Explore  Evaluation                              Analyst
Play {id} / PlayLab                                    Back to replay
Model counterfactual, not causal inference.
-------------------------------------------------------------------
Editable frame {id} · Pre-snap              | Edit one defender
+--------------------------------------+   | Defender [#24 Name v]
|                                      |   |
|          . allowed region .          |   | Original   x / y
|          :  ghost o---O edit :        |   | Modified   x / y
|          ' . . . . . . . . '         |   | Displacement {d} yd
|                                      |   | Limit {supplied} yd
+--------------------------------------+   |
Original prediction --  Modified --        | [Run inference]
Pinned editable frame                      | Reset edit
-------------------------------------------------------------------
Prediction comparison · model {version} · horizon {horizon}
Measure                          Original       Modified       Delta
```

## 11. Evaluation Screen

Evaluation is a model report, centered at 1280 px maximum width. The title is “Evaluation,” with model/version, task, run time, dataset version, and split directly beneath it. The default report is the model currently served by the product; unavailable results are explicitly Pending evaluation or Unavailable. A compact version selector changes the report as a whole.

The report uses six ordered sections separated by 48 px spacing and quiet horizontal rules where needed:

1. **Scope and evidence.** A 680 px reading column describes what was predicted, the observation window, horizon, population, sample unit/count, exclusions, and split policy. Link the run and artifact identifiers. Summarize limitations before metrics.
2. **Trajectory performance.** A full-width table compares each supported baseline and served model using ADE, FDE, units, horizon, sample count, and available interval estimates. Mark lower-is-better in the column labels. Highlight the served model with a narrow amber leading rule, never a trophy or green wash. Show worse performance plainly.
3. **Error and uncertainty.** Two aligned 240 px-high plots: error by horizon, and calibration/coverage. Both include plain-language definitions and sample counts. State whether uncertainty is nominal, empirically calibrated, or uncalibrated. If outputs do not support a metric, replace the chart with an explanation.
4. **Retrieval quality.** A compact table of supported quality measures and their label source, evaluation set, and sample unit. Separate human/label-based relevance from ANN recall against exact search. Include a few inspectable retrieval examples as rows. Cosine similarity alone is not evidence of retrieval quality.
5. **System performance.** A table of inference p50/p95/p99 and ANN latency, with hardware, dataset/index size, batch size, warm/cold conditions, and whether timing is model-only or end-to-end. Use milliseconds. Display no speed claim without a measurement context.
6. **Slices and limitations.** A sortable slice table shows error, counts, and uncertainty where available. Flag insufficient samples according to an explicitly stated reporting rule; do not invent a universal count threshold. Finish with known failure modes and reproducibility links.

Define ADE as mean Euclidean displacement across the evaluated future points and FDE as displacement at the specified final horizon; expose the actual aggregation, masks, and unit of analysis used by the report. Do not silently convert an upstream metric in a different unit or average incompatible horizons. Compare models only under matching evaluation conditions; otherwise visibly separate their tables.

```text
PlayLens    Explore  Evaluation                              Analyst
-------------------------------------------------------------------
Evaluation                                      Model {version} v
Task · dataset version · split · run date · artifact

Scope and evidence
What this evaluation establishes. Population and limitations.
-------------------------------------------------------------------
Trajectory performance
Model / baseline       ADE (yd) v       FDE (yd) v      N
Baseline               {value}          {value}        {n}
Served model           {value}          {value}        {n}

Error by horizon                    Uncertainty coverage
[ labeled analytical plot ]        [ labeled analytical plot ]

Retrieval quality
Measure / definition / label source / result / sample count

System performance
Operation          p50       p95       p99       Conditions

Error slices and limitations
Slice              N         Error     Evidence / limitations
Reproducibility · dataset · split · model · run · artifacts
```

Load report sections independently without layout jumps. A failed chart does not blank the tables. No giant metric cards, live dashboard chrome, decorative sparklines, or fabricated history.

## 12. Football Field Visual System

**Geometry.** Render positions in an isotropic coordinate system: one yard has the same screen scale on both axes. The complete field is 120 × 53⅓ yd, including two 10 yd end zones. Place yard lines every 5 yd, major labels every 10 yd, and NFL hash marks from the verified field geometry. Transform dataset coordinates using its documented convention. Normalize direction only as a display operation.

**Layer order, back to front:** field surface → end zones/yard markings → uncertainty → graph edges/regions → trails and paths → ball and player tokens → hover/selection rings → labels → focus/interaction controls. Text should remain upright under coordinate transforms.

| Element | Visual specification |
|---|---|
| Field surface | Flat `#142923`; no turf texture or alternating decorative stripes |
| Yard lines | 1 px `#728D81`; boundary 1.5 px; hash marks 1 px |
| Yard numbers | 12 px mono `#A8BCB2`; fewer labels at small scales |
| End zones | Same field hue with a subtle darker tone; restrained team abbreviation if supplied |
| Line of scrimmage | 1 px neutral solid, labeled LOS; only when defined |
| First-down line | 1 px neutral dashed, labeled To gain; avoid broadcast-yellow dominance |
| Offense | 16 px filled chalk circle, 1 px dark outline, dark jersey number |
| Defense | 16 px dark circle, 2 px chalk outline, chalk jersey number |
| Ball | 8 × 10 px chalk diamond with dark outline; 12 px during hover |
| Selected player | 2 px amber outer ring with 3 px gap; persistent rail identity |
| Hovered player | 1 px chalk outer ring with 2 px gap; no size animation |
| Player labels | 10 px mono jersey inside token; selected label outside at 12 px with opaque field-colored backing |
| Velocity | 1.5 px solid arrow; direction and length encode velocity; shared labeled scale |
| Acceleration | 1 px dashed arrow, selected player only, labeled in yd/s²; replaces velocity arrow for that player |
| Nearest opponent | 1.5 px neutral dotted segment with distance label; computation at current frame |
| Interaction graph | 1 px neutral edges, 35% opacity for contextual edges; selected incident edges at full opacity; edge definition available |
| Observed trail | 1.5 px solid chalk at 45% opacity; previous 1 s, bounded by valid frames |
| Observed future | 2 px solid chalk, endpoint square; explicitly beyond pinned forecast origin |
| Predicted future | 2 px amber dashed, 6 px dash / 4 px gap; endpoint diamond |
| Uncertainty | Amber fill at 12% opacity with 1 px amber contour; selected prediction only |
| Current frame | Amber timeline cursor; field frame/time label; no flood of pulse effects |
| Critical frame | Labeled outlined diamond in the timeline; show the rule/tool/user annotation that produced it |
| Snap | Square timeline marker labeled Snap |
| Throw | Triangle timeline marker labeled Throw |
| Arrival/catch | Circle labeled with the actual supplied event; do not conflate arrival with a completed catch |
| Original PlayLab position | Dashed chalk ghost ring and Original label |
| Modified position | Amber fill, dark jersey, Modified label |
| Allowed movement | Thin neutral dashed outline with extremely light neutral fill |

Token size remains screen-based; positions and paths remain field-based. At dense formations, preserve coordinates instead of pushing players apart. Prioritize selected labels, then hovered labels; hide colliding nonessential labels and provide the roster as an alternate selection route. Do not merge physically distinct players into clusters.

**Overlay budget.** Default overlays are off. Trails can apply to all players. Velocity and graph detail are selected-player-first; “All players” is an explicit advanced setting. Nearest-opponent and full graph are mutually exclusive relationship layers. Prediction, observed future, and uncertainty form one forecast layer. Uncertainty appears for one player and one variant at a time. Keep player tokens above every analytical overlay. Toggling a conflicting layer replaces it and announces the change.

Uncertainty geometry must match the model's output: spatial contours for positional distributions, or discrete samples for sampled futures. Do not draw a smooth ribbon that implies a statistical interval the model never supplied. Label the represented quantity and horizon. A nominal 90% region is never described as calibrated unless evaluation supports that description.

Use opacity to subordinate context, not to make required information illegible. Critical path boundaries, selected edges, and control indicators must meet their contrast targets; faint context always has an accessible numeric counterpart. A legend appears whenever an analytical overlay is active and uses matching line samples, shapes, and category words.

## 13. Data Visualization System

Charts sit directly in the page with a title, one-line definition, plot, legend, and source footer. A ChartFrame provides consistent spacing, not a decorative card. Default plot height is 240 px; a dense expanded plot is 320 px. Use no shadows, gradients, beveled bars, or ornamental area fills.

Axes use 12 px mono values and 12 px sans labels. Horizontal gridlines are 1 px subtle border color; vertical gridlines are normally absent. Use three to five major ticks. Include units in the axis title and tooltips. Do not use unexplained abbreviations. Bars start at zero; line axes may use a restricted domain when it is visibly labeled and appropriate to the measure. Difference charts use a visible zero reference.

The current/served model uses a 2 px amber line. Baselines use neutral solid, dashed, or dotted lines with direct endpoint labels. Show no more than four series initially. Observed versus predicted data always retains the solid versus dashed distinction. Interval bands use 12% fill and a labeled statistical meaning; they are absent when interval estimates do not exist.

Metric rows use label, right-aligned value/unit, and source or definition action. No single-number tiles. Use 1 decimal for spatial summary values in yards, 2 decimals for ADE/FDE, 3 decimals for cosine similarity, 1 decimal for percentage summaries, and 1 decimal for millisecond latency where the measurement precision supports it. Tooltips may expose extra precision, never invented precision. Probabilities are percentages only for outputs that actually represent probabilities. Missing values are an em dash with a reason.

Similarity rows show rank, play reference, retrieval scope, score, and model. No filled percentage bar, star rating, or qualitative threshold unless such a threshold is explicitly defined by evaluation. Sort errors and distances by the appropriate direction, and state whether higher or lower is better.

Chart tooltips support pointer and keyboard inspection, show all compared values at the selected x-position, and remain within the chart area where possible. Every plot offers a data-table view with the same units, filters, values, and missing-data indicators. Gaps remain gaps rather than connecting unknown points.

## 14. Motion System

Motion explains a change in state. Ordinary controls never bounce, shimmer continuously, or move on hover.

| Interaction | Duration | Behavior |
|---|---:|---|
| Hover / pressed feedback | 80–100 ms | Background or stroke change only |
| Player selection | 100 ms | Ring opacity; no token scaling |
| Inspector ↔ Analyst | 180 ms | Pane reveal and field-column resize |
| Menu / tooltip | 100–120 ms | Opacity with at most 4 px translation |
| Prediction appearance | 160 ms | Opacity; no path drawing that suggests simulated time |
| Compare entry | 180 ms | Stable layout reveal; replay stays paused |
| Manual timeline seek | Immediate | Set exact frame; no delayed easing |
| Analyst timeline jump | Immediate + 400 ms | Seek exactly, then briefly outline destination marker |
| PlayLab drag | Immediate | Pointer follows input without spring lag |
| PlayLab reset | 160 ms | Return marker to source while edit is inactive |

Use ease-out `cubic-bezier(0.2, 0, 0, 1)` for entry and layout transitions, ease-in for exit. Replay follows timestamps, independent of interface transition easing. If display interpolation is used, it is visual only between valid neighboring samples; measurements and selection resolve to real data frames. Never interpolate through missing intervals.

No autoplay when opening a play. Respect reduced motion: eliminate translation and animated resizing, make selection and reset immediate, and use static loading placeholders. User-initiated replay remains available with pause and frame stepping. Reduced motion must not disable the analytical task.

## 15. AI Interaction System

Every response separates three types of content:

| Type | Presentation | Required grounding |
|---|---|---|
| Observed data | `OBSERVED DATA`, neutral solid leading rule | Play/player/frame or time window; source or deterministic computation; units and definition |
| Model prediction | `MODEL PREDICTION`, amber dashed line sample | Model version, allowed input window, origin, horizon, target, uncertainty type when supplied |
| AI interpretation | `AI INTERPRETATION`, plain prose with explicit heading | Linked evidence references; calibrated language; no invented causal or tactical certainty |

Counterfactual model output is further labeled `MODIFIED INPUT` and always carries the PlayLab disclaimer. In Evaluation, measured model performance is labeled `EVALUATION RESULT` with its run and split; it is not mislabeled as a prediction about the current play.

Evidence blocks are compact rows with a left category rule, not colored cards. An evidence reference opens its source details and offers the relevant frame/window action. Source details expose tool name, play/player IDs, frame range, computation definition, dataset/model version as applicable, and run/request ID when available. A collapsed “Sources (n)” row is the default; the numerical claim and evidence category remain visible without expansion.

Generated actions are bounded product controls: Jump to frame, Focus player, Show overlay, Open play, Compare plays, or Apply filters. Their labels name the consequence. Responses may offer up to three primary inline actions; additional actions use a menu. A response cannot execute an arbitrary UI mutation.

A clicked action validates target availability, pauses replay when changing analytical context, updates state atomically, and shows a quiet inline acknowledgment. Opening a response does not execute its actions. When the user's command explicitly requests an action (“Jump to the throw”), the Analyst may perform that reversible view change and show what changed with Undo view change. A question such as “Why is this player open?” offers actions rather than automatically taking over the field. The Analyst never moves a PlayLab defender or runs counterfactual inference automatically in v1.

Pin all claims and actions to the context captured at submission. If the user changes plays while tools run, retain the result under its original context. Do not apply its actions to the newly opened play. Unsupported or stale actions remain visible with a reason and a route to open their original context when possible.

If a tool fails, show what could and could not be established. Partial success may support a narrower answer, but failed evidence never appears as a fact. Distinguish “The model estimates…” from “The tracking shows…” and “A possible interpretation is…”. Separation alone does not establish an assignment, intent, or causal explanation. Recommendations to inspect evidence are welcome; unsupported football certainty is not.

## 16. Component Inventory

Build shared primitives around stable product responsibilities. Variants belong within these primitives; avoid a component for every caption or statistic.

| Primitive | Responsibility |
|---|---|
| AppShell / TopNav | Global geometry, destinations, contextual Analyst trigger |
| WorkspaceHeader | Breadcrumb, play/report identity, metadata, contextual actions |
| Button / IconButton / Input / Select / Checkbox | Consistent control sizes, keyboard semantics, all states |
| Menu / Tooltip / Dialog | Accessible transient surfaces and focus behavior |
| SearchFilterBar | Search, filters, result state, clear action |
| PlayList / PlayReference | Explore rows, compact retrieved references, preview entry |
| FieldViewport | Geometry, camera, coordinate transform, render layers, accessible roster companion |
| OverlayControl / FieldLegend | Layer selection, conflict rules, visual encoding explanation |
| ReplayControls / Timeline | Replay clock, seek, events, gaps, forecast origin, linked lanes |
| PlayerTooltip / PlayerInspector | Transient versus persistent player detail |
| MetricRow / EvidenceBlock | Numeric evidence, category, units, source links |
| SimilarityRow | Ranked reference, model score, scope, Open/Compare actions |
| ComparePanel | Two fields, shared alignment, correspondence, difference table |
| AnalystDrawer | Context, transcript, tools, composer, lower-pane variant |
| AnalystAction | Validated typed action, acknowledgment, undo where applicable |
| CounterfactualControl | One-defender editing, validity, inference and stale-result states |
| ChartFrame / DataTable | Report plots, data alternative, shared numeric formatting |
| ProvenanceDetails | Consistent data/model/run/tool source disclosure |
| StatusState | Loading, empty, unavailable, partial, and error presentations |

Do not create a universal Card component and use it as the page-building default. Field tokens and drawing layers can remain renderer internals. ModelMetric is a MetricRow variant, not a second visual system. A PlayCard is a compact PlayReference variant only when the Analyst needs it.

## 17. Responsive Strategy

| Width | Play / PlayLab | Compare | Analyst |
|---|---|---|---|
| 1728 / 1512 / 1440 | Field + 320 px inspector | Equal side-by-side fields | Replaces inspector; Compare uses side pane only if fields remain ≥480 px each |
| 1280 | Field + 288 px inspector; quieter metadata | Side-by-side, shorter labels | 360 px on single-field screens; lower pane for Compare |
| 1024 | Full-width field; inspector sections below dock | Side-by-side compact fields; optional Focus left/right | In-flow pane below dock, not over field |
| 768–1023 | Full-width replay; details below | Stacked fields, shared timeline, labeled source times | In-flow pane below replay; collapse lower support sections |
| Below 768 | Explore, single-play replay, key evidence | One visible field with Left/Right switch preserving time | Full-height sheet with a pinned context summary and Return to play |

At 1024–1279, opening Analyst inserts a lower pane directly below the replay dock and before evidence; it is capped at 320 px initially, resizable upward in document flow, and does not overlay playback controls. Below 768, focus is trapped within the modal Analyst sheet until it closes; analytical context remains labeled even though the field is not concurrently visible.

On mobile, hide dense graph overlays, collapse the filter row into Filters, reduce Explore to matchup/description plus clock/down, and provide a full-width preview. PlayLab editing is desktop/tablet-landscape only at 1024 px and above; smaller widths show the source and any saved result with “Open on a larger screen to edit.” Evaluation tables scroll within labeled horizontal regions while prose reflows. Never shrink the desktop UI as a whole.

Touch controls use at least 44 px targets. Use compact controls only for pointer-first desktop. At high browser zoom, switch to the corresponding narrower layout; do not enforce a 1280 px minimum page width.

## 18. Accessibility

Target WCAG 2.2 AA. Verify final rendered text contrast, including composited surfaces: at least 4.5:1 for ordinary text, 3:1 for qualifying large text, and 3:1 for meaningful controls and graphical distinctions. Decorative field context can be quieter, but essential player/path/selection distinctions must remain readable. Color never carries a category, status, or team alone.

Use visible 2 px focus rings, logical landmark regions, a skip-to-workspace link, semantic tables, and accessible names for every icon button. Every hover affordance also appears on focus. Popovers return focus to their trigger; Escape closes the most local active layer first. Do not trap keyboard users inside the field or an inline Analyst pane.

Replay shortcuts apply only while the replay workspace is focused and no text input or menu consumes them: Space play/pause, Left/Right previous/next valid frame, Shift+Left/Right one second, Home/End first/last valid frame. The timeline is a labeled slider with frame/time value text; events are individually accessible buttons. Provide a visible keyboard-shortcuts reference. Never capture typing shortcuts globally inside the Analyst composer.

Canvas rendering has an equivalent accessible roster and current-frame data table. Selecting a roster entry focuses the matching player and inspector. Announce user-requested frame changes and paused-frame selection summaries, not every animation tick. Dragging has numeric and keyboard alternatives with identical constraints. Live regions announce completed tool operations, validation failures, and inference results without reading streaming tokens continuously.

Charts include textual takeaways and data tables; line styles, markers, and direct labels distinguish series. Respect reduced motion as defined above. Test 200% zoom, high-contrast/forced-colors mode, keyboard-only use, and a screen reader. Preserve usability at 400% zoom through reflow and the narrow-screen mode, with genuinely two-dimensional analytical regions handled explicitly.

## 19. Anti-Patterns

- A row of oversized KPI cards before the field.
- A permanent dashboard sidebar with every contextual operation promoted to navigation.
- Purple/blue gradients, gradient text, neon edges, blurred blobs, glass panels, or floating decorative objects.
- Marketing heroes, “AI powered” badges, sparkle icons, robot avatars, or sports hype language.
- Rounded pills for filters, tabs, navigation, and ordinary actions.
- Borders around every paragraph, statistic, and section; shadows on ordinary layout regions.
- Team colors used as page themes, broadcast-green application chrome, or rainbow chart series.
- Filled similarity percentage gauges, unlabeled confidence scores, invented performance numbers, or decorative uncertainty.
- Chat bubbles as the dominant Analyst structure, prose without evidence, or actions that silently move the replay.
- Multiple simultaneous inspector rails that squeeze the field.
- A prediction origin that silently moves with the scrubber, or observed future leaking into displayed model inputs.
- Compare fields with different yard scales or implicit alignment assumptions.
- PlayLab results portrayed as actual outcomes or proof of causation.
- Autoplaying previews, continuous shimmer, bouncing controls, animated counters, and arbitrary camera movements.
- Shrinking every label to fit more data; 10 px text outside player tokens; disabling zoom or keyboard access.
- Mock data or unimplemented features presented as live product evidence.

## 20. Screenshot Quality Checklist

Review the screenshot at its actual viewport size. Mark each item Pass, Revise, or Block. A credibility failure, inaccessible core control, or unreadable field blocks acceptance even when the screenshot looks polished.

- [ ] **Hierarchy:** the primary object is obvious within three seconds. Play, Compare, and PlayLab lead with the field; Explore leads with search/results; Evaluation leads with report identity and evidence.
- [ ] **Typography:** title, panel title, body, and metadata follow the defined scale. Mono is limited to analytical values and identifiers. No accidental weight or size variants.
- [ ] **Alignment:** heading, toolbar, field, replay dock, and supporting sections share edges. Values align by column and unit.
- [ ] **Spacing:** gaps come from the spacing scale. Related elements are closer than unrelated sections. Whitespace is not filled with decorative content.
- [ ] **Density:** essential context is visible; detail follows selection or disclosure. No field-adjacent wall of every metric.
- [ ] **Color:** graphite dominates the chrome. Amber marks intent or model output. Team identification and status remain meaningful without color.
- [ ] **Borders:** rules identify real boundaries. Plain content is not unnecessarily boxed.
- [ ] **Radius:** ordinary controls use 4 px; no inflated pills or excessive rounding.
- [ ] **Field dominance:** spatial information is the largest continuous object. Tokens, paths, events, and labels remain legible under active overlays.
- [ ] **Coordinate integrity:** field proportions are preserved, orientation is labeled, and comparison scales match.
- [ ] **Temporal integrity:** current frame, time origin, forecast origin, and available horizon are distinguishable.
- [ ] **Generic AI patterns:** no gradients, glows, sparkle badges, ornamental cards, oversized KPI tiles, or chatbot styling.
- [ ] **Product credibility:** observations, predictions, interpretation, and counterfactuals have clear labels and accessible provenance. Missing values are not zeros.
- [ ] **Interaction clarity:** selection, focus, active overlays, disabled reasons, and primary next action can be identified without guesswork.
- [ ] **Premium feel:** optical balance, consistent control heights, crisp line work, deliberate truncation, and restrained chrome survive scrutiny at 100% zoom.
- [ ] **Responsive behavior:** the composition works at 1440, 1512, 1728, 1280, and 1024 px, including a short 720 px-high window.

A screenshot cannot prove keyboard behavior, motion, data correctness, or action semantics. Follow it with a short interaction check: select a player, seek, open Analyst, execute an evidence jump, simulate an error, and inspect sources. Design reviews should name the problem, its consequence, and a specific correction; “looks good” alone is not a review.

## 21. Claude Implementation Handoff

Implement PlayLens from `docs/PLAYLENS_DESIGN_BIBLE.md`. Follow the existing engineering/data contracts; this document governs visual and interaction decisions.

- Use a dark-only graphite/chalk/amber system: background `#101214`, surface `#171A1D`, elevated `#202428`, border `#343A40`, control border `#737D87`, primary text `#F2F4F5`, secondary `#B7C0C8`, muted `#8D98A3`, accent `#E7B66B`, field `#142923`. Use the complete semantic palette from Section 3.
- Use Geist Sans and Geist Mono. Page title 24/32, section 18/24, panel 14/20, body 14/22, metadata 12/18. Use 400/500/600 weights. Mono is for analytical values, times, versions, and IDs.
- Use the 4/8/12/16/24/32/48/64 spacing scale. Ordinary controls have 4 px radii. Exposed drawers/dialogs may use 8 px. No default card grid, gradients, glows, decorative shadows, or marketing surfaces.
- Use a 56 px top navigation with PlayLens, Explore, Evaluation, and Analyst. Play/Compare/PlayLab are contextual workspaces with breadcrumbs.
- Cap analytical workspaces at 1680 px and Explore/Evaluation at 1280 px. Use the exact breakpoint table. At ≥1440, Play has a flexible field, 24 px gap, and 320 px inspector. Analyst replaces it at 384 px. At 1280 use a 288 px inspector or 360 px Analyst. At 1024 place details and Analyst below the replay dock.
- Explore is a searchable, filterable 56 px result list with pagination and explicit preview. Preserve return position and filter state. No ecommerce tiles or autoplay.
- Play uses a 72 px heading, 40 px toolbar, preferred 16:9 field stage capped at 640 px high, and 96 px replay dock. Fit field geometry isotropically. Keep camera framing stable, label normalized orientation, and retain exact source coordinates.
- Use chalk filled offense tokens, outlined defense tokens, and a diamond ball. Amber selection rings and dashed model paths are the primary emphasis. Observed paths are solid. Uncertainty comes only from model-provided quantities. Apply the overlay budget and layer order in Section 12.
- Default replay has no analytical overlays and no autoplay. Seeking pauses. Use source timestamps and frame IDs; label missing intervals. Keep forecast origin and input window pinned and explicit, with observed future separately labeled.
- Compare uses equal fields at equal yard scale, linked snap-relative time, two labeled event lanes, explicit missing-anchor fallback, and optional independent seeking. Scores are model-labeled cosine values, never probabilities. Use measured structural differences and documented player correspondence.
- Analyst uses an evidence notebook layout with plain questions, short interpretations, source rows, and typed action controls. Separate OBSERVED DATA, MODEL PREDICTION, AI INTERPRETATION, and evaluation results. Preserve submission context, validate payloads, and execute view changes only according to Section 15.
- PlayLab edits one eligible defender at the configured pre-snap frame using supplied bounds. Show original ghost, valid region, coordinate inputs, and explicit Run inference. Pin results to their edit and model context; label stale results. Keep “Model counterfactual, not causal inference” visible.
- Evaluation is a report: scope, baseline table, horizon error, calibration, retrieval evidence, measured latency, slices, limitations, and reproducibility. Include units, sample counts, split, and measurement conditions. Never invent metrics or simulated evidence.
- Use the component inventory in Section 16 and the loading/empty/error behaviors of each screen. Meet keyboard, focus, contrast, reduced-motion, chart-table, and drag-alternative requirements.
- Validate at 1440, 1512, 1728, 1280, and 1024 px, including a 720 px-high window, and review against Section 20. The field must remain dominant and its playback controls reachable.
