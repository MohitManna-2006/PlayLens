# NFL Big Data Bowl 2026 Analytics: dataset notes

Every statement below was checked against the published files on 2026-09-30 with the
PlayLens validation pass (`playlens_ml.data.bdb2026.validate`). Counts come from that run
and from `data/manifests/nfl_bdb_2026_analytics.dev.manifest.json`. Where a statement is an
inference from the data rather than a documented fact, it says so.

## Source and data use

- Release folder: `114239_nfl_competition_files_published_analytics_final` (NFL Big Data Bowl 2026 Analytics competition files).
- The data is used under the competition's data-use terms for development and portfolio demonstration.
- **Raw and processed data are not committed.** `data/raw/`, `data/interim/`, and `data/processed/` are Git-ignored. Only the manifest (checksums, counts, provenance) is committed.
- Committed test fixtures and contract examples use synthetic data (`playlens_ml.data.testing`), never rows from this release.

## Expected location

```text
data/raw/114239_nfl_competition_files_published_analytics_final/
├── supplementary_data.csv
└── train/
    ├── input_2023_w01.csv … input_2023_w18.csv
    └── output_2023_w01.csv … output_2023_w18.csv
```

Override the data directory with `PLAYLENS_DATA_ROOT`, or the raw folder with `--raw-dir`. PlayLens never writes inside `data/raw`.

## Files and schemas

| File | Rows | Key | Content |
|---|---:|---|---|
| `train/input_2023_wNN.csv` (18) | 4,880,579 | game_id, play_id, nfl_id, frame_id | Observed tracking plus per-play and per-player attributes |
| `train/output_2023_wNN.csv` (18) | 562,936 | game_id, play_id, nfl_id, frame_id | Future x/y for players flagged `player_to_predict` |
| `supplementary_data.csv` | 18,009 | game_id, play_id | Game context, charted labels, outcomes |

Column names and types are listed in `ml/src/playlens_ml/data/bdb2026/spec.py`. A missing required column stops preprocessing with the file name and the missing columns; extra columns are recorded in the manifest and ignored.

## Verified semantics

| Claim | Evidence |
|---|---|
| `(game_id, play_id)` is the play key; `play_id` alone is not unique | Validation uses the pair; the synthetic tests include two games with the same `play_id`. |
| 14,108 tracked plays in 272 games, season 2023, weeks 1–18 | Input files |
| Frames are 10 Hz | Frame-to-frame displacement ÷ 0.1 s matches the supplied speed `s` (median ratio 0.99). |
| `dir` and `o`: degrees, 0° = +y, clockwise | Displacement heading matches `dir` (median absolute difference 0.7° at speeds above 3 yd/s). |
| Every play's frames run 1..N without gaps, and every player appears in every frame | `input_non_contiguous_frames` = 0, `input_incomplete_player_frames` = 0 |
| `play_direction`, `absolute_yardline_number`, `num_frames_output`, `ball_land_x/y` are constant within a play | `input_inconsistent_play_constants` = 0 |
| `absolute_yardline_number` is the line of scrimmage in raw x | Rotated to the canonical frame it equals the line implied by `yardline_side`, `yardline_number`, `possession_team` on all 14,108 plays. |
| Output files cover exactly the `player_to_predict` players, frames 1..`num_frames_output` | `output_players_match_player_to_predict` = 0, `output_frames_match_num_frames_output` = 0 |
| Output frame 1 is the frame after the last input frame | Median displacement across that boundary is 0.45 yd, matching one 0.1 s step at the median speed; the 99th percentile is 0.90 yd. Output `frame_id` restarts at 1. |
| Output positions are in the same raw coordinate frame as input | Same continuity check, across both play directions. |
| The targeted receiver's last future position is near the ball landing point | Median distance 1.19 yd (inference: the output window ends near the arrival of the pass). |

## Validation findings (full release)

No play failed an integrity check, so none was excluded. Warnings and information:

| Check | Result |
|---|---|
| Plays without exactly one Passer | 3 (`2023091001-3216`, `2023112606-4180`, `2023121009-3594`); kept, not eligible for the dev subset |
| Plays with no offensive or no defensive player | 1 (`2023112606-4180`: one tracked player); kept, not eligible |
| Ball landing point outside the field rectangle | 231 plays; kept as supplied |
| Observed positions outside the field | 0 rows |
| Future positions outside the field | 3 rows (x up to 120.83, y up to 53.72); kept |
| Null `s`, `a`, `dir`, `o` | 0 rows |
| Supplementary rows without tracking | 3,901 rows, all season 2024 (weeks 14–18, 77 games); not used |
| Supplementary nulls for tracked plays | `penalty_yards` 13,755 (no penalty); `yardline_side` 199 (all at midfield, `yardline_number` = 50); `pass_location_type` 16; `route_of_targeted_receiver` 3; `team_coverage_type` 3; `team_coverage_man_zone` 3; `play_action` 1; `dropback_type` 1; `dropback_distance` 1 |
| `play_nullified_by_penalty` = Y | 1 play |

## Dataset limitations

- **Passing plays only.** Every tracked play has a `pass_result` of C, I, or IN.
- **Not all 22 players are tracked.** Roles are Passer, Targeted Receiver, Other Route Runner, and Defensive Coverage only. A play has 1–17 tracked players (median 13), at most 6 on offense. Offensive linemen and pass rushers are absent, so the replay shows a partial field.
- **No frame-level ball position.** There is no ball track. `ball_land_x/y` is a single landing point; PlayLens stores it as metadata and never animates a ball from it.
- **No event annotations.** There is no snap, throw, or arrival column, so the timeline has no event markers and times are measured from the first observed frame. PlayLens does not infer events.
- **Observed windows are short and variable.** 8–123 frames (median 26, 2.5 s). The window ends at the last frame before the output window.
- **Future ground truth exists only for flagged players** (1–9 per play, median 3) and for 5–94 frames (median 10).
- **Team membership per player is not supplied.** Rows carry `player_side` (Offense/Defense); teams come from `possession_team` / `defensive_team` in the supplementary file.
- **No jersey numbers.** Players are identified by `nfl_id` and name; the field shows position abbreviations.
- **Supplementary data mixes timing classes.** It contains pre-snap context, charted labels that describe the play (coverage, route, dropback, play action), and post-play outcomes (pass result, yards, EPA, win-probability change, the narrative description). See below.

## Availability classes (leakage boundary)

Each canonical column has one class in `ml/src/playlens_ml/data/canonical_schema.py`:

| Class | Meaning | Examples |
|---|---|---|
| `identity` | Keys and provenance | `id`, `game_id`, `play_id`, `nfl_id` |
| `structural` | Counts and frame ranges of the observed window | `observed_frame_count`, `frame_index`, `time_s` |
| `pre_snap` | Known before the snap | down, distance, clock, formation, receiver alignment, pre-snap win probability |
| `observed_window` | Tracking inside the observed window | `x`, `y`, `s`, `a`, `dir`, `o` and their raw values |
| `task_input_at_origin` | Supplied in the input files as known at the end of the observed window, but describing the pass | `player_role` (who is targeted), `player_to_predict`, `ball_land_x/y`, `num_frames_output` |
| `in_play_annotation` | Charted labels describing the play | coverage, target route, dropback, play action, pass location |
| `future_target` | Held-out positions after the observed window | output files |
| `post_play_outcome` | Results | pass result, yards gained, EPA, WPA, narrative description |

Future targets, charted labels, and outcomes are written to separate artifacts from observed input. `check_feature_columns` rejects them as model inputs; `task_input_at_origin` fields require an explicit opt-in because they encode where the pass went.
