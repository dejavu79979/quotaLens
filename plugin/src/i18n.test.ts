// Fixed +10:00 zone so the PLAN §7 fixtures render their documented weekday and clock labels.
process.env.TZ = 'Australia/Brisbane';

import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import type { UsagePayload } from '@quotalens/shared';
import {
  CLAUDE_ONLY_PAYLOAD,
  CODEX_ONLY_PAYLOAD,
  DEMO_NOW,
  DEMO_PAYLOAD,
  EXTREME_PAYLOAD,
  NO_DATA_PAYLOAD,
} from './fixtures.ts';
import { Formatter } from './format.ts';
import { currentLocale, detectLocale, LOCALES, localeTag, setLocale, STRINGS, t } from './i18n.ts';
import {
  CANVAS_W,
  DEFAULT_SETTINGS,
  innerWidthOf,
  validatePage,
  type Screen,
  type ScreenInput,
  type TextSpec,
} from './render.ts';
import { menuScreen } from './screens/menu.ts';
import {
  allScreen,
  BAR_COL_CANDIDATES,
  BAR_COL_W,
  LABEL_CANDIDATES,
  LABEL_COL_W,
  ONE_PAGE,
  REFRESHING,
  SECTION_VALUE_CANDIDATES,
  SET_ADDRESS_FIRST,
  VALUE_COL_W,
} from './screens/tool.ts';
import { formatTestRow, savedRowText } from './settings-page.ts';

after(() => setLocale('en'));

function input(overrides: Partial<ScreenInput> = {}): ScreenInput {
  return {
    payload: DEMO_PAYLOAD,
    now: DEMO_NOW,
    settings: DEFAULT_SETTINGS,
    errorCode: null,
    cursor: 0,
    ...overrides,
  };
}

const BOTH_STALE_NOW = new Date(Date.parse(EXTREME_PAYLOAD.claude.fetchedAt!) + 21 * 60_000);
const CREDITS_ONLY_PAYLOAD: UsagePayload = {
  ...CODEX_ONLY_PAYLOAD,
  codex: { ...CODEX_ONLY_PAYLOAD.codex, weekly: null, credits: { remainingUsd: 4.2 } },
};

// Rebuilt from screens.test.ts so the production test need not export test-only fixture plumbing.
const CASES: { name: string; input: ScreenInput }[] = [
  { name: 'G1', input: input() },
  { name: 'G2', input: input({ payload: EXTREME_PAYLOAD }) },
  {
    name: 'G3',
    input: input({ payload: EXTREME_PAYLOAD, now: BOTH_STALE_NOW, statusNotice: REFRESHING }),
  },
  { name: "F1'", input: input({ payload: CLAUDE_ONLY_PAYLOAD }) },
  { name: "F1''", input: input({ payload: CODEX_ONLY_PAYLOAD }) },
  { name: "F1'''", input: input({ payload: NO_DATA_PAYLOAD }) },
  { name: 'F4', input: input({ payload: CREDITS_ONLY_PAYLOAD }) },
  { name: "F2'", input: input({ payload: null, errorCode: 'bad schema' }) },
  { name: 'F3', input: input({ unconfigured: true }) },
  { name: 'H', input: input({ notice: ONE_PAGE }) },
  { name: 'H2', input: input({ notice: ONE_PAGE, statusNotice: REFRESHING }) },
  { name: 'C2', input: input({ cursor: 2 }) },
];

const DETECTION_CASES: Array<{ tags: readonly string[]; expected: ReturnType<typeof detectLocale> }> = [
  { tags: ['zh-TW'], expected: 'zhHant' },
  { tags: ['zh-CN'], expected: 'zhHans' },
  { tags: ['zh'], expected: 'zhHans' },
  { tags: ['zh-Hant-HK'], expected: 'zhHant' },
  { tags: ['ja-JP'], expected: 'ja' },
  { tags: ['ko-KR'], expected: 'ko' },
  { tags: ['de-AT'], expected: 'de' },
  { tags: ['fr-FR'], expected: 'en' },
  { tags: [], expected: 'en' },
];

test('detectLocale follows the T10.8 matrix and the first supported tag wins', () => {
  for (const { tags, expected } of DETECTION_CASES) {
    assert.equal(detectLocale(tags), expected, tags.join(','));
  }
  assert.equal(detectLocale(['fr-FR', 'KO-kr', 'de-DE']), 'ko');
});

test('locale state defaults to English and reads the selected table at call time', () => {
  setLocale('en');
  assert.equal(currentLocale(), 'en');
  assert.equal(t().glasses.header, 'Agent usage');
  setLocale('zhHans');
  assert.equal(t().phone.test, '测试连接');
  setLocale('en');
});

