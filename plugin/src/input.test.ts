// T3.3 — `InputRouter.map` against the event shapes the 2026-09-08 probe actually captured
// (`docs/DESIGN.md`, "T3.3 LONG_PRESS probe results"; simulator 0.9.5 / SDK 0.0.15).
//
// The events are built with the SDK's own model classes rather than object literals, so a change
// in the SDK's field names breaks this table instead of quietly passing.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  EventSourceType,
  OsEventTypeList,
  Sys_ItemEvent,
  Text_ItemEvent,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import { InputRouter } from './input.ts';
import type { UiEvent } from './input.ts';

/** `POST /api/input` action → the event that arrived → what the app must call it. */
const PROBE_TABLE: { action: string; event: EvenHubEvent; expected: UiEvent }[] = [
  {
    action: 'up',
    event: { textEvent: new Text_ItemEvent({ containerID: 3, containerName: 'card', eventType: 1 }) },
    expected: 'SCROLL_TOP',
  },
  {
    action: 'down',
    event: { textEvent: new Text_ItemEvent({ containerID: 3, containerName: 'card', eventType: 2 }) },
    expected: 'SCROLL_BOTTOM',
  },
  // The probe's headline finding: no `eventType` field at all, because CLICK_EVENT is 0 and
  // protobuf omits zero values.
  { action: 'click', event: { sysEvent: new Sys_ItemEvent({}) }, expected: 'CLICK' },
  {
    action: 'double_click',
    event: { sysEvent: new Sys_ItemEvent({ eventType: 3, eventSource: EventSourceType.TOUCH_EVENT_FROM_GLASSES_R }) },
    expected: 'DOUBLE_CLICK',
  },
  // 9 and 10 are absent from the `handle-input` skill's table; the SDK declares them and the
  // simulator delivers them, so the SDK wins (PLAN §10.3(a), 2026-09-08).
  { action: 'long_press', event: { sysEvent: new Sys_ItemEvent({ eventType: 9 }) }, expected: 'LONG_PRESS' },
  {
    action: 'long_press_release',
    event: { sysEvent: new Sys_ItemEvent({ eventType: 10 }) },
    expected: 'LONG_PRESS_RELEASE',
  },
  { action: 'context_menu', event: { sysEvent: new Sys_ItemEvent({ eventType: 4 }) }, expected: 'FOREGROUND_ENTER' },
];

for (const row of PROBE_TABLE) {
  test(`probe: injecting "${row.action}" maps to ${row.expected}`, () => {
    assert.equal(InputRouter.map(row.event), row.expected);
  });
}

test('the click fixture really is the zero-value-omitted shape', () => {
  // Without this control the click row above would pass just as happily against `eventType: 0`,
  // and the `?? 0` it exists to protect could be deleted unnoticed.
  const clicked = PROBE_TABLE.find((row) => row.action === 'click');
  assert.ok(clicked?.event.sysEvent);
  assert.equal(clicked.event.sysEvent.eventType, undefined);
  assert.equal(OsEventTypeList.CLICK_EVENT, 0);
});

test('`in` / `!== undefined` would have misread a single click — `?? 0` is the only correct read', () => {
  const sysEvent = new Sys_ItemEvent({});
  assert.equal(sysEvent.eventType !== undefined, false, 'a click carries no eventType to test for');
  assert.equal(sysEvent.eventType ?? OsEventTypeList.CLICK_EVENT, OsEventTypeList.CLICK_EVENT);
});

test('the four lifecycle events are routed, not dropped', () => {
  const lifecycle: [number, UiEvent][] = [
    [4, 'FOREGROUND_ENTER'],
    [5, 'FOREGROUND_EXIT'],
    [6, 'ABNORMAL_EXIT'],
    [7, 'SYSTEM_EXIT'],
  ];
  for (const [eventType, expected] of lifecycle) {
    assert.equal(InputRouter.map({ sysEvent: new Sys_ItemEvent({ eventType }) }), expected, `sysEvent ${eventType}`);
  }
});

test('non-input events are ignored rather than mistaken for a gesture', () => {
  assert.equal(InputRouter.map({ sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.IMU_DATA_REPORT }) }), 'IGNORED');
  assert.equal(InputRouter.map({}), 'IGNORED');
});

test('ring and temple produce the same UiEvent — the source is log-only (§7 / T3.3)', () => {
  const sources = [
    EventSourceType.TOUCH_EVENT_FROM_GLASSES_R,
    EventSourceType.TOUCH_EVENT_FROM_GLASSES_L,
    EventSourceType.TOUCH_EVENT_FROM_RING,
  ];
  const mapped = new Set(sources.map((eventSource) => InputRouter.map({ sysEvent: new Sys_ItemEvent({ eventSource }) })));
  assert.deepEqual([...mapped], ['CLICK']);
  // The distinction survives in the log line and nowhere else.
  assert.equal(InputRouter.sourceLabel({ sysEvent: new Sys_ItemEvent({ eventSource: 2 }) }), 'ring');
  assert.equal(InputRouter.sourceLabel({ sysEvent: new Sys_ItemEvent({ eventSource: 1 }) }), 'temple-right');
  // A long press arrives with no source at all; it must still be a legal, loggable event.
  assert.equal(InputRouter.sourceLabel({ sysEvent: new Sys_ItemEvent({ eventType: 9 }) }), 'unspecified');
});
