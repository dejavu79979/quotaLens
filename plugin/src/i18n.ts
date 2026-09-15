// QuotaLens plugin — one runtime string table for PLAN T10.8's six phone/glasses locales.

export type Locale = 'en' | 'zhHant' | 'zhHans' | 'ja' | 'ko' | 'de';

export const LOCALES: readonly Locale[] = ['en', 'zhHant', 'zhHans', 'ja', 'ko', 'de'];

type Weekdays = readonly [string, string, string, string, string, string, string];
type TwoLines = readonly [string, string];
type ThreeItems = readonly [string, string, string];
type FiveParts = readonly [string, string, string, string, string];

export interface Strings {
  glasses: {
    header: string;
    week: string;
    h5: string;
    credits: string;
    stale(amount: string): string;
    resets(day: string | null, hhmm: string): string;
    days: Weekdays;
    footer: string;
    onePage: string;
    setAddr: string;
    refreshing: string;
    connecting: string;
    noData: TwoLines;
    unconf: TwoLines;
    holdMenu: string;
    menu: ThreeItems;
    menuHdr: string;
    back: string;
    move: string;
    soon: string;
    creditsLeft(value: string): string;
  };
  phone: {
    relay: string;
    placeholder: string;
    hint: string;
    poll: string;
    minuteUnit: string;
    intervalLess: string;
    intervalMore: string;
    intervalField: string;
    test: string;
    testing: string;
    saved: string;
    savedBrowserOnly: string;
    savedRefused: string;
    savedBlocked: string;
    setup: string;
    need: string;
    bullets: ThreeItems;
    install: string;
    onMac: string;
    step2: FiveParts;
    copyLabel: string;
    copied: string;
    copyFailed: string;
  };
}

const PLACEHOLDER = 'http://100.x.y.z:8787';

