---
title: Optimize texture streaming
type: infra
status: wip
assigned: alice
created: 2026-04-14
edited: 2026-04-17
description: Reduce VRAM usage by implementing mip-level streaming for large terrain textures.
---

# Optimize texture streaming

Implement mip-level streaming to reduce VRAM usage on large terrain textures. Currently loading full resolution on map load causes 2GB+ VRAM spike.
