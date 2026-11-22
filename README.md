# Room-split A* Sokoban solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/cypher-dex/sokoban-solver-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/cypher-dex/sokoban-solver-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's [Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121) bounty. It is one dependency-free Node 22 file, `main.ts`.

## How it works

- **Room split.** The level's hallway squares on the player's row are dead: a box pushed there can never reach a goal. Removing them leaves independent rooms. The level's push optimum is the sum of each room's optimum. Each room is solved separately, with the other rooms' boxes treated as walls, and the player walks on from where the previous room left it.
- **A\* over pushes.** A state is the sorted box squares plus the player's reachable region, named by its lowest square. The estimate is the cheapest assignment of boxes to distinct goals, using exact subset DP over per-goal push distances. Each push changes this by at most one, so it is admissible and consistent, and the first solved state the search pops is push-optimal.
- **Pruning.** It rejects dead squares, which cannot reach any goal even without other boxes. It rejects freeze deadlocks: a box blocked on both axes by walls, dead squares or frozen neighbours while off a goal. It also rejects positions where no box-to-goal assignment exists.
- **Deterministic.** The search is bounded by its state count, never by the clock. Heap ties break by depth, then insertion order, so two runs write identical bytes.

## Run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

It reads `/input/<id>/level.txt` and writes `/output/<id>/solution.txt` (LURD, pushes upper-case).

MIT licensed.