export const STRINGS: Record<Locale, Strings> = {
  en: {
    glasses: {
      header: 'Agent usage',
      week: 'Week',
      h5: '5h',
      credits: 'Credits',
      stale: (amount) => `stale ${amount}`,
      resets: (day, hhmm) => (day === null ? `resets ${hhmm}` : `resets ${day} ${hhmm}`),
      days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      footer: 'tap refresh · hold menu',
      onePage: 'one page · hold menu',
      setAddr: 'set the address first',
      refreshing: 'refreshing…',
      connecting: 'Connecting…',
      noData: ['No usage data', 'tap refresh'],
      unconf: ['Set the relay address', 'in the Even App on your phone'],
      holdMenu: 'hold menu',
      menu: ['Refresh now', 'Token stats · soon', 'Exit'],
      menuHdr: 'Menu',
      back: 'double-tap = back',
      move: '▲▼ move · tap select',
      soon: 'coming in v2',
      creditsLeft: (value) => `${value} left`,
    },
    phone: {
      relay: 'Relay address',
      placeholder: PLACEHOLDER,
      hint: "Your desktop's tailnet address — the installer prints it.",
      poll: 'Poll interval',
      minuteUnit: 'min',
      intervalLess: 'Poll less often',
      intervalMore: 'Poll more often',
      intervalField: 'Poll interval in minutes',
      test: 'Test connection',
      testing: 'Testing…',
      saved: 'Saved',
      savedBrowserOnly: 'Saved (browser only — connect the glasses to keep it)',
      savedRefused: 'Not saved — the Even App refused to store it',
      savedBlocked: 'Not saved — this browser is blocking storage',
      setup: 'Setup',
      need: 'You need',
      bullets: [
        'macOS with Node 20.19+ (or 22.13+ / 24+)',
        'Claude Code and/or Codex CLI, signed in on your Mac',
        'Tailscale on the Mac and on the phone',
      ],
      install: 'Install',
      onMac: 'On the Mac:',
      step2: [
        'On the phone: open QuotaLens settings, paste the address the installer printed into ',
        'Relay address',
        ', tap ',
        'Test connection',
        '.',
      ],
      copyLabel: 'Copy install command',
      copied: 'Copied',
      copyFailed: 'Copy failed — select the text',
    },
  },
  zhHant: {
    glasses: {
      header: 'Agent 用量',
      week: '本週',
      h5: '5 小時',
      credits: '額度',
      stale: (amount) => `過期 ${amount}`,
      resets: (day, hhmm) => (day === null ? `${hhmm} 重置` : `${day} ${hhmm} 重置`),
      days: ['週日', '週一', '週二', '週三', '週四', '週五', '週六'],
      footer: '點一下重新整理 · 長按選單',
      onePage: '只有一頁 · 長按選單',
      setAddr: '請先設定位址',
      refreshing: '更新中…',
      connecting: '連線中…',
      noData: ['沒有用量資料', '點一下重新整理'],
      unconf: ['請設定 relay 位址', '在手機的 Even App 裡'],
      holdMenu: '長按選單',
      menu: ['立即重新整理', 'Token 統計 · 即將推出', '離開'],
      menuHdr: '選單',
      back: '點兩下 = 返回',
      move: '▲▼ 移動 · 點一下選取',
      soon: 'v2 推出',
      creditsLeft: (value) => `剩 ${value}`,
    },
    phone: {
      relay: 'Relay 位址',
      placeholder: PLACEHOLDER,
      hint: '桌機的 tailnet 位址 — 安裝程式會印出來。',
      poll: '輪詢間隔',
      minuteUnit: '分鐘',
      intervalLess: '拉長間隔',
      intervalMore: '縮短間隔',
      intervalField: '輪詢間隔(分鐘)',
      test: '測試連線',
      testing: '測試中…',
      saved: '已儲存',
      savedBrowserOnly: '已儲存（僅瀏覽器 — 連上眼鏡才會保留）',
      savedRefused: '未儲存 — Even App 拒絕儲存',
      savedBlocked: '未儲存 — 此瀏覽器封鎖了儲存空間',
      setup: '安裝說明',
      need: '你需要',
      bullets: [
        'macOS，Node 20.19+（或 22.13+ / 24+）',
        'Mac 上已登入 Claude Code 和/或 Codex CLI',
        'Mac 與手機都裝好 Tailscale',
      ],
      install: '安裝',
      onMac: '在 Mac 上：',
      step2: [
        '在手機上：打開 QuotaLens 設定，把安裝程式印出的位址貼到 ',
        'Relay 位址',
        '，再按 ',
        '測試連線',
        '。',
      ],
      copyLabel: '複製安裝指令',
      copied: '已複製',
      copyFailed: '複製失敗 — 請手動選取文字',
    },
  },
  zhHans: {
    glasses: {
      header: 'Agent 用量',
      week: '本周',
      h5: '5 小时',
      credits: '额度',
      stale: (amount) => `过期 ${amount}`,
      resets: (day, hhmm) => (day === null ? `${hhmm} 重置` : `${day} ${hhmm} 重置`),
      days: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
      footer: '点一下刷新 · 长按菜单',
      onePage: '只有一页 · 长按菜单',
      setAddr: '请先设置地址',
      refreshing: '更新中…',
      connecting: '连接中…',
      noData: ['没有用量数据', '点一下刷新'],
      unconf: ['请设置 relay 地址', '在手机的 Even App 里'],
      holdMenu: '长按菜单',
      menu: ['立即刷新', 'Token 统计 · 即将推出', '退出'],
      menuHdr: '菜单',
      back: '双击 = 返回',
      move: '▲▼ 移动 · 点一下选择',
      soon: 'v2 推出',
      creditsLeft: (value) => `剩 ${value}`,
    },
    phone: {
      relay: 'Relay 地址',
      placeholder: PLACEHOLDER,
      hint: '台式机的 tailnet 地址 — 安装程序会打印出来。',
      poll: '轮询间隔',
      minuteUnit: '分钟',
      intervalLess: '拉长间隔',
      intervalMore: '缩短间隔',
      intervalField: '轮询间隔(分钟)',
      test: '测试连接',
      testing: '测试中…',
      saved: '已保存',
      savedBrowserOnly: '已保存（仅浏览器 — 连接眼镜后才会保留）',
      savedRefused: '未保存 — Even App 拒绝存储',
      savedBlocked: '未保存 — 此浏览器阻止了存储',
      setup: '安装说明',
      need: '你需要',
      bullets: [
        'macOS，Node 20.19+（或 22.13+ / 24+）',
        'Mac 上已登录 Claude Code 和/或 Codex CLI',
        'Mac 与手机都装好 Tailscale',
      ],
      install: '安装',
      onMac: '在 Mac 上：',
      step2: [
        '在手机上：打开 QuotaLens 设置，把安装程序打印的地址粘贴到 ',
        'Relay 地址',
        '，再点 ',
        '测试连接',
        '。',
      ],
      copyLabel: '复制安装命令',
      copied: '已复制',
      copyFailed: '复制失败 — 请手动选择文字',
    },
  },
  ja: {
    glasses: {
      header: 'Agent 使用量',
      week: '週',
      h5: '5時間',
      credits: '残高',
      stale: (amount) => `古い ${amount}`,
      resets: (day, hhmm) => (day === null ? `${hhmm} 更新` : `${day} ${hhmm} 更新`),
      days: ['日', '月', '火', '水', '木', '金', '土'],
      footer: 'タップ更新 · 長押しメニュー',
      onePage: '1ページのみ · 長押しメニュー',
      setAddr: '先にアドレスを設定',
      refreshing: '更新中…',
      connecting: '接続中…',
      noData: ['使用量データなし', 'タップで更新'],
      unconf: ['relay アドレスを設定', 'スマホの Even App で'],
      holdMenu: '長押しメニュー',
      menu: ['今すぐ更新', 'Token 統計 · 近日', '終了'],
      menuHdr: 'メニュー',
      back: 'ダブルタップ = 戻る',
      move: '▲▼ 移動 · タップ選択',
      soon: 'v2 で対応',
      creditsLeft: (value) => `残り ${value}`,
    },
    phone: {
      relay: 'リレーアドレス',
      placeholder: PLACEHOLDER,
      hint: 'デスクトップの tailnet アドレス — インストーラーが表示します。',
      poll: '更新間隔',
      minuteUnit: '分',
      intervalLess: '間隔を長く',
      intervalMore: '間隔を短く',
      intervalField: 'ポーリング間隔(分)',
      test: '接続テスト',
      testing: 'テスト中…',
      saved: '保存しました',
      savedBrowserOnly: '保存しました（ブラウザのみ — メガネを接続すると保持されます）',
      savedRefused: '保存できません — Even App が保存を拒否しました',
      savedBlocked: '保存できません — このブラウザはストレージをブロックしています',
      setup: 'セットアップ',
      need: '必要なもの',
      bullets: [
        'macOS と Node 20.19+（または 22.13+ / 24+）',
        'Mac でサインイン済みの Claude Code か Codex CLI',
        'Mac とスマホの両方に Tailscale',
      ],
      install: 'インストール',
      onMac: 'Mac で：',
      step2: [
        'スマホで：QuotaLens の設定を開き、インストーラーが表示したアドレスを ',
        'リレーアドレス',
        ' に貼り付けて ',
        '接続テスト',
        ' をタップ。',
      ],
      copyLabel: 'インストールコマンドをコピー',
      copied: 'コピーしました',
      copyFailed: 'コピーできません — テキストを選択してください',
    },
  },
  ko: {
    glasses: {
      header: 'Agent 사용량',
      week: '주간',
      h5: '5시간',
      credits: '잔액',
      stale: (amount) => `오래됨 ${amount}`,
      resets: (day, hhmm) => (day === null ? `${hhmm} 초기화` : `${day} ${hhmm} 초기화`),
      days: ['일', '월', '화', '수', '목', '금', '토'],
      footer: '탭 새로고침 · 길게 메뉴',
      onePage: '한 페이지 · 길게 메뉴',
      setAddr: '먼저 주소를 설정하세요',
      refreshing: '갱신 중…',
      connecting: '연결 중…',
      noData: ['사용량 데이터 없음', '탭하여 새로고침'],
      unconf: ['relay 주소를 설정하세요', '휴대폰의 Even App에서'],
      holdMenu: '길게 메뉴',
      menu: ['지금 새로고침', '토큰 통계 · 곧 제공', '종료'],
      menuHdr: '메뉴',
      back: '더블탭 = 뒤로',
      move: '▲▼ 이동 · 탭 선택',
      soon: 'v2 예정',
      creditsLeft: (value) => `${value} 남음`,
    },
    phone: {
      relay: '릴레이 주소',
      placeholder: PLACEHOLDER,
      hint: '데스크톱의 tailnet 주소 — 설치 프로그램이 출력합니다.',
      poll: '폴링 간격',
      minuteUnit: '분',
      intervalLess: '간격 늘리기',
      intervalMore: '간격 줄이기',
      intervalField: '폴링 간격(분)',
      test: '연결 테스트',
      testing: '테스트 중…',
      saved: '저장됨',
      savedBrowserOnly: '저장됨 (브라우저에만 — 안경을 연결하면 유지됩니다)',
      savedRefused: '저장 안 됨 — Even App이 저장을 거부했습니다',
      savedBlocked: '저장 안 됨 — 이 브라우저가 저장소를 차단합니다',
      setup: '설치 안내',
      need: '필요한 것',
      bullets: [
        'macOS, Node 20.19+ (또는 22.13+ / 24+)',
        'Mac에 로그인된 Claude Code 및/또는 Codex CLI',
        'Mac과 휴대폰 모두에 Tailscale',
      ],
      install: '설치',
      onMac: 'Mac에서:',
      step2: [
        '휴대폰에서: QuotaLens 설정을 열고 설치 프로그램이 출력한 주소를 ',
        '릴레이 주소',
        '에 붙여넣은 뒤 ',
        '연결 테스트',
        '를 탭하세요.',
      ],
      copyLabel: '설치 명령 복사',
      copied: '복사됨',
      copyFailed: '복사 실패 — 텍스트를 직접 선택하세요',
    },
  },
  de: {
    glasses: {
      header: 'Agent-Nutzung',
      week: 'Woche',
      h5: '5 Std',
      credits: 'Saldo',
      stale: (amount) => `alt ${amount}`,
      resets: (day, hhmm) => (day === null ? `Reset ${hhmm}` : `Reset ${day} ${hhmm}`),
      days: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
      footer: 'Tipp = Aktualisieren · Halten = Menü',
      onePage: 'eine Seite · Halten = Menü',
      setAddr: 'zuerst Adresse setzen',
      refreshing: 'aktualisiere…',
      connecting: 'Verbinde…',
      noData: ['Keine Nutzungsdaten', 'Tippen zum Aktualisieren'],
      unconf: ['Relay-Adresse festlegen', 'in der Even App am Handy'],
      holdMenu: 'Halten = Menü',
      menu: ['Jetzt aktualisieren', 'Token-Statistik · bald', 'Beenden'],
      menuHdr: 'Menü',
      back: 'Doppeltipp = zurück',
      move: '▲▼ bewegen · Tipp = wählen',
      soon: 'kommt in v2',
      creditsLeft: (value) => `${value} übrig`,
    },
    phone: {
      relay: 'Relay-Adresse',
      placeholder: PLACEHOLDER,
      hint: 'Die Tailnet-Adresse deines Macs — der Installer gibt sie aus.',
      poll: 'Intervall',
      minuteUnit: 'Min',
      intervalLess: 'Seltener abfragen',
      intervalMore: 'Häufiger abfragen',
      intervalField: 'Abfrageintervall in Minuten',
      test: 'Verbindung testen',
      testing: 'Teste…',
      saved: 'Gespeichert',
      savedBrowserOnly: 'Gespeichert (nur im Browser — Brille verbinden, um es zu behalten)',
      savedRefused: 'Nicht gespeichert — die Even App hat es abgelehnt',
      savedBlocked: 'Nicht gespeichert — dieser Browser blockiert den Speicher',
      setup: 'Einrichtung',
      need: 'Voraussetzungen',
      bullets: [
        'macOS mit Node 20.19+ (oder 22.13+ / 24+)',
        'Claude Code und/oder Codex CLI, am Mac angemeldet',
        'Tailscale auf Mac und Handy',
      ],
      install: 'Installation',
      onMac: 'Am Mac:',
      step2: [
        'Am Handy: QuotaLens-Einstellungen öffnen, die vom Installer ausgegebene Adresse in ',
        'Relay-Adresse',
        ' einfügen und ',
        'Verbindung testen',
        ' antippen.',
      ],
      copyLabel: 'Installationsbefehl kopieren',
      copied: 'Kopiert',
      copyFailed: 'Kopieren fehlgeschlagen — Text markieren',
    },
  },
};

let locale: Locale = 'en';

export function detectLocale(tags: readonly string[]): Locale {
  for (const raw of tags) {
    const tag = raw.toLowerCase();
    if (tag === 'zh-hant' || tag.startsWith('zh-hant-') || /^zh-(tw|hk|mo)(?:-|$)/.test(tag)) {
      return 'zhHant';
    }
    if (tag === 'zh' || tag.startsWith('zh-')) return 'zhHans';
    if (tag === 'ja' || tag.startsWith('ja-')) return 'ja';
    if (tag === 'ko' || tag.startsWith('ko-')) return 'ko';
    if (tag === 'de' || tag.startsWith('de-')) return 'de';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return 'en';
}

export function setLocale(next: Locale): void {
  locale = next;
}

export function currentLocale(): Locale {
  return locale;
}

export function t(): Strings {
  return STRINGS[locale];
}

/** Browser/HTML language tag for the internal locale names that distinguish both Chinese scripts. */
export function localeTag(value: Locale): string {
  return value === 'zhHant' ? 'zh-Hant' : value === 'zhHans' ? 'zh-Hans' : value;
}
