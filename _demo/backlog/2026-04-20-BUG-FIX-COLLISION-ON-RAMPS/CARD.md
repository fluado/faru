---
title: Fix collision bug on ramps
type: bug
status: todo
assigned: yves
created: 2026-04-20
edited: 2026-04-20
description: Player clips through ramp edges at high velocity. Need to fix sweep test radius.
---

# Fix collision bug on ramps

Player clips through ramp edges when moving at high velocity. The sweep test radius is too small for steep angles.

## Acceptance Criteria

- No clipping on any ramp angle up to 60°
- Sweep test covers full capsule width
- Add regression test for ramp angles 30°, 45°, 60°