test('phone status copy and BCP 47 tags follow the current locale at call time', () => {
  try {
    assert.deepEqual(LOCALES.map(localeTag), ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de']);
    setLocale('ja');
    assert.equal(formatTestRow({ kind: 'busy' }), 'テスト中…');
    assert.equal(savedRowText('persisted'), '保存しました');
    setLocale('de');
    assert.equal(savedRowText('blocked'), 'Nicht gespeichert — dieser Browser blockiert den Speicher');
  } finally {
    setLocale('en');
  }
});

test('T10.9 phone interval controls have non-empty copy in every locale', () => {
  for (const locale of LOCALES) {
    const phone = STRINGS[locale].phone;
    for (const key of ['minuteUnit', 'intervalLess', 'intervalMore', 'intervalField'] as const) {
      assert.ok(phone[key].length > 0, `${locale}.${key}`);
    }
  }
});

function byName(specs: readonly TextSpec[], name: string): TextSpec {
  const spec = specs.find((candidate) => candidate.name === name);
  assert.ok(spec, `no container named ${name}`);
  return spec;
}

function assertFits(screen: Screen, testCase: (typeof CASES)[number]): void {
  const specs = screen.buildContainers(testCase.input);
  assert.deepEqual(validatePage(specs), [], `${screen.id}/${testCase.name}`);
  for (const spec of specs) {
    const measured = Formatter.measureLines(spec.content, innerWidthOf(spec));
    assert.equal(
      measured.lineCount,
      spec.content.split('\n').length,
      `${screen.id}/${testCase.name}/${spec.name} wrapped: ${JSON.stringify(spec.content)}`,
    );
    assert.ok(!spec.content.includes('...'), `${screen.id}/${testCase.name}/${spec.name} truncated`);
  }
}

test('all six locales fit the fixed measured columns and canvas for every screen case', () => {
  try {
    const widestLabel = LABEL_CANDIDATES.reduce((a, b) =>
      Formatter.textWidth(b) > Formatter.textWidth(a) ? b : a,
    );
    assert.equal(widestLabel, 'CLAUDE');
    assert.equal(LABEL_COL_W, 68);

    for (const locale of LOCALES) {
      setLocale(locale);
      const strings = STRINGS[locale].glasses;

      for (const label of [strings.h5, strings.week, strings.credits]) {
        assert.ok(Formatter.textWidth(label) <= LABEL_COL_W, `${locale} label: ${label}`);
      }
      for (const candidate of BAR_COL_CANDIDATES) {
        assert.ok(Formatter.textWidth(candidate) <= BAR_COL_W, `${locale} bar: ${candidate}`);
      }
      for (const candidate of SECTION_VALUE_CANDIDATES) {
        assert.ok(Formatter.textWidth(candidate) <= VALUE_COL_W, `${locale} value: ${candidate}`);
      }

      const toolFooter = byName(allScreen.buildContainers(input()), 'ftrLeft');
      for (const text of [strings.footer, strings.onePage, strings.setAddr, strings.holdMenu]) {
        assert.ok(Formatter.textWidth(text) <= innerWidthOf(toolFooter), `${locale} footer: ${text}`);
      }
      const menu = menuScreen.buildContainers(input());
      const menuFooter = byName(menu, 'ftrLeft');
      for (const text of [strings.move, strings.soon]) {
        assert.ok(Formatter.textWidth(text) <= innerWidthOf(menuFooter), `${locale} menu footer: ${text}`);
      }
      for (const name of ['hdrLeft', 'hdrRight', 'opt1', 'opt2', 'opt3', 'ftrLeft', 'ftrRight']) {
        const spec = byName(menu, name);
        assert.ok(spec.x + spec.w <= CANVAS_W, `${locale}/${name} leaves the canvas`);
      }

      for (const testCase of CASES) {
        assertFits(allScreen, testCase);
        assertFits(menuScreen, testCase);
      }
    }
  } finally {
    setLocale('en');
  }
});

test('zhHant G1 renders the approved card, bar suffixes, and footer copy', () => {
  try {
    setLocale('zhHant');
    const specs = allScreen.buildContainers(input());
    assert.deepEqual(byName(specs, 'card').content.split('\n'), [
      '',
      '5 小時',
      '本週',
      'Fable',
      '',
      '',
      '本週',
    ]);
    assert.deepEqual(byName(specs, 'cardBars').content.split('\n'), [
      '',
      '████████▒▒▒▒ 14:20 重置',
      '███▒▒▒▒▒▒▒▒▒ 週四 09:00 重置',
      '█▒▒▒▒▒▒▒▒▒▒▒',
      '',
      '',
      '████████▒▒▒▒ 週一 08:00 重置',
    ]);
    assert.equal(byName(specs, 'ftrLeft').content, '點一下重新整理 · 長按選單');
  } finally {
    setLocale('en');
  }
});

test('localized footer tokens change only at the display edge', () => {
  try {
    setLocale('de');
    assert.equal(byName(allScreen.buildContainers(input({ notice: SET_ADDRESS_FIRST })), 'ftrLeft').content, 'zuerst Adresse setzen');
    assert.equal(byName(allScreen.buildContainers(input({ statusNotice: REFRESHING })), 'ftrRight').content, 'aktualisiere…');
  } finally {
    setLocale('en');
  }
});
