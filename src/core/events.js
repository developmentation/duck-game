// Tiny synchronous event bus. Systems talk through this instead of importing
// each other, which keeps modules independently replaceable.

export class EventBus {
  constructor() {
    this.map = new Map();
  }

  on(type, fn) {
    let set = this.map.get(type);
    if (!set) this.map.set(type, (set = new Set()));
    set.add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(type, fn) {
    this.map.get(type)?.delete(fn);
  }

  emit(type, payload) {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] handler for "${type}" threw`, err);
      }
    }
  }
}

/**
 * Event names in use. Documented here so agents working on separate systems
 * emit and listen for the same strings.
 *
 *  'water:splash'     { position: Vector3, strength: number }   entity broke the surface
 *  'water:ripple'     { position: Vector3, radius, strength }   gentle surface disturbance
 *  'duck:dive'        { position: Vector3 }
 *  'duck:surface'     { position: Vector3 }
 *  'duck:quack'       { position: Vector3, pitch: number }
 *  'fish:caught'      { fish, position: Vector3, species }
 *  'fish:escaped'     { fish }
 *  'bubbles:burst'    { position: Vector3, count, spread }
 *  'quest:started'    { quest }
 *  'quest:progress'   { quest, step, total }
 *  'quest:completed'  { quest, reward }
 *  'game:started'     { mode }
 *  'game:ended'       { mode, score, best }
 *  'hud:toast'        { text, icon?, duration? }
 *  'hud:lesson'       { title, body }
 *  'camera:shake'     { strength, duration }
 *  'audio:sfx'        { name, position?, volume?, rate? }
 */
export const EVENTS = Object.freeze({
  SPLASH: 'water:splash',
  RIPPLE: 'water:ripple',
  DIVE: 'duck:dive',
  SURFACE: 'duck:surface',
  QUACK: 'duck:quack',
  FISH_CAUGHT: 'fish:caught',
  FISH_ESCAPED: 'fish:escaped',
  BUBBLES: 'bubbles:burst',
  QUEST_STARTED: 'quest:started',
  QUEST_PROGRESS: 'quest:progress',
  QUEST_COMPLETED: 'quest:completed',
  GAME_STARTED: 'game:started',
  GAME_ENDED: 'game:ended',
  TOAST: 'hud:toast',
  LESSON: 'hud:lesson',
  SHAKE: 'camera:shake',
  SFX: 'audio:sfx',
});
