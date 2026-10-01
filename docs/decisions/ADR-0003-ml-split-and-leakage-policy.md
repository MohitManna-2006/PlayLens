# ADR-0003: ML split and leakage policy

Date: 2026-09-30

## Context

Phase 3 trains the first PlayLens model: future positions of the players the dataset flags `player_to_predict`, from the observed input window. The Masterbrain (§19) requires game-level or temporal splits, no fragmentation of plays across partitions, and no target-dependent inputs. Phase 2 already separated observed input, future targets, charted annotations, and outcomes into different artifacts and classified every column by availability.

Measured on the full release (14,108 plays, 272 games, 2023 weeks 1–18): every week has 666–904 plays, 13–16 games, and 2,240–2,959 target players. In each of the three splits below, both target roles are present (targeted receiver, coverage defenders), and supplied future lengths have identical 5th/50th/95th percentiles (6/10/23 frames); observed windows have medians of 26–27 frames.

## Decision

**Split: `temporal-weeks-v1`.** Weeks 1–14 train, 15–16 validation, 17–18 test.

| Split | Weeks | Games | Plays | Target players |
|---|---|---:|---:|---:|
| train | 1–14 | 208 | 10,862 | 35,467 |
| validation | 15–16 | 32 | 1,687 | 5,540 |
| test | 17–18 | 32 | 1,559 | 5,038 |

- A game is played in one week, so every frame, player, observed prefix, and future target of a play, and every play of a game, stay in one split. `assign_splits` fails if a game would span two splits or a week is unmapped.
- The split version is a hash of the policy name and every (play ID, split) pair (`temporal-weeks-v1-b39c53db8a01` for the full release). It is stored in `data/processed/.../ml/splits.parquet`, `splits.json`, the committed `data/manifests/nfl_bdb_2026_analytics.full.splits.json`, every run, and every model artifact.
- Checkpoints are selected on validation ADE only. The chosen checkpoint is scored on test once, by the training command, after selection.

**Model inputs: an explicit allowlist** (`playlens_ml/features/spec.py`). Observed canonical x, y, speed, acceleration, direction and orientation (as sin/cos), velocity components, frame-to-frame displacement, time relative to the last observed frame, x relative to the line of scrimmage, side, position, role, and the `player_to_predict` flag. `assert_allowlist_is_safe` runs the Phase 2 availability guard over every source column and rejects any `task_input_at_origin` column not approved by name. The sample builder selects only allowlisted columns, so extra columns in its inputs cannot reach tensors (tested).

**Excluded on purpose**, each with a recorded reason:

| Field | Why |
|---|---|
| `ball_land_x`, `ball_land_y` | Describe where the pass lands, after the observed window. The input files carry them, but no local documentation establishes them as known at prediction time, so they are out. |
| `num_frames_output` / `future_frame_count` | Encodes ball flight time. Used only to mask targets. |
| Coverage, target route, dropback, play action, pass location | Charted after the play. |
| Pass result, pass length, yards, EPA, WPA, description | Outcomes. |
| Future positions | The targets. |
| Down, distance, clock, score, formation, win probability | Pre-snap and allowed, but left out of this first, purely kinematic model. |
| Raw (recorded-frame) coordinates | Duplicates; mixing frames is forbidden (§9.1). |
| Name, NFL ID, height, weight, birth date | Identity or physique; risks memorizing individuals. |

`player_role` and `player_to_predict` are approved task inputs: the receiver is targeted at the moment the pass is released (the prediction origin), and the model has to know which players to forecast. Caveat: the dataset chose which defenders are flagged, which hints at who is near the play.

**Normalization** statistics (per-feature mean and standard deviation) and categorical vocabularies are fitted on train-split observed frames only and stored inside the model artifact.

## Alternatives considered

- **Random 80/10/10 by play.** Rejected: plays of one game would straddle partitions and share opponents, scheme, and weather; it tests interpolation, not generalization.
- **Random by game.** Acceptable for leakage but mixes early and late season; the temporal split also measures drift and matches how the product would be used.
- **Weeks 1–12 / 13–15 / 16–18.** Viable; it moves ~1,900 plays out of training for a larger test set. 32 games per held-out split already give ~5,000 target players each, enough for slices with ≥100 players.
- **Including the ball landing point** (as the BDB 2026 prediction task allows). It would likely help the targeted receiver most, but its availability at prediction time is not established by the files we hold. An ablation with it can be added later under its own model name.

## Consequences

- Test weeks 17–18 may include rested starters and playoff-driven play-calling; reported test metrics are for that slice of the season.
- The same players and teams appear in train and test (one season). Metrics measure generalization to new games and weeks, not to new players.
- Any new feature must be added to the allowlist with an availability class, or training fails.

## Revisit trigger

- A second season arrives → train on 2023, test on the new season.
- Documentation confirms ball-landing availability for the product's use case → add it as a separate, clearly labelled model version.
