# GLTF Lobster Migration Design

## Summary

Replace the procedural lobster meshes (spheres/cylinders) with the new `lobsterDownloaded.gltf` model that has 19 skeletal animations and a 26-bone rig. Apply hue-shifted textures from `LobsterTexture.png` for per-agent color variation. Add 6 new action types to the IPC protocol.

## Architecture

**Single shared GLTF + cloned instances.** Load the model once via `GLTFLoader`, then `SkeletonUtils.clone()` for each lobster. Each clone gets its own `THREE.AnimationMixer` to play clips independently.

### Hue-Shifting for Color Variations

Clone `LobsterTexture.png` onto a canvas, apply a CSS hue-rotate filter derived from `profile.color`, create a `THREE.CanvasTexture` per lobster. Cache textures by hue angle to avoid duplicates.

### Animation Mapping

| Game Action | GLTF Clip | Loop? | Context |
|---|---|---|---|
| `idle` | `Idle_A` / `Idle_B` / `Idle_C` | loop | Random rotation every ~5s |
| `walk` | `Walk` | loop | Normal movement |
| `talk` | `Clicked` | loop | Speaking / chatting |
| `pinch` | `Attack` (short) | once | Claw snap |
| `wave` | `Bounce` | loop | Friendly greeting |
| `dance` | `Roll` | loop | Dance move |
| `backflip` | `Jump` | once | Acrobatic flip |
| `spin` | `Spin` | loop | Spinning |
| `eat` (new) | `Eat` | loop | Eating |
| `sit` (new) | `Sit` | once | Sitting down |
| `swim` (new) | `Swim` | loop | Swimming |
| `fly` (new) | `Fly` | loop | Flying / hovering |
| `roll` (new) | `Roll` | loop | Barrel roll |
| `lay` (new) | `Lay` | once | Laying down |
| strike | `Attack` | once | Combat attack |
| guard | `Sit` | once | Defensive crouch |
| feint | `Fear` | once | Fake-out |
| approach | `Run` | loop | Aggressive advance |
| retreat | `Fear` | loop | Backing away |
| stunned | `Hit` | once | Taking damage |
| victory | `Bounce` | loop | Celebration |
| defeated | `Death` | once | KO (clamp at end) |
| combatReady | `Idle_B` | loop | Alert stance between turns |

### Files Changed

1. **`src/scene/lobster.ts`** - Replace procedural geometry with GLTF loader, hue-shift texture system, animation clip registry
2. **`src/scene/lobster-manager.ts`** - Replace manual animation calls with AnimationMixer, crossfade transitions, async model loading
3. **`server/types.ts`** - Add `eat | sit | swim | fly | roll | lay` to ActionMessage.action union
4. **`src/main.ts`** - Async-aware initialization for model preload

### Key Details

- Crossfade duration: 200ms
- Transient actions (combat): play once, clamp, then crossfade back
- Model scale: adjusted to match current ~2.4 unit footprint
- Shadows: castShadow on skinned mesh
- Disposal: dispose cloned skeletons, textures, and mixers on remove()
- Hit flash: set emissive on the cloned MeshStandardMaterial
