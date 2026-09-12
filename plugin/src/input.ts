// QuotaLens plugin — T3.3 input routing (PLAN §10.2 `InputRouter`).
//
// One pure function turns a raw SDK event into the vocabulary PLAN §10.3(a) uses for its state
// machine. Keeping it pure is what makes "every gesture produces visible feedback" (§6 rule 5) a
// table-driven unit test instead of a screenshot someone has to look at.
//
// The mapping below is NOT guesswork — it is the 2026-09-08 first-hand probe recorded in
// `docs/DESIGN.md` ("T3.3 LONG_PRESS probe results", simulator 0.9.5 / SDK 0.0.15), cross-checked
// against the SDK's own enum. Three findings from that probe drive the code:
//
//   1. `sysEvent.eventType` is ABSENT for a single click. Protobuf omits zero values and
//      `CLICK_EVENT = 0`, so `?? 0` is the only correct read — `'eventType' in e` or
//      `e.eventType !== undefined` would classify every tap as "unknown" (PLAN §10.3(a) constraint 2).
//   2. Clicks arrive on `sysEvent`, not `textEvent`. Only swipes reach `textEvent` (1 up / 2 down).
//   3. `LONG_PRESS_EVENT = 9` and `LONG_PRESS_RELEASE_EVENT = 10` both arrive, and always as a
//      pair. The release is mapped to its own event so the app can consume it deliberately rather
//      than letting it fall into an "unknown gesture" branch.
//
// Known conflict: the `handle-input` skill's event table stops at `8` and lists neither 9 nor 10.
// The SDK's `OsEventTypeList` declares both (`dist/index.d.ts:866-884`) and the probe received
// both, so the SDK + probe win (PLAN §10.3(a), 2026-09-08 correction).
import { EventSourceType, OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk';

/**
 * The §10.3(a) input vocabulary. Everything the app reacts to arrives as one of these; `IGNORED`
 * is for events that are genuinely not input (IMU samples, list events on a page with no list).
 */
export type UiEvent =
  | 'SCROLL_TOP'
  | 'SCROLL_BOTTOM'
  | 'CLICK'
  | 'DOUBLE_CLICK'
  | 'LONG_PRESS'
  | 'LONG_PRESS_RELEASE'
  | 'FOREGROUND_ENTER'
  | 'FOREGROUND_EXIT'
  | 'ABNORMAL_EXIT'
  | 'SYSTEM_EXIT'
  | 'IGNORED';

/**
 * `OsEventTypeList` → `UiEvent`, shared by both carrier fields.
 *
 * The four gestures PLAN §6 allows (tap / double-tap / swipe / long-press) are read from whichever
 * field delivers them: the probe saw swipes on `textEvent` and taps on `sysEvent`, but the enum is
 * one enum and the firmware is free to move a gesture between carriers (M6 D2 re-tests on device).
 * Accepting the same code from either field costs nothing and removes a whole class of dead input —
 * it does not invent a gesture, which §6 forbids.
 */
function fromEventType(type: OsEventTypeList): UiEvent {
  switch (type) {
    case OsEventTypeList.CLICK_EVENT:
      return 'CLICK';
    case OsEventTypeList.SCROLL_TOP_EVENT:
      return 'SCROLL_TOP';
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      return 'SCROLL_BOTTOM';
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      return 'DOUBLE_CLICK';
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      return 'FOREGROUND_ENTER';
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      return 'FOREGROUND_EXIT';
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      return 'ABNORMAL_EXIT';
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
      return 'SYSTEM_EXIT';
    case OsEventTypeList.LONG_PRESS_EVENT:
      return 'LONG_PRESS';
    case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
      return 'LONG_PRESS_RELEASE';
    default:
      // IMU_DATA_REPORT (8) and anything a future firmware adds.
      return 'IGNORED';
  }
}

/** For logs only. §7 / T3.3: ring and temple behave identically, so this never reaches the FSM. */
const SOURCE_LABEL: Readonly<Record<number, string>> = {
  [EventSourceType.TOUCH_EVENT_FORM_DUMMY_NULL]: 'unspecified',
  [EventSourceType.TOUCH_EVENT_FROM_GLASSES_R]: 'temple-right',
  [EventSourceType.TOUCH_EVENT_FROM_RING]: 'ring',
  [EventSourceType.TOUCH_EVENT_FROM_GLASSES_L]: 'temple-left',
};

export const InputRouter = {
  /**
   * §10.2 `map(rawEvent) UiEvent`. Pure: no bridge, no state, no side effects.
   *
   * Field order follows the SDK's own example (list → text → sys); one delivered event carries
   * exactly one of them.
   */
  map(event: EvenHubEvent): UiEvent {
    // No page in this app uses a list container, so a list event can only be noise.
    if (event.listEvent) return 'IGNORED';
    if (event.textEvent) return fromEventType(event.textEvent.eventType ?? OsEventTypeList.CLICK_EVENT);
    if (event.sysEvent) return fromEventType(event.sysEvent.eventType ?? OsEventTypeList.CLICK_EVENT);
    return 'IGNORED';
  },

  /**
   * Which surface produced the event, for the log line only. The probe found `long_press` arrives
   * with NO `eventSource` at all (zero-value omission again), which is exactly why this must never
   * be allowed to gate behaviour — a missing source would silently disable the menu gesture.
   */
  sourceLabel(event: EvenHubEvent): string {
    const source = event.sysEvent?.eventSource ?? EventSourceType.TOUCH_EVENT_FORM_DUMMY_NULL;
    return SOURCE_LABEL[source] ?? `source ${String(source)}`;
  },
} as const;
