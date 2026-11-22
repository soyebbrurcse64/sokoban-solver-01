# Sokoban solver

A make.fun bounty entry: a Sokoban solver that answers a whole set of
levels in one run, in as few pushes as it can.

## How it works

Each level is a hallway with 1–4 small rooms off it (3–4 boxes each),
and a box pushed out of its room can never come back — so the
push-optimal total is the sum of the rooms' optima. The solver:

1. Finds the hallway (the player's row, or column) and splits the
   level into its rooms, each with its one door.
2. Solves each room on its own with a push-based A*: a state is the
   sorted box positions plus the player's reachable region, cost is
   pushes, and the heuristic is the minimum bipartite matching of
   boxes to goals over floor distances. Dead squares (reverse
   reachability from the goals), 2x2 box blocks and frozen boxes are
   pruned.
3. Stitches the rooms together, walking the player between doors and
   trying the visit orders until every walk succeeds.

Everything is budgeted by work (expansion counts), never by the wall
clock, with fixed direction order and deterministic heap ties, so two
runs write byte-identical outputs. If a level cannot be split, it
falls back to one whole-level push A* with a cheaper heuristic; if
that fails too, it still writes a valid (empty) solution file.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

This writes `out/<id>/solution.txt` for every level in the input set.

On the kit's practice set it scores 1,000,000: every level solved in
exactly its push-optimal count (13, 16, 29, 47 and 60 pushes), against
the house baseline's 200,000.

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/soyebbrurcse64/sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/soyebbrurcse64/sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
