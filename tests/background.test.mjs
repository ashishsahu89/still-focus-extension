import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const backgroundCode = await readFile(
  new URL("../background.js", import.meta.url),
  "utf8"
);
const tabOrganizerCode = await readFile(
  new URL("../tab-organizer.js", import.meta.url),
  "utf8"
);
const tabCrowdingCode = await readFile(
  new URL("../tab-crowding.js", import.meta.url),
  "utf8"
);
const aiConnectionsCode = await readFile(
  new URL("../ai-connections.js", import.meta.url),
  "utf8"
);

function extensionEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function createHarness({
  initialState = {},
  initialSessionState = {},
  tabs = [],
  initialNow = 1_800_000_000_000,
  initialFocusedWindowId = 1,
  windowWidth = 1280,
  initialIdleState = "active",
  fetchImpl
} = {}) {
  let now = initialNow;
  let focusedWindowId = initialFocusedWindowId;
  let idleState = initialIdleState;
  const tabState = clone(tabs);
  const state = clone(initialState);
  const sessionState = clone(initialSessionState);
  const updates = [];
  const tabGroupMoves = [];
  const alarms = new Map();
  const notifications = new Map();
  const dynamicRules = new Map();
  const registeredScripts = new Map();
  const badge = { text: "", color: "" };
  let localStorageAccessLevel = "";
  const events = {
    installed: extensionEvent(),
    startup: extensionEvent(),
    alarm: extensionEvent(),
    message: extensionEvent(),
    beforeNavigate: extensionEvent(),
    historyStateUpdated: extensionEvent(),
    createdNavigationTarget: extensionEvent(),
    storageChanged: extensionEvent(),
    notificationButtonClicked: extensionEvent(),
    tabActivated: extensionEvent(),
    tabUpdated: extensionEvent(),
    tabRemoved: extensionEvent(),
    tabGroupUpdated: extensionEvent(),
    tabGroupRemoved: extensionEvent(),
    windowFocusChanged: extensionEvent(),
    idleStateChanged: extensionEvent()
  };
  const tabGroups = new Map();
  const timers = new Map();
  let nextGroupId = 1;
  let nextTimerId = 1;

  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }

    static now() {
      return now;
    }
  }

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === "string") return { [keys]: clone(state[keys]) };
          if (!keys) return clone(state);
          return Object.fromEntries(keys.map((key) => [key, clone(state[key])]));
        },
        async set(values) {
          const changes = {};
          for (const [key, value] of Object.entries(values)) {
            changes[key] = {
              oldValue: clone(state[key]),
              newValue: clone(value)
            };
          }
          Object.assign(state, clone(values));
          for (const listener of events.storageChanged.listeners) {
            listener(changes, "local");
          }
        },
        async setAccessLevel({ accessLevel }) {
          localStorageAccessLevel = accessLevel;
        }
      },
      session: {
        async get(keys) {
          if (typeof keys === "string") return { [keys]: clone(sessionState[keys]) };
          if (!keys) return clone(sessionState);
          return Object.fromEntries(keys.map((key) => [key, clone(sessionState[key])]));
        },
        async set(values) {
          Object.assign(sessionState, clone(values));
        }
      },
      onChanged: events.storageChanged
    },
    runtime: {
      id: "still",
      onInstalled: events.installed,
      onStartup: events.startup,
      onMessage: events.message,
      getURL(path) {
        return `chrome-extension://still/${path}`;
      }
    },
    webNavigation: {
      onBeforeNavigate: events.beforeNavigate,
      onHistoryStateUpdated: events.historyStateUpdated,
      onCreatedNavigationTarget: events.createdNavigationTarget
    },
    alarms: {
      onAlarm: events.alarm,
      create(name, details) {
        alarms.set(name, clone(details));
      },
      async clear(name) {
        return alarms.delete(name);
      },
      async getAll() {
        return Array.from(alarms, ([name, details]) => ({
          name,
          ...clone(details)
        }));
      }
    },
    notifications: {
      onButtonClicked: events.notificationButtonClicked,
      async create(id, options) {
        notifications.set(id, clone(options));
        return id;
      },
      async clear(id) {
        return notifications.delete(id);
      }
    },
    tabs: {
      onActivated: events.tabActivated,
      onUpdated: events.tabUpdated,
      onRemoved: events.tabRemoved,
      async query(queryInfo = {}) {
        return clone(
          tabState.filter(
            (tab) =>
              (queryInfo.active === undefined || tab.active === queryInfo.active) &&
              (queryInfo.lastFocusedWindow === undefined || (tab.windowId ?? 1) === focusedWindowId) &&
              (queryInfo.windowId === undefined ||
                (tab.windowId ?? 1) === queryInfo.windowId)
          )
        );
      },
      async get(tabId) {
        return clone(tabState.find((tab) => tab.id === tabId));
      },
      async update(tabId, details) {
        updates.push({ tabId, ...clone(details) });
        const tab = tabState.find((item) => item.id === tabId);
        if (tab && details.url) tab.url = details.url;
        return clone(tab);
      },
      async group({ tabIds, groupId }) {
        const ids = (Array.isArray(tabIds) ? tabIds : [tabIds]).filter(Number.isInteger);
        const id = Number.isInteger(groupId) ? groupId : nextGroupId++;
        if (!tabGroups.has(id)) tabGroups.set(id, { id, title: "", color: "grey", collapsed: false });
        const previousGroupIds = new Set(
          tabState
            .filter((tab) => ids.includes(tab.id) && Number.isInteger(tab.groupId) && tab.groupId !== -1)
            .map((tab) => tab.groupId)
        );
        for (const tab of tabState) {
          if (ids.includes(tab.id)) tab.groupId = id;
        }
        for (const previousGroupId of previousGroupIds) {
          if (previousGroupId !== id && !tabState.some((tab) => tab.groupId === previousGroupId)) {
            tabGroups.delete(previousGroupId);
          }
        }
        return id;
      },
      async ungroup(tabIds) {
        for (const tab of tabState) {
          if (tabIds.includes(tab.id)) tab.groupId = -1;
        }
      }
    },
    tabGroups: {
      onUpdated: events.tabGroupUpdated,
      onRemoved: events.tabGroupRemoved,
      async move(groupId, moveProperties) {
        tabGroupMoves.push({ groupId, ...clone(moveProperties) });
        return clone(tabGroups.get(groupId));
      },
      async update(groupId, changes) {
        const group = { ...(tabGroups.get(groupId) || { id: groupId }), ...clone(changes) };
        tabGroups.set(groupId, group);
        for (const listener of events.tabGroupUpdated.listeners) listener(clone(group));
        return clone(group);
      },
      async query(queryInfo = {}) {
        return clone(
          Array.from(tabGroups.values()).filter(
            (group) => queryInfo.windowId === undefined || group.windowId === queryInfo.windowId
          )
        );
      }
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: events.windowFocusChanged,
      async getLastFocused() {
        return {
          id: focusedWindowId,
          focused: focusedWindowId !== -1
        };
      },
      async get(windowId) {
        return { id: windowId, width: windowWidth, focused: windowId === focusedWindowId };
      }
    },
    idle: {
      onStateChanged: events.idleStateChanged,
      async queryState() {
        return idleState;
      }
    },
    declarativeNetRequest: {
      async getDynamicRules() {
        return clone(Array.from(dynamicRules.values()));
      },
      async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
        for (const id of removeRuleIds) dynamicRules.delete(id);
        for (const rule of addRules) dynamicRules.set(rule.id, clone(rule));
      }
    },
    scripting: {
      async getRegisteredContentScripts() {
        return clone(Array.from(registeredScripts.values()));
      },
      async unregisterContentScripts({ ids } = {}) {
        if (!ids) {
          registeredScripts.clear();
          return;
        }
        for (const id of ids) registeredScripts.delete(id);
      },
      async registerContentScripts(scripts) {
        for (const script of scripts) registeredScripts.set(script.id, clone(script));
      }
    },
    action: {
      async setBadgeBackgroundColor({ color }) {
        badge.color = color;
      },
      async setBadgeText({ text }) {
        badge.text = text;
      }
    }
  };

  vm.runInNewContext(`${tabOrganizerCode}\n${tabCrowdingCode}\n${aiConnectionsCode}\n${backgroundCode}`, {
    chrome,
    Date: FakeDate,
    URL,
    Map,
    Object,
    Promise,
    String,
    Number,
    Math,
    console: {
      error() {}
    },
    globalThis: { StillPreviewAIConnectionFetch: fetchImpl },
    importScripts() {},
    setTimeout(callback) {
      const timerId = nextTimerId++;
      timers.set(timerId, callback);
      return timerId;
    },
    clearTimeout(timerId) {
      timers.delete(timerId);
    }
  });

  function defaultSender(message) {
    if (["ALLOW_SITE", "START_TASK_ACCESS", "CLEAR_STALE_STRICT_RULES"].includes(message?.type)) {
      return {
        id: chrome.runtime.id,
        url: chrome.runtime.getURL("intervention.html")
      };
    }
    return {
      id: chrome.runtime.id,
      url: chrome.runtime.getURL("popup.html")
    };
  }

  async function send(message, sender = defaultSender(message)) {
    let response;
    events.message.listeners[0](message, sender, (value) => {
      response = value;
    });
    for (let attempt = 0; response === undefined && attempt < 20; attempt += 1) {
      await settle();
    }
    return response;
  }

  return {
    alarms,
    badge,
    dynamicRules,
    tabGroups,
    tabGroupMoves,
    events,
    notifications,
    get localStorageAccessLevel() {
      return localStorageAccessLevel;
    },
    registeredScripts,
    async runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
      await settle();
    },
    send,
    activateTab(tabId) {
      const selected = tabState.find((tab) => tab.id === tabId);
      if (!selected) return;
      for (const tab of tabState) {
        if ((tab.windowId ?? 1) === (selected.windowId ?? 1)) {
          tab.active = tab.id === tabId;
        }
      }
    },
    removeTab(tabId) {
      const index = tabState.findIndex((tab) => tab.id === tabId);
      if (index >= 0) tabState.splice(index, 1);
    },
    setFocusedWindowId(value) {
      focusedWindowId = value;
    },
    setIdleState(value) {
      idleState = value;
    },
    setNow(value) {
      now = value;
    },
    setTabUrl(tabId, url) {
      const tab = tabState.find((item) => item.id === tabId);
      if (tab) tab.url = url;
    },
    state,
    tabs: tabState,
    updates
  };
}

const defaultSites = [
  { host: "youtube.com", label: "YouTube", enabled: true },
  { host: "instagram.com", label: "Instagram", enabled: true },
  { host: "reddit.com", label: "Reddit", enabled: true }
];

function baseState(overrides = {}) {
  return {
    protectedSites: clone(defaultSites),
    mindfulMode: true,
    pauseSeconds: 8,
    strictFocus: true,
    focus: null,
    passes: {},
    passStarts: {},
    passDetails: {},
    mindfulWindows: {},
    focusBreak: null,
    stats: {},
    siteStats: {},
    usageStats: {},
    usageEvents: [],
    usageTracker: null,
    usageTrackingEnabled: true,
    linkTrailGroupingEnabled: true,
    impulseEvents: [],
    focusSessions: [],
    intentions: [],
    focusExits: [],
    routines: [],
    routineSkips: {},
    activeRoutine: null,
    dismissedRoutineSuggestions: {},
    ...overrides
  };
}

function localTimestamp(year, month, day, hour, minute) {
  return new Date(year, month, day, hour, minute, 0, 0).getTime();
}

function routine(overrides = {}) {
  return {
    id: "deep-work",
    name: "Deep work",
    days: [1],
    startTime: "09:00",
    endTime: "11:00",
    mode: "strict",
    startBehavior: "automatic",
    topic: "Write the brief",
    siteHosts: ["youtube.com", "reddit.com"],
    enabled: true,
    ...overrides
  };
}

test("starting strict focus snapshots protection, clears passes, and redirects open protected tabs", async () => {
  const now = 1_800_000_000_000;
  const harness = createHarness({
    initialNow: now,
    initialState: baseState({ passes: { "youtube.com": now + 60_000 } }),
    tabs: [
      { id: 1, url: "https://www.youtube.com/watch?v=1" },
      { id: 2, url: "https://reddit.com/r/productivity" },
      { id: 3, url: "https://example.com/" }
    ]
  });
  await settle();

  const response = await harness.send({
    type: "START_FOCUS",
    minutes: 25,
    intention: "Write tests"
  });

  assert.equal(response.ok, true);
  assert.equal(harness.state.focus.strict, true);
  assert.deepEqual(
    Array.from(harness.state.focus.protectedSites, (site) => site.host),
    ["youtube.com", "instagram.com", "reddit.com"]
  );
  assert.deepEqual(harness.state.passes, {});
  assert.equal(harness.alarms.has("pass:youtube.com"), false);
  assert.equal(harness.alarms.get("focus-complete").when, now + 25 * 60_000);
  assert.deepEqual(
    harness.updates.map((update) => update.tabId).sort(),
    [1, 2]
  );
  assert.ok(harness.updates.every((update) => update.url.includes("focus=true")));
  assert.ok(harness.updates.every((update) => update.url.includes("strict=true")));
  const strictRule = harness.dynamicRules.get(10001);
  assert.deepEqual(strictRule.condition.requestDomains, [
    "youtube.com",
    "instagram.com",
    "reddit.com"
  ]);
  assert.equal(strictRule.action.type, "redirect");
});

test("strict exit is background-enforced and records partial progress", async () => {
  const now = 1_800_000_000_000;
  const harness = createHarness({
    initialNow: now,
    initialState: baseState()
  });
  await settle();
  await harness.send({ type: "START_FOCUS", minutes: 25, intention: "Deep work" });

  const directStop = await harness.send({
    type: "STOP_FOCUS",
    reason: "Distracted"
  });
  assert.equal(directStop.ok, false);
  assert.equal(directStop.reason, "cooldown-active");

  const request = await harness.send({ type: "REQUEST_FOCUS_EXIT" });
  assert.equal(request.unlockAt, now + 20_000);

  harness.setNow(now + 19_000);
  const earlyStop = await harness.send({
    type: "STOP_FOCUS",
    reason: "A real interruption"
  });
  assert.equal(earlyStop.ok, false);

  harness.setNow(now + 21_000);
  const stopped = await harness.send({
    type: "STOP_FOCUS",
    reason: "A real interruption"
  });
  assert.equal(stopped.ok, true);
  assert.equal(harness.state.focus, null);
  const day = Object.values(harness.state.stats)[0];
  assert.equal(day.focusedSeconds, 21);
  assert.equal(day.sessions, 1);
  assert.equal(day.interruptedSessions, 1);
  assert.equal(harness.state.focusExits[0].reason, "A real interruption");
  assert.equal(harness.state.focusExits[0].elapsedSeconds, 21);
  assert.equal(harness.state.focusSessions[0].focusedSeconds, 21);
  assert.equal(harness.state.focusSessions[0].completed, false);
  assert.equal(harness.state.focusSessions[0].intention, "Deep work");
  assert.equal(harness.dynamicRules.size, 0);
});

test("confirmed emergency exit remains immediately available", async () => {
  const now = 1_800_000_000_000;
  const harness = createHarness({
    initialNow: now,
    initialState: baseState()
  });
  await settle();
  await harness.send({ type: "START_FOCUS", minutes: 25, intention: "Deep work" });

  const unconfirmed = await harness.send({
    type: "STOP_FOCUS",
    emergency: true
  });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.reason, "emergency-confirmation-required");

  harness.setNow(now + 5_000);
  const confirmed = await harness.send({
    type: "STOP_FOCUS",
    emergency: true,
    confirmed: true,
    reason: "Urgent call"
  });
  assert.equal(confirmed.ok, true);
  assert.equal(harness.state.focusExits[0].emergency, true);
  assert.equal(harness.state.focusExits[0].reason, "Urgent call");
});

test("strict focus uses a preventive rule and still records history-state impulses", async () => {
  const now = 1_800_000_000_000;
  const harness = createHarness({
    initialNow: now,
    initialState: baseState({
      protectedSites: [
        { host: "youtube.com", label: "YouTube", enabled: false }
      ],
      focus: {
        startedAt: now - 60_000,
        endAt: now + 20 * 60_000,
        minutes: 21,
        intention: "Plan",
        strict: true,
        protectedSites: [{ host: "youtube.com", label: "YouTube" }]
      }
    })
  });
  await settle();

  await eventsCall(harness.events.historyStateUpdated, {
    frameId: 0,
    tabId: 7,
    url: "https://www.youtube.com/shorts/abc"
  });

  assert.equal(harness.updates.length, 0);
  assert.deepEqual(
    harness.dynamicRules.get(10001).condition.requestDomains,
    ["youtube.com"]
  );
  assert.equal(Object.values(harness.state.stats)[0].impulsesPaused, 1);
});

test("startup completes an expired focus and restores active alarms", async () => {
  const now = 1_800_000_000_000;
  const expired = createHarness({
    initialNow: now,
    initialState: baseState({
      focus: {
        startedAt: now - 30 * 60_000,
        endAt: now - 5 * 60_000,
        minutes: 25,
        intention: "Expired session"
      }
    })
  });
  await settle();
  assert.equal(expired.state.focus, null);
  assert.equal(Object.values(expired.state.stats)[0].focusedMinutes, 25);
  assert.equal(expired.badge.text, "");

  const active = createHarness({
    initialNow: now,
    initialState: baseState({
      focus: {
        startedAt: now - 5 * 60_000,
        endAt: now + 20 * 60_000,
        minutes: 25,
        intention: "Restored session"
      }
    })
  });
  await settle();
  assert.equal(active.state.focus.strict, true);
  assert.equal(active.state.focus.protectedSites.length, 3);
  assert.equal(active.alarms.get("focus-complete").when, now + 20 * 60_000);
  assert.equal(active.badge.text, "20");
});

test("startup clears an expired pass even if its site was disabled", async () => {
  const now = 1_800_000_000_000;
  const harness = createHarness({
    initialNow: now,
    initialState: baseState({
      protectedSites: [
        { host: "youtube.com", label: "YouTube", enabled: false }
      ],
      passes: { "youtube.com": now - 1 }
    })
  });
  await settle();

  assert.deepEqual(harness.state.passes, {});
  assert.equal(harness.alarms.has("pass:youtube.com"), false);
});

test("an intercepted impulse is recorded in aggregate, by site, and by time", async () => {
  const now = 1_800_000_000_000;
  const harness = createHarness({
    initialNow: now,
    initialState: baseState()
  });
  await settle();

  await eventsCall(harness.events.beforeNavigate, {
    frameId: 0,
    tabId: 9,
    url: "https://www.youtube.com/watch?v=focus"
  });

  const day = Object.values(harness.state.stats)[0];
  const siteDay = Object.values(harness.state.siteStats)[0];
  assert.equal(day.impulsesPaused, 1);
  assert.equal(siteDay["youtube.com"].impulses, 1);
  assert.equal(siteDay["youtube.com"].usageSeconds, 0);
  assert.deepEqual(
    { ...harness.state.impulseEvents[0] },
    { host: "youtube.com", createdAt: now }
  );
});

test("concurrent navigation events cannot overwrite each other's impulse data", async () => {
  const now = 1_800_000_000_000;
  const harness = createHarness({
    initialNow: now,
    initialState: baseState()
  });
  await settle();

  const listener = harness.events.beforeNavigate.listeners[0];
  listener({
    frameId: 0,
    tabId: 21,
    url: "https://youtube.com/watch?v=one"
  });
  listener({
    frameId: 0,
    tabId: 22,
    url: "https://reddit.com/r/productivity"
  });
  await settle();

  const day = Object.values(harness.state.stats)[0];
  const siteDay = Object.values(harness.state.siteStats)[0];
  assert.equal(day.impulsesPaused, 2);
  assert.equal(siteDay["youtube.com"].impulses, 1);
  assert.equal(siteDay["reddit.com"].impulses, 1);
  assert.equal(harness.state.impulseEvents.length, 2);
});

test("temporary access records protected-site usage when the pass ends", async () => {
  const now = 1_800_000_000_000;
  const harness = createHarness({
    initialNow: now,
    initialState: baseState(),
    tabs: [{ id: 11, url: "https://youtube.com/watch?v=focus" }]
  });
  await settle();

  const allowed = await harness.send({
    type: "ALLOW_SITE",
    host: "youtube.com",
    intention: "Watch the tutorial"
  });
  assert.equal(allowed.endAt, now + 5 * 60_000);
  assert.equal(harness.state.passStarts["youtube.com"], now);
  assert.equal(harness.registeredScripts.size, 1);
  assert.deepEqual(
    Array.from(harness.registeredScripts.values())[0].matches,
    ["*://youtube.com/*", "*://*.youtube.com/*"]
  );

  harness.setNow(now + 2 * 60_000);
  const expired = await harness.send(
    { type: "PASS_EXPIRED", host: "youtube.com", force: true },
    {
      id: "still",
      url: "https://youtube.com/watch?v=focus",
      tab: { id: 11, url: "https://youtube.com/watch?v=focus" }
    }
  );

  assert.equal(expired.ok, true);
  assert.deepEqual(harness.state.passes, {});
  assert.deepEqual(harness.state.passStarts, {});
  assert.equal(harness.registeredScripts.size, 0);
  const siteDay = Object.values(harness.state.siteStats)[0];
  assert.equal(siteDay["youtube.com"].usageSeconds, 120);
});

test("keeps local storage trusted and gives pass countdowns only their matching context", async () => {
  const now = 1_800_000_000_000;
  const harness = createHarness({
    initialNow: now,
    initialState: baseState({
      passes: { "youtube.com": now + 5 * 60_000 },
      passDetails: { "youtube.com": { kind: "task", intention: "Watch a tutorial" } }
    }),
    tabs: [{ id: 11, windowId: 1, url: "https://www.youtube.com/watch?v=focus" }]
  });
  await settle();

  assert.equal(harness.localStorageAccessLevel, "TRUSTED_CONTEXTS");
  const context = await harness.send(
    { type: "GET_PASS_COUNTDOWN" },
    {
      id: "still",
      url: "https://www.youtube.com/watch?v=focus",
      tab: { id: 11, url: "https://www.youtube.com/watch?v=focus" }
    }
  );
  assert.deepEqual(JSON.parse(JSON.stringify(context)), {
    ok: true,
    passHost: "youtube.com",
    endAt: now + 5 * 60_000,
    passDetail: { kind: "task", intention: "Watch a tutorial" },
    site: { host: "youtube.com", label: "YouTube" }
  });

  const unrelated = await harness.send(
    { type: "GET_PASS_COUNTDOWN" },
    {
      id: "still",
      url: "https://example.com/",
      tab: { id: 12, url: "https://example.com/" }
    }
  );
  assert.equal(unrelated.ok, false);
});

test("mindful access expires across every open site tab and starts a non-bypassable cooldown", async () => {
  const now = 1_800_000_000_000;
  const harness = createHarness({
    initialNow: now,
    initialState: baseState(),
    tabs: [
      { id: 11, url: "https://youtube.com/watch?v=one" },
      { id: 12, url: "https://www.youtube.com/watch?v=two" }
    ]
  });
  await settle();

  await harness.send({ type: "ALLOW_SITE", host: "youtube.com" });
  harness.setNow(now + 5 * 60_000);
  await eventsCall(harness.events.alarm, { name: "pass:youtube.com" });

  assert.deepEqual(harness.state.passes, {});
  assert.equal(harness.state.mindfulWindows["youtube.com"].cooldownUntil, now + 30 * 60_000);
  assert.equal(harness.state.mindfulWindows["youtube.com"].taskEligible, true);
  assert.equal(
    harness.updates.filter((update) => update.url.includes("state=pass-expired")).length,
    2
  );
  const retry = await harness.send({ type: "ALLOW_SITE", host: "youtube.com" });
  assert.equal(retry.ok, false);
  assert.equal(retry.reason, "mindful-cooldown");

  await eventsCall(harness.events.beforeNavigate, {
    frameId: 0,
    tabId: 11,
    url: "https://youtube.com/watch?v=again"
  });
  assert.ok(harness.updates.at(-1).url.includes("state=cooldown"));
});

test("a task session is a single intentional exception, not a repeatable pass", async () => {
  const now = 1_800_000_000_000;
  const harness = createHarness({
    initialNow: now,
    initialState: baseState(),
    tabs: [{ id: 11, url: "https://youtube.com/watch?v=one" }]
  });
  await settle();

  await harness.send({ type: "ALLOW_SITE", host: "youtube.com" });
  harness.setNow(now + 5 * 60_000);
  await eventsCall(harness.events.alarm, { name: "pass:youtube.com" });

  const task = await harness.send({
    type: "START_TASK_ACCESS",
    host: "youtube.com",
    minutes: 15,
    intention: "Watch the onboarding tutorial"
  });
  assert.equal(task.ok, true);
  assert.equal(task.endAt, now + 20 * 60_000);
  assert.equal(harness.state.passDetails["youtube.com"].kind, "task");
  assert.equal(harness.state.mindfulWindows["youtube.com"].taskUsed, true);
  harness.setTabUrl(11, "https://youtube.com/watch?v=task");

  const retry = await harness.send({
    type: "START_TASK_ACCESS",
    host: "youtube.com",
    minutes: 15,
    intention: "One more thing"
  });
  assert.equal(retry.ok, false);
  assert.equal(retry.reason, "task-not-available");

  harness.setNow(now + 20 * 60_000);
  await eventsCall(harness.events.alarm, { name: "pass:youtube.com" });
  assert.ok(harness.updates.at(-1).url.includes("state=task-expired"));
});

test("a saved mindful allowance survives restart and retains its one task exception", async () => {
  const now = 1_800_000_000_000;
  const harness = createHarness({
    initialNow: now,
    initialState: baseState({
      mindfulWindows: {
        "youtube.com": {
          startedAt: now - 5 * 60_000,
          cooldownUntil: now + 25 * 60_000,
          taskEligible: true,
          taskUsed: false,
          lastExpiredAt: now - 1
        }
      }
    })
  });
  await settle();

  await eventsCall(harness.events.beforeNavigate, {
    frameId: 0,
    tabId: 11,
    url: "https://youtube.com/watch?v=return"
  });
  const redirect = harness.updates.at(-1).url;
  assert.ok(redirect.includes("state=cooldown"));
  assert.ok(redirect.includes("taskEligible=true"));

  const task = await harness.send({
    type: "START_TASK_ACCESS",
    host: "youtube.com",
    minutes: 30,
    intention: "Review the recorded talk"
  });
  assert.equal(task.ok, true);
  assert.equal(harness.state.mindfulWindows["youtube.com"].taskUsed, true);
});

test("temporary access works during a non-strict focus session", async () => {
  const now = 1_800_000_000_000;
  const harness = createHarness({
    initialNow: now,
    initialState: baseState({ strictFocus: false })
  });
  await settle();
  await harness.send({
    type: "START_FOCUS",
    minutes: 25,
    intention: "Watch the course"
  });

  await eventsCall(harness.events.beforeNavigate, {
    frameId: 0,
    tabId: 23,
    url: "https://youtube.com/watch?v=course"
  });
  assert.equal(harness.updates.length, 1);

  const allowed = await harness.send({
    type: "ALLOW_SITE",
    host: "youtube.com",
    intention: "Course lesson"
  });
  assert.equal(allowed.ok, true);
  assert.equal(harness.registeredScripts.size, 1);

  await eventsCall(harness.events.beforeNavigate, {
    frameId: 0,
    tabId: 24,
    url: "https://youtube.com/watch?v=course"
  });
  assert.equal(harness.updates.length, 1);
});

test("regular focus allows one shared break across all protected sites", async () => {
  const now = 1_800_000_000_000;
  const harness = createHarness({
    initialNow: now,
    initialState: baseState({ strictFocus: false }),
    tabs: [{ id: 23, url: "https://youtube.com/watch?v=course" }]
  });
  await settle();
  await harness.send({ type: "START_FOCUS", minutes: 25, intention: "Finish the course" });

  const firstBreak = await harness.send({ type: "ALLOW_SITE", host: "youtube.com" });
  assert.equal(firstBreak.ok, true);
  assert.equal(harness.state.passDetails["youtube.com"].kind, "focus-break");
  assert.equal(harness.state.focusBreak.host, "youtube.com");
  harness.setTabUrl(23, "https://youtube.com/watch?v=course");

  const anotherSite = await harness.send({ type: "ALLOW_SITE", host: "reddit.com" });
  assert.equal(anotherSite.ok, false);
  assert.equal(anotherSite.reason, "focus-break-used");

  harness.setNow(now + 5 * 60_000);
  await eventsCall(harness.events.alarm, { name: "pass:youtube.com" });
  assert.ok(harness.updates.at(-1).url.includes("state=focus-break-ended"));

  await eventsCall(harness.events.beforeNavigate, {
    frameId: 0,
    tabId: 23,
    url: "https://reddit.com/r/focus"
  });
  assert.ok(harness.updates.at(-1).url.includes("state=focus-break-used"));
});

test("privileged messages reject untrusted senders", async () => {
  const harness = createHarness({
    initialState: baseState()
  });
  await settle();

  const start = await harness.send(
    { type: "START_FOCUS", minutes: 25, intention: "Do work" },
    { id: "still", url: "https://example.com/" }
  );
  assert.equal(start.ok, false);
  assert.equal(start.reason, "invalid-sender");
  assert.equal(harness.state.focus, null);

  const access = await harness.send(
    { type: "ALLOW_SITE", host: "youtube.com" },
    { id: "still", url: "chrome-extension://still/popup.html" }
  );
  assert.equal(access.ok, false);
  assert.equal(access.reason, "invalid-sender");
  assert.deepEqual(harness.state.passes, {});
});

test("duplicate focus-complete alarms record a session only once", async () => {
  const now = 1_800_000_000_000;
  const harness = createHarness({
    initialNow: now,
    initialState: baseState({
      focus: {
        startedAt: now - 25 * 60_000,
        endAt: now,
        minutes: 25,
        intention: "Finish once",
        strict: true,
        protectedSites: clone(defaultSites)
      }
    })
  });
  await settle();

  const alarmListener = harness.events.alarm.listeners[0];
  alarmListener({ name: "focus-complete" });
  alarmListener({ name: "focus-complete" });
  await settle();

  assert.equal(harness.state.focus, null);
  assert.equal(harness.state.focusSessions.length, 1);
  assert.equal(Object.values(harness.state.stats)[0].sessions, 1);
  assert.equal(harness.dynamicRules.size, 0);
});

test("startup migrates storage and prunes history outside retention limits", async () => {
  const now = 1_800_000_000_000;
  const oldDailyAt = now - 600 * 24 * 60 * 60_000;
  const recentDailyAt = now - 30 * 24 * 60 * 60_000;
  const oldRawAt = now - 100 * 24 * 60 * 60_000;
  const recentRawAt = now - 10 * 24 * 60 * 60_000;
  const oldDay = new Date(oldDailyAt).toLocaleDateString("en-CA");
  const recentDay = new Date(recentDailyAt).toLocaleDateString("en-CA");
  const harness = createHarness({
    initialNow: now,
    initialState: baseState({
      stats: {
        [oldDay]: { impulsesPaused: 4 },
        [recentDay]: { impulsesPaused: 2 }
      },
      siteStats: {
        [oldDay]: { "youtube.com": { impulses: 4, usageSeconds: 20 } },
        [recentDay]: { "youtube.com": { impulses: 2, usageSeconds: 10 } }
      },
      usageStats: {
        [oldDay]: { "youtube.com": { usageSeconds: 400 } },
        [recentDay]: { "reddit.com": { usageSeconds: 200 } }
      },
      usageEvents: [
        {
          host: "youtube.com",
          startedAt: oldRawAt - 1000,
          endedAt: oldRawAt,
          usageSeconds: 1
        },
        {
          host: "reddit.com",
          startedAt: recentRawAt - 2000,
          endedAt: recentRawAt,
          usageSeconds: 2
        }
      ],
      impulseEvents: [
        { host: "youtube.com", createdAt: oldRawAt },
        { host: "reddit.com", createdAt: recentRawAt }
      ],
      focusSessions: [
        { startedAt: oldDailyAt, focusedSeconds: 1200 },
        { startedAt: recentDailyAt, focusedSeconds: 1200 }
      ],
      focusExits: [
        { createdAt: oldRawAt, reason: "Old" },
        { createdAt: recentRawAt, reason: "Recent" }
      ]
    })
  });
  await settle();

  assert.equal(harness.state.storageSchemaVersion, 3);
  assert.deepEqual(Object.keys(harness.state.stats), [recentDay]);
  assert.deepEqual(Object.keys(harness.state.siteStats), [recentDay]);
  assert.deepEqual(Object.keys(harness.state.usageStats), [recentDay]);
  assert.equal(harness.state.usageEvents.length, 1);
  assert.equal(harness.state.usageEvents[0].host, "reddit.com");
  assert.deepEqual(harness.state.impulseEvents, [
    { host: "reddit.com", createdAt: recentRawAt }
  ]);
  assert.equal(harness.state.focusSessions.length, 1);
  assert.equal(harness.state.focusSessions[0].startedAt, recentDailyAt);
  assert.equal(harness.state.focusExits.length, 1);
  assert.equal(harness.state.focusExits[0].createdAt, recentRawAt);
});

test("active-tab usage follows tab switches and stops when the active tab is removed", async () => {
  const now = 1_800_000_000_000;
  const day = new Date(now).toLocaleDateString("en-CA");
  const harness = createHarness({
    initialNow: now,
    initialState: baseState(),
    tabs: [
      {
        id: 1,
        windowId: 1,
        active: true,
        url: "https://www.youtube.com/watch?v=private"
      },
      {
        id: 2,
        windowId: 1,
        active: false,
        url: "https://reddit.com/r/private"
      }
    ]
  });
  await settle();

  harness.setNow(now + 10_000);
  harness.activateTab(2);
  await eventsCall(harness.events.tabActivated, {
    tabId: 2,
    windowId: 1
  });

  assert.equal(
    harness.state.usageStats[day]["youtube.com"].usageSeconds,
    10
  );
  assert.deepEqual(harness.state.usageEvents[0], {
    host: "youtube.com",
    startedAt: now,
    endedAt: now + 10_000,
    usageSeconds: 10
  });
  assert.equal(harness.state.usageTracker.host, "reddit.com");

  harness.setNow(now + 30_000);
  harness.removeTab(2);
  await eventsCall(harness.events.tabRemoved, 2, {
    windowId: 1,
    isWindowClosing: false
  });
  assert.equal(harness.state.usageStats[day]["reddit.com"].usageSeconds, 20);
  assert.equal(harness.state.usageTracker, null);
});

test("active-tab usage pauses while Chrome is unfocused or the user is idle", async () => {
  const now = 1_800_000_000_000;
  const day = new Date(now).toLocaleDateString("en-CA");
  const harness = createHarness({
    initialNow: now,
    initialState: baseState(),
    tabs: [
      {
        id: 1,
        windowId: 1,
        active: true,
        url: "https://youtube.com/"
      }
    ]
  });
  await settle();

  harness.setNow(now + 12_000);
  harness.setFocusedWindowId(-1);
  await eventsCall(harness.events.windowFocusChanged, -1);
  harness.setNow(now + 42_000);
  harness.setFocusedWindowId(1);
  await eventsCall(harness.events.windowFocusChanged, 1);
  harness.setNow(now + 50_000);
  harness.setIdleState("idle");
  await eventsCall(harness.events.idleStateChanged, "idle");
  harness.setNow(now + 80_000);
  harness.setIdleState("active");
  await eventsCall(harness.events.idleStateChanged, "active");
  harness.setNow(now + 85_000);
  harness.setFocusedWindowId(-1);
  await eventsCall(harness.events.windowFocusChanged, -1);

  assert.equal(harness.state.usageStats[day]["youtube.com"].usageSeconds, 25);
  assert.equal(harness.state.usageEvents.length, 3);
});

test("URL changes close the previous domain without storing paths or unsupported schemes", async () => {
  const now = 1_800_000_000_000;
  const day = new Date(now).toLocaleDateString("en-CA");
  const harness = createHarness({
    initialNow: now,
    initialState: baseState(),
    tabs: [
      {
        id: 1,
        windowId: 1,
        active: true,
        url: "https://www.youtube.com/watch?v=sensitive"
      }
    ]
  });
  await settle();

  harness.setNow(now + 7_000);
  harness.setTabUrl(1, "https://www.reddit.com/r/sensitive");
  await eventsCall(
    harness.events.tabUpdated,
    1,
    { url: "https://www.reddit.com/r/sensitive" },
    {}
  );
  harness.setNow(now + 15_000);
  harness.setTabUrl(1, "chrome://settings/privacy");
  await eventsCall(
    harness.events.tabUpdated,
    1,
    { url: "chrome://settings/privacy" },
    {}
  );

  assert.equal(harness.state.usageStats[day]["youtube.com"].usageSeconds, 7);
  assert.equal(harness.state.usageStats[day]["reddit.com"].usageSeconds, 8);
  assert.equal(harness.state.usageTracker, null);
  assert.deepEqual(
    harness.state.usageEvents.map((event) => event.host),
    ["reddit.com", "youtube.com"]
  );
  assert.equal(
    JSON.stringify({
      usageStats: harness.state.usageStats,
      usageEvents: harness.state.usageEvents
    }).includes("sensitive"),
    false
  );
});

test("heartbeat checkpoints survive restart and cap unexplained elapsed gaps", async () => {
  const now = 1_800_000_000_000;
  const day = new Date(now).toLocaleDateString("en-CA");
  const tab = {
    id: 1,
    windowId: 1,
    active: true,
    url: "https://youtube.com/"
  };
  const first = createHarness({
    initialNow: now,
    initialState: baseState(),
    tabs: [tab]
  });
  await settle();
  assert.equal(first.alarms.get("usage-heartbeat").periodInMinutes, 1);

  first.setNow(now + 60_000);
  await eventsCall(first.events.alarm, { name: "usage-heartbeat" });
  assert.equal(first.state.usageStats[day]["youtube.com"].usageSeconds, 60);

  const restarted = createHarness({
    initialNow: now + 120_000,
    initialState: clone(first.state),
    tabs: [tab]
  });
  await settle();
  assert.equal(
    restarted.state.usageStats[day]["youtube.com"].usageSeconds,
    120
  );

  restarted.setNow(now + 12 * 60_000);
  await eventsCall(restarted.events.alarm, { name: "usage-heartbeat" });
  assert.equal(
    restarted.state.usageStats[day]["youtube.com"].usageSeconds,
    420
  );
});

test("unsupported active-tab schemes never create usage records", async () => {
  const now = 1_800_000_000_000;
  const harness = createHarness({
    initialNow: now,
    initialState: baseState(),
    tabs: [
      {
        id: 1,
        windowId: 1,
        active: true,
        url: "file:///Users/person/private.txt"
      }
    ]
  });
  await settle();
  harness.setNow(now + 60_000);
  await eventsCall(harness.events.alarm, { name: "usage-heartbeat" });

  assert.deepEqual(harness.state.usageStats, {});
  assert.deepEqual(harness.state.usageEvents, []);
  assert.equal(harness.state.usageTracker, null);
});

test("active-tab measurement can be paused and resumed from settings", async () => {
  const now = 1_800_000_000_000;
  const day = new Date(now).toLocaleDateString("en-CA");
  const harness = createHarness({
    initialNow: now,
    initialState: baseState({ usageTrackingEnabled: true }),
    tabs: [
      {
        id: 1,
        windowId: 1,
        active: true,
        url: "https://youtube.com/watch?v=private"
      }
    ]
  });
  await settle();

  harness.setNow(now + 15_000);
  harness.state.usageTrackingEnabled = false;
  await eventsCall(
    harness.events.storageChanged,
    {
      usageTrackingEnabled: {
        oldValue: true,
        newValue: false
      }
    },
    "local"
  );
  assert.equal(harness.state.usageStats[day]["youtube.com"].usageSeconds, 15);
  assert.equal(harness.state.usageTracker, null);

  harness.setNow(now + 75_000);
  await eventsCall(harness.events.alarm, { name: "usage-heartbeat" });
  assert.equal(harness.state.usageStats[day]["youtube.com"].usageSeconds, 15);

  harness.state.usageTrackingEnabled = true;
  await eventsCall(
    harness.events.storageChanged,
    {
      usageTrackingEnabled: {
        oldValue: false,
        newValue: true
      }
    },
    "local"
  );
  harness.setNow(now + 85_000);
  await eventsCall(harness.events.alarm, { name: "usage-heartbeat" });
  assert.equal(harness.state.usageStats[day]["youtube.com"].usageSeconds, 25);
});

test("an automatic strict routine starts only the remaining scheduled time", async () => {
  const now = localTimestamp(2027, 0, 4, 9, 30);
  const harness = createHarness({
    initialNow: now,
    initialState: baseState({ routines: [routine()] })
  });
  await settle();
  await settle();

  assert.equal(harness.state.focus.source, "routine");
  assert.equal(harness.state.focus.routineId, "deep-work");
  assert.equal(harness.state.focus.startedAt, now);
  assert.equal(harness.state.focus.endAt, localTimestamp(2027, 0, 4, 11, 0));
  assert.deepEqual(
    Array.from(harness.state.focus.protectedSites, (site) => site.host),
    ["youtube.com", "reddit.com"]
  );
});

test("ask-first routines notify without starting and Start now uses the scheduled end", async () => {
  const startAt = localTimestamp(2027, 0, 4, 9, 0);
  const now = localTimestamp(2027, 0, 4, 8, 55);
  const harness = createHarness({
    initialNow: now,
    initialState: baseState({
      routines: [routine({ startBehavior: "ask" })]
    })
  });
  await settle();

  const notificationId = `routine:start:deep-work:${startAt}`;
  await eventsCall(harness.events.alarm, {
    name: `routine:pre:deep-work:${startAt}`
  });
  assert.equal(harness.state.focus, null);
  assert.equal(harness.notifications.has(notificationId), true);

  await eventsCall(harness.events.notificationButtonClicked, notificationId, 0);
  assert.equal(harness.state.focus.source, "routine");
  assert.equal(harness.state.focus.startedAt, now);
  assert.equal(harness.state.focus.endAt, localTimestamp(2027, 0, 4, 11, 0));
});

test("Skip today suppresses the occurrence but preserves future routines", async () => {
  const startAt = localTimestamp(2027, 0, 4, 9, 0);
  const now = localTimestamp(2027, 0, 4, 8, 55);
  const harness = createHarness({
    initialNow: now,
    initialState: baseState({ routines: [routine()] })
  });
  await settle();
  const notificationId = `routine:start:deep-work:${startAt}`;
  await eventsCall(harness.events.alarm, {
    name: `routine:pre:deep-work:${startAt}`
  });
  await eventsCall(harness.events.notificationButtonClicked, notificationId, 1);
  harness.setNow(startAt);
  await eventsCall(harness.events.alarm, {
    name: `routine:start:deep-work:${startAt}`
  });

  assert.equal(harness.state.focus, null);
  assert.equal(harness.state.routineSkips[`deep-work:${startAt}`], true);
  assert.equal(harness.state.routines[0].enabled, true);
});

test("an automatic routine never replaces an active manual focus session", async () => {
  const now = localTimestamp(2027, 0, 4, 9, 30);
  const manualFocus = {
    startedAt: now - 10 * 60_000,
    endAt: now + 20 * 60_000,
    minutes: 30,
    intention: "Manual work",
    strict: true,
    source: "manual",
    protectedSites: [{ host: "youtube.com", label: "YouTube" }]
  };
  const harness = createHarness({
    initialNow: now,
    initialState: baseState({
      focus: manualFocus,
      routines: [routine()]
    })
  });
  await settle();
  await settle();

  assert.equal(harness.state.focus.intention, "Manual work");
  assert.equal(harness.state.focus.source, "manual");
  assert.equal(harness.state.focus.routineId, undefined);
});

test("a mindful routine protects its selected sites even when global pauses are off", async () => {
  const now = localTimestamp(2027, 0, 4, 9, 30);
  const startAt = localTimestamp(2027, 0, 4, 9, 0);
  const harness = createHarness({
    initialNow: now,
    initialState: baseState({
      mindfulMode: false,
      routines: [
        routine({
          mode: "mindful",
          siteHosts: ["reddit.com"]
        })
      ]
    })
  });
  await settle();
  await settle();

  assert.equal(harness.state.focus, null);
  assert.equal(harness.state.activeRoutine.routineId, "deep-work");
  await eventsCall(harness.events.beforeNavigate, {
    frameId: 0,
    tabId: 14,
    url: "https://reddit.com/r/productivity"
  });
  assert.equal(harness.updates.length, 1);

  harness.setNow(localTimestamp(2027, 0, 4, 11, 0));
  await eventsCall(harness.events.alarm, {
    name: `routine:end:deep-work:${startAt}`
  });
  assert.equal(harness.state.activeRoutine, null);
});

test("emergency exit from an automatic routine skips only its current occurrence", async () => {
  const now = localTimestamp(2027, 0, 4, 9, 30);
  const startAt = localTimestamp(2027, 0, 4, 9, 0);
  const harness = createHarness({
    initialNow: now,
    initialState: baseState({ routines: [routine()] })
  });
  await settle();
  await settle();
  assert.equal(harness.state.focus.source, "routine");

  const stopped = await harness.send({
    type: "STOP_FOCUS",
    emergency: true,
    confirmed: true,
    reason: "Urgent interruption"
  });
  await settle();

  assert.equal(stopped.ok, true);
  assert.equal(harness.state.focus, null);
  assert.equal(harness.state.routineSkips[`deep-work:${startAt}`], true);
  assert.equal(harness.state.routines[0].enabled, true);
});

test("one-click organisation groups related tabs, supports undo, and keeps a link trail together", async () => {
  const harness = createHarness({
    initialState: baseState(),
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, groupId: -1, url: "https://news.ycombinator.com/", title: "Hacker News" },
      { id: 2, windowId: 1, index: 1, groupId: -1, url: "chrome://newtab/", pendingUrl: "https://arxiv.org/abs/123", title: "A paper" },
      { id: 3, windowId: 1, index: 2, groupId: -1, url: "https://reddit.com/r/webdev", title: "Web development" },
      { id: 4, windowId: 1, index: 3, groupId: -1, url: "https://www.reddit.com/r/javascript", title: "JavaScript" }
    ]
  });
  await settle();

  const organised = await harness.send({ type: "ORGANIZE_TABS" });
  assert.equal(organised.ok, true);
  assert.equal(organised.groups.length, 1);
  assert.equal(harness.tabs.find((tab) => tab.id === 3).groupId, harness.tabs.find((tab) => tab.id === 4).groupId);
  assert.equal(harness.tabGroups.get(1).title, "Reddit");
  assert.equal(harness.tabGroups.get(1).collapsed, true);
  assert.deepEqual(harness.tabGroupMoves[0], { groupId: 1, index: 0 });

  const undone = await harness.send({ type: "UNDO_TAB_ORGANIZATION" });
  assert.equal(undone.ok, true);
  assert.equal(harness.tabs.find((tab) => tab.id === 3).groupId, -1);
  assert.equal(harness.tabs.find((tab) => tab.id === 4).groupId, -1);

  await eventsCall(harness.events.createdNavigationTarget, {
    sourceTabId: 1,
    tabId: 2
  });
  assert.equal(harness.tabs.find((tab) => tab.id === 1).groupId, harness.tabs.find((tab) => tab.id === 2).groupId);
  assert.equal(harness.tabGroups.get(2).title, "🔗 News");
  assert.equal(harness.tabGroups.get(2).collapsed, false);
  assert.deepEqual(harness.tabGroupMoves, [{ groupId: 1, index: 0 }]);

  harness.removeTab(2);
  await eventsCall(harness.events.tabRemoved, 2, { windowId: 1 });
  assert.equal(harness.tabs.find((tab) => tab.id === 1).groupId, -1);
});

test("keeps the active tab's new bulk group open for orientation", async () => {
  const harness = createHarness({
    initialState: baseState(),
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, groupId: -1, url: "https://reddit.com/r/webdev", title: "Web development" },
      { id: 2, windowId: 1, index: 1, active: false, groupId: -1, url: "https://www.reddit.com/r/javascript", title: "JavaScript" },
      { id: 3, windowId: 1, index: 2, active: false, groupId: -1, url: "https://example.com/", title: "Unrelated" }
    ]
  });
  await settle();

  const organised = await harness.send({ type: "ORGANIZE_TABS" });
  assert.equal(organised.ok, true);
  assert.equal(organised.groups.length, 1);
  assert.equal(harness.tabGroups.get(1).collapsed, false);
});

test("organize tabs consolidates duplicate group names and undo restores them", async () => {
  const harness = createHarness({
    initialState: baseState(),
    initialSessionState: {
      tabOrganizerState: {
        managedGroups: {
          12: {
            windowId: 1,
            kind: "bulk",
            autoName: "Project Alpha",
            manualName: false,
            color: "blue"
          },
          3: {
            windowId: 1,
            kind: "bulk",
            autoName: "Project Alpha",
            manualName: true,
            color: "red"
          }
        }
      }
    },
    tabs: [
      { id: 1, windowId: 1, index: 0, active: false, groupId: 12, url: "https://example.com/one", title: "One" },
      { id: 2, windowId: 1, index: 1, active: false, groupId: 12, url: "https://example.com/two", title: "Two" },
      { id: 3, windowId: 1, index: 2, active: true, groupId: 3, url: "https://another.test/one", title: "Three" },
      { id: 4, windowId: 1, index: 3, active: false, groupId: 3, url: "https://another.test/two", title: "Four" }
    ]
  });
  harness.tabGroups.set(12, {
    id: 12,
    windowId: 1,
    title: "Project Alpha",
    color: "blue",
    collapsed: false
  });
  harness.tabGroups.set(3, {
    id: 3,
    windowId: 1,
    title: "Project Alpha",
    color: "red",
    collapsed: true
  });
  await settle();

  const organised = await harness.send({ type: "ORGANIZE_TABS" });

  assert.equal(organised.ok, true);
  assert.deepEqual(Array.from(organised.mergedGroups), [12]);
  assert.deepEqual(harness.tabs.filter((tab) => tab.groupId === 12).map((tab) => tab.id), [1, 2, 3, 4]);
  assert.equal(harness.tabGroups.has(3), false);
  assert.equal(harness.tabGroups.get(12).title, "Project Alpha");

  const undone = await harness.send({ type: "UNDO_TAB_ORGANIZATION" });
  assert.equal(undone.ok, true);
  assert.deepEqual(harness.tabs.filter((tab) => tab.groupId === 12).map((tab) => tab.id), [1, 2]);
  const restoredGroup = Array.from(harness.tabGroups.values()).find(
    (group) => group.id !== 12 && group.title === "Project Alpha"
  );
  assert.ok(restoredGroup);
  assert.equal(restoredGroup.color, "red");
  assert.equal(restoredGroup.collapsed, true);
  assert.deepEqual(harness.tabs.filter((tab) => tab.groupId === restoredGroup.id).map((tab) => tab.id), [3, 4]);
});

test("adds matching ungrouped tabs to an unchanged existing group and undoes only the additions", async () => {
  const harness = createHarness({
    initialState: baseState(),
    tabs: [
      { id: 1, windowId: 1, index: 0, active: false, groupId: 7, url: "https://github.com/openai", title: "GitHub" },
      { id: 2, windowId: 1, index: 1, active: false, groupId: 7, url: "https://github.com/openai/still", title: "Still" },
      { id: 3, windowId: 1, index: 2, active: true, groupId: -1, url: "https://github.com/openai/docs", title: "Docs" },
      { id: 4, windowId: 1, index: 3, active: false, groupId: -1, url: "https://github.com/openai/issues", title: "Issues" }
    ]
  });
  harness.tabGroups.set(7, { id: 7, windowId: 1, title: "GitHub", color: "blue", collapsed: true });
  await settle();

  const organised = await harness.send({ type: "ORGANIZE_TABS" });
  assert.equal(organised.ok, true);
  assert.deepEqual(Array.from(organised.mergedGroups), [7]);
  assert.deepEqual(harness.tabGroupMoves, []);
  assert.deepEqual(harness.tabs.filter((tab) => tab.groupId === 7).map((tab) => tab.id), [1, 2, 3, 4]);
  assert.equal(harness.tabGroups.get(7).title, "GitHub");

  const undone = await harness.send({ type: "UNDO_TAB_ORGANIZATION" });
  assert.equal(undone.ok, true);
  assert.deepEqual(harness.tabs.filter((tab) => tab.groupId === 7).map((tab) => tab.id), [1, 2]);
  assert.deepEqual(harness.tabs.filter((tab) => tab.groupId === -1).map((tab) => tab.id), [3, 4]);
});

test("merges a single exact-match tab into an unchanged existing group", async () => {
  const harness = createHarness({
    initialState: baseState(),
    tabs: [
      { id: 1, windowId: 1, index: 0, active: false, groupId: 7, url: "https://github.com/openai", title: "GitHub" },
      { id: 2, windowId: 1, index: 1, active: true, groupId: -1, url: "https://github.com/openai/docs", title: "Docs" },
      { id: 3, windowId: 1, index: 2, active: false, groupId: -1, url: "https://example.com/", title: "Unrelated" }
    ]
  });
  harness.tabGroups.set(7, { id: 7, windowId: 1, title: "GitHub", color: "blue", collapsed: true });
  await settle();

  const organised = await harness.send({ type: "ORGANIZE_TABS" });
  assert.equal(organised.ok, true);
  assert.deepEqual(Array.from(organised.mergedGroups), [7]);
  assert.equal(harness.tabs.find((tab) => tab.id === 2).groupId, 7);
  assert.equal(harness.tabs.find((tab) => tab.id === 3).groupId, -1);
});

test("new emoji category names still merge into a legacy automatic category group", async () => {
  const harness = createHarness({
    initialState: baseState(),
    tabs: [
      { id: 1, windowId: 1, index: 0, active: false, groupId: 7, url: "https://x.com/home", title: "X" },
      { id: 2, windowId: 1, index: 1, active: false, groupId: 7, url: "https://reddit.com/", title: "Reddit" },
      { id: 3, windowId: 1, index: 2, active: true, groupId: -1, url: "https://facebook.com/", title: "Facebook" },
      { id: 4, windowId: 1, index: 3, active: false, groupId: -1, url: "https://instagram.com/", title: "Instagram" }
    ]
  });
  harness.tabGroups.set(7, { id: 7, windowId: 1, title: "Social", color: "blue", collapsed: true });
  await settle();

  const organised = await harness.send({ type: "ORGANIZE_TABS" });

  assert.equal(organised.ok, true);
  assert.deepEqual(Array.from(organised.mergedGroups), [7]);
  assert.deepEqual(harness.tabs.filter((tab) => tab.groupId === 7).map((tab) => tab.id), [1, 2, 3, 4]);
  assert.equal(harness.tabGroups.get(7).title, "Social");
});

test("merges same-domain tabs into an unchanged linked group and undoes only the additions", async () => {
  const harness = createHarness({
    initialState: baseState(),
    initialSessionState: {
      tabOrganizerState: {
        managedGroups: {
          8: {
            windowId: 1,
            kind: "linkTrail",
            sourceHost: "economictimes.indiatimes.com",
            autoName: "🔗 Economictimes",
            manualName: false,
            color: "green"
          }
        }
      }
    },
    tabs: [
      { id: 1, windowId: 1, index: 0, active: false, groupId: 8, url: "https://economictimes.indiatimes.com/", title: "Business News" },
      { id: 2, windowId: 1, index: 1, active: false, groupId: 8, url: "https://economictimes.indiatimes.com/news/markets", title: "Markets" },
      { id: 3, windowId: 1, index: 2, active: true, groupId: -1, url: "https://economictimes.indiatimes.com/news/defence", title: "Defence" },
      { id: 4, windowId: 1, index: 3, active: false, groupId: -1, url: "https://www.economictimes.indiatimes.com/news/politics", title: "Politics" },
      { id: 5, windowId: 1, index: 4, active: false, groupId: -1, url: "https://reddit.com/r/news", title: "Reddit" },
      { id: 6, windowId: 1, index: 5, active: false, groupId: -1, url: "https://www.reddit.com/r/worldnews", title: "World news" }
    ]
  });
  harness.tabGroups.set(8, {
    id: 8,
    windowId: 1,
    title: "🔗 Economictimes",
    color: "green",
    collapsed: true
  });
  await settle();

  const organised = await harness.send({ type: "ORGANIZE_TABS" });
  assert.equal(organised.ok, true);
  assert.deepEqual(Array.from(organised.mergedGroups), [8]);
  assert.deepEqual(harness.tabs.filter((tab) => tab.groupId === 8).map((tab) => tab.id), [1, 2, 3, 4]);
  assert.deepEqual(harness.tabs.filter((tab) => tab.groupId === 1).map((tab) => tab.id), [5, 6]);
  assert.equal(harness.tabGroups.get(8).title, "🔗 Economictimes");
  assert.equal(harness.tabGroups.get(8).collapsed, true);

  const undone = await harness.send({ type: "UNDO_TAB_ORGANIZATION" });
  assert.equal(undone.ok, true);
  assert.deepEqual(harness.tabs.filter((tab) => tab.groupId === 8).map((tab) => tab.id), [1, 2]);
  assert.deepEqual(harness.tabs.filter((tab) => tab.groupId === -1).map((tab) => tab.id), [3, 4, 5, 6]);
});

test("does not merge into a manually renamed linked group", async () => {
  const harness = createHarness({
    initialState: baseState(),
    initialSessionState: {
      tabOrganizerState: {
        managedGroups: {
          8: {
            windowId: 1,
            kind: "linkTrail",
            sourceHost: "economictimes.indiatimes.com",
            autoName: "Reading",
            manualName: true,
            color: "green"
          }
        }
      }
    },
    tabs: [
      { id: 1, windowId: 1, index: 0, active: false, groupId: 8, url: "https://economictimes.indiatimes.com/", title: "Business News" },
      { id: 2, windowId: 1, index: 1, active: true, groupId: -1, url: "https://economictimes.indiatimes.com/news/markets", title: "Markets" },
      { id: 3, windowId: 1, index: 2, active: false, groupId: -1, url: "https://economictimes.indiatimes.com/news/defence", title: "Defence" }
    ]
  });
  harness.tabGroups.set(8, {
    id: 8,
    windowId: 1,
    title: "Reading",
    color: "green",
    collapsed: false
  });
  await settle();

  const organised = await harness.send({ type: "ORGANIZE_TABS" });
  assert.equal(organised.ok, true);
  assert.deepEqual(Array.from(organised.mergedGroups), []);
  assert.deepEqual(harness.tabs.filter((tab) => tab.groupId === 8).map((tab) => tab.id), [1]);
  assert.deepEqual(harness.tabs.filter((tab) => tab.groupId === 1).map((tab) => tab.id), [2, 3]);
  assert.equal(harness.tabGroups.get(8).title, "Reading");
});

test("leaves a renamed existing group alone and creates a separate matching group", async () => {
  const harness = createHarness({
    initialState: baseState(),
    tabs: [
      { id: 1, windowId: 1, index: 0, active: false, groupId: 7, url: "https://github.com/openai", title: "GitHub" },
      { id: 2, windowId: 1, index: 1, active: true, groupId: -1, url: "https://github.com/openai/docs", title: "Docs" },
      { id: 3, windowId: 1, index: 2, active: false, groupId: -1, url: "https://github.com/openai/issues", title: "Issues" }
    ]
  });
  harness.tabGroups.set(7, { id: 7, windowId: 1, title: "My project", color: "blue", collapsed: false });
  await settle();

  const organised = await harness.send({ type: "ORGANIZE_TABS" });
  assert.equal(organised.ok, true);
  assert.deepEqual(Array.from(organised.mergedGroups), []);
  assert.equal(organised.groups.length, 1);
  assert.equal(harness.tabs.find((tab) => tab.id === 1).groupId, 7);
  assert.equal(harness.tabs.find((tab) => tab.id === 2).groupId, 1);
  assert.equal(harness.tabs.find((tab) => tab.id === 3).groupId, 1);
  assert.equal(harness.tabGroups.get(7).title, "My project");
});

test("an exact group-name match merges even when the user named the group", async () => {
  const harness = createHarness({
    initialState: baseState(),
    initialSessionState: {
      tabOrganizerState: {
        managedGroups: {
          7: {
            windowId: 1,
            kind: "bulk",
            autoName: "GitHub",
            manualName: true,
            color: "blue"
          }
        }
      }
    },
    tabs: [
      { id: 1, windowId: 1, index: 0, active: false, groupId: 7, url: "https://github.com/openai", title: "GitHub" },
      { id: 2, windowId: 1, index: 1, active: true, groupId: -1, url: "https://github.com/openai/docs", title: "Docs" },
      { id: 3, windowId: 1, index: 2, active: false, groupId: -1, url: "https://github.com/openai/issues", title: "Issues" }
    ]
  });
  harness.tabGroups.set(7, { id: 7, windowId: 1, title: "GitHub", color: "blue", collapsed: false });
  await settle();

  const organised = await harness.send({ type: "ORGANIZE_TABS" });
  assert.equal(organised.ok, true);
  assert.deepEqual(Array.from(organised.mergedGroups), [7]);
  assert.equal(harness.tabs.find((tab) => tab.id === 1).groupId, 7);
  assert.equal(harness.tabs.find((tab) => tab.id === 2).groupId, 7);
  assert.equal(harness.tabs.find((tab) => tab.id === 3).groupId, 7);
});

test("bulk organization inserts after existing groups instead of after ordinary tabs", async () => {
  const harness = createHarness({
    initialState: baseState(),
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, groupId: 7, url: "https://github.com/openai", title: "GitHub" },
      { id: 2, windowId: 1, index: 1, groupId: 7, url: "https://github.com/openai/still", title: "Still" },
      { id: 3, windowId: 1, index: 2, groupId: -1, url: "https://x.com/", title: "X" },
      { id: 4, windowId: 1, index: 3, groupId: -1, url: "https://reddit.com/", title: "Reddit" },
      { id: 5, windowId: 1, index: 4, groupId: -1, url: "https://example.com/", title: "Unrelated" }
    ]
  });
  await settle();

  const organised = await harness.send({ type: "ORGANIZE_TABS" });
  assert.equal(organised.ok, true);
  assert.deepEqual(harness.tabGroupMoves, [{ groupId: 1, index: 2 }]);
});

test("tab organizer status adapts its crowding signal to the current window width", async () => {
  const crowdedTabs = Array.from({ length: 18 }, (_, index) => ({
    id: index + 1,
    windowId: 1,
    index,
    active: index === 0,
    groupId: -1,
    url: `https://example${index}.com/`,
    title: `Example ${index}`
  }));
  const laptop = createHarness({
    initialState: baseState(),
    tabs: crowdedTabs,
    windowWidth: 1440
  });
  await settle();
  const laptopStatus = await laptop.send({ type: "GET_TAB_ORGANIZER_STATUS" });
  assert.equal(laptopStatus.crowding.isCrowded, true);
  assert.equal(laptopStatus.crowding.estimatedTabWidth, 68);

  const widescreen = createHarness({
    initialState: baseState(),
    tabs: crowdedTabs,
    windowWidth: 2400
  });
  await settle();
  const widescreenStatus = await widescreen.send({ type: "GET_TAB_ORGANIZER_STATUS" });
  assert.equal(widescreenStatus.crowding.isCrowded, false);
  assert.equal(widescreenStatus.crowding.estimatedTabWidth, 121);
});

test("disabled link-trail grouping leaves newly opened tabs in place", async () => {
  const harness = createHarness({
    initialState: baseState({ linkTrailGroupingEnabled: false }),
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: -1, url: "https://example.com/", title: "Example" },
      { id: 2, windowId: 1, index: 1, groupId: -1, url: "https://example.org/story", title: "Story" }
    ]
  });
  await settle();

  await eventsCall(harness.events.createdNavigationTarget, {
    sourceTabId: 1,
    tabId: 2
  });

  assert.equal(harness.tabs.find((tab) => tab.id === 1).groupId, -1);
  assert.equal(harness.tabs.find((tab) => tab.id === 2).groupId, -1);
  assert.equal(harness.tabGroups.size, 0);
});

test("a nested link group uses AI names as tabs are added and removed, then dissolves at one tab", async () => {
  const responses = ["Climate policy", "Election policy", "Climate policy"];
  const requests = [];
  const harness = createHarness({
    initialState: baseState({
      aiConnections: [{
        id: "fireworks-1",
        provider: "compatible",
        label: "Fireworks",
        model: "accounts/fireworks/models/test-model",
        endpoint: "https://api.fireworks.ai/inference/v1/chat/completions"
      }],
      activeAIConnectionId: "fireworks-1",
      aiConnectionSecrets: { "fireworks-1": "test-key" }
    }),
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, groupId: -1, url: "https://example.com/climate", title: "Climate policy overview" },
      { id: 2, windowId: 1, index: 1, groupId: -1, url: "https://news.example.org/emissions", title: "New emissions proposal" },
      { id: 3, windowId: 1, index: 2, groupId: -1, url: "https://journal.example.net/election", title: "Election policy debate" }
    ],
    async fetchImpl(url, options) {
      requests.push({ url, body: JSON.parse(options.body) });
      const title = responses.shift();
      return {
        ok: true,
        async json() {
          return {
            choices: [{
              message: { content: JSON.stringify({ groups: [{ groupId: 1, title }] }) }
            }]
          };
        }
      };
    }
  });
  await settle();

  await eventsCall(harness.events.createdNavigationTarget, { sourceTabId: 1, tabId: 2 });
  await eventsCall(harness.events.tabUpdated, 2, { title: "New emissions proposal" }, harness.tabs.find((tab) => tab.id === 2));
  await eventsCall(harness.events.tabUpdated, 2, { status: "complete" }, harness.tabs.find((tab) => tab.id === 2));
  assert.equal(requests.length, 0);
  await harness.runTimers();
  assert.equal(harness.tabGroups.get(1).title, "Climate policy");
  assert.equal(harness.tabGroups.get(1).collapsed, false);
  assert.deepEqual(harness.tabGroupMoves, []);
  await eventsCall(harness.events.tabUpdated, 2, { groupId: 1 }, harness.tabs.find((tab) => tab.id === 2));
  await harness.runTimers();
  assert.equal(harness.tabGroups.get(1).title, "Climate policy");
  assert.equal(requests.length, 1);

  await eventsCall(harness.events.createdNavigationTarget, { sourceTabId: 1, tabId: 3 });
  await harness.runTimers();
  assert.equal(harness.tabGroups.get(1).title, "Election policy");

  harness.removeTab(3);
  await eventsCall(harness.events.tabRemoved, 3, { windowId: 1, groupId: 1 });
  assert.equal(requests.length, 2);
  await harness.runTimers();
  assert.equal(harness.tabGroups.get(1).title, "Climate policy");
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.url.includes("api.fireworks.ai")));
  assert.ok(requests.every((request) => request.body.reasoning_effort === "none"));
  assert.ok(requests.every((request) => !request.body.messages[0].content.includes("https://")));

  harness.removeTab(2);
  await eventsCall(harness.events.tabRemoved, 2, { windowId: 1, groupId: 1 });
  assert.equal(harness.tabs.find((tab) => tab.id === 1).groupId, -1);
  assert.equal(requests.length, 3);
});

test("a same-site link trail keeps its local name and never calls AI", async () => {
  let requests = 0;
  const harness = createHarness({
    initialState: baseState({
      aiConnections: [{
        id: "remote-1",
        provider: "compatible",
        label: "Remote model",
        model: "test-model",
        endpoint: "https://models.example.net/v1/chat/completions"
      }],
      activeAIConnectionId: "remote-1",
      aiConnectionSecrets: { "remote-1": "test-key" }
    }),
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: -1, url: "https://example.com/news/one", title: "Story one" },
      { id: 2, windowId: 1, index: 1, groupId: -1, url: "https://www.example.com/news/two", title: "Story two" },
      { id: 3, windowId: 1, index: 2, groupId: -1, url: "https://example.com/news/three", title: "Story three" }
    ],
    async fetchImpl() {
      requests += 1;
      throw new Error("AI should not be called for one website");
    }
  });
  await settle();

  await eventsCall(harness.events.createdNavigationTarget, { sourceTabId: 1, tabId: 2 });
  await harness.runTimers();
  assert.equal(harness.tabGroups.get(1).title, "🔗 Example");
  assert.equal(requests, 0);

  await eventsCall(harness.events.createdNavigationTarget, { sourceTabId: 1, tabId: 3 });
  await harness.runTimers();
  assert.equal(harness.tabGroups.get(1).title, "🔗 Example");
  assert.equal(requests, 0);
});

test("local linked-tab names use the source for every mixed-site group", async () => {
  const sourceTabs = [
    { id: 1, windowId: 1, index: 0, groupId: -1, url: "https://github.com/still/focus", title: "Still focus" },
    { id: 2, windowId: 1, index: 1, groupId: -1, url: "https://example.org/notes", title: "Notes" }
  ];
  const mixedHarness = createHarness({ initialState: baseState(), tabs: sourceTabs });
  await settle();

  await eventsCall(mixedHarness.events.createdNavigationTarget, { sourceTabId: 1, tabId: 2 });
  await mixedHarness.runTimers();
  assert.equal(mixedHarness.tabGroups.get(1).title, "🔗 GitHub");
  assert.equal(mixedHarness.tabGroups.get(1).collapsed, false);
  assert.deepEqual(mixedHarness.tabGroupMoves, []);

  const workHarness = createHarness({
    initialState: baseState(),
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: -1, url: "https://github.com/still/focus", title: "Still focus" },
      { id: 2, windowId: 1, index: 1, groupId: -1, url: "https://linear.app/still/issue-1", title: "Still issue" }
    ]
  });
  await settle();

  await eventsCall(workHarness.events.createdNavigationTarget, { sourceTabId: 1, tabId: 2 });
  await workHarness.runTimers();
  assert.equal(workHarness.tabGroups.get(1).title, "🔗 GitHub");
});

test("organisation leaves one-off learning sites ungrouped without a specific task", async () => {
  const harness = createHarness({
    initialState: baseState(),
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, groupId: -1, url: "https://brilliant.org/", title: "Brilliant" },
      { id: 2, windowId: 1, index: 1, groupId: -1, url: "https://udacity.com/", title: "Udacity" },
      { id: 3, windowId: 1, index: 2, groupId: -1, url: "https://example.com/", title: "Example" }
    ]
  });
  await settle();

  const organised = await harness.send({
    type: "ORGANIZE_TABS",
    categoryOverrides: {
      "brilliant.org": "Reference & learning",
      "udacity.com": "Reference & learning",
      "example.com": "Other"
    }
  });

  assert.equal(organised.ok, true);
  assert.equal(organised.groups.length, 0);
  assert.equal(harness.tabs.find((tab) => tab.id === 1).groupId, -1);
  assert.equal(harness.tabs.find((tab) => tab.id === 2).groupId, -1);
  assert.equal(harness.tabs.find((tab) => tab.id === 3).groupId, -1);
});

test("organisation recognizes News in titles from otherwise unclassified sites", async () => {
  const harness = createHarness({
    initialState: baseState(),
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, groupId: -1, url: "https://localpaper.example/latest", title: "Local news and updates" },
      { id: 2, windowId: 1, index: 1, groupId: -1, url: "https://techbrief.example/home", title: "Tech news today" },
      { id: 3, windowId: 1, index: 2, groupId: -1, url: "https://example.com/brief", title: "Daily briefing" }
    ]
  });
  await settle();

  const organised = await harness.send({ type: "ORGANIZE_TABS" });

  assert.equal(organised.ok, true);
  assert.equal(organised.groups.length, 1);
  assert.equal(harness.tabGroups.get(1).title, "📰 News");
  assert.equal(harness.tabs.find((tab) => tab.id === 1).groupId, 1);
  assert.equal(harness.tabs.find((tab) => tab.id === 2).groupId, 1);
  assert.equal(harness.tabs.find((tab) => tab.id === 3).groupId, -1);
});

test("organisation splits generic work tabs by service and rejects an AI Work title", async () => {
  const harness = createHarness({
    initialState: baseState(),
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, groupId: -1, url: "https://github.com/still/one", title: "Still issue one" },
      { id: 2, windowId: 1, index: 1, groupId: -1, url: "https://github.com/still/two", title: "Still issue two" },
      { id: 3, windowId: 1, index: 2, groupId: -1, url: "https://linear.app/still/issue-1", title: "Roadmap issue" },
      { id: 4, windowId: 1, index: 3, groupId: -1, url: "https://linear.app/still/issue-2", title: "Design issue" },
      { id: 5, windowId: 1, index: 4, groupId: -1, url: "https://app.slack.com/client/team", title: "Still team" }
    ]
  });
  await settle();

  const organised = await harness.send({
    type: "ORGANIZE_TABS",
    tabPlans: [{ title: "Work", tabIds: [1, 2, 3, 4, 5] }]
  });

  assert.equal(organised.ok, true);
  assert.equal(organised.usedLocalFallback, true);
  assert.equal(organised.groups.length, 2);
  assert.equal(harness.tabGroups.get(1).title, "GitHub");
  assert.equal(harness.tabGroups.get(2).title, "Linear");
  assert.equal(harness.tabs.find((tab) => tab.id === 5).groupId, -1);
});

test("organisation respects a useful AI category plan and preserves its group name", async () => {
  const harness = createHarness({
    initialState: baseState(),
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, groupId: -1, url: "https://amazon.in/", title: "Amazon" },
      { id: 2, windowId: 1, index: 1, groupId: -1, url: "https://flipkart.com/", title: "Flipkart" },
      { id: 3, windowId: 1, index: 2, groupId: -1, url: "https://godaddy.com/", title: "Domain names" }
    ]
  });
  await settle();

  const organised = await harness.send({
    type: "ORGANIZE_TABS",
    tabPlans: [{ title: "Shopping", tabIds: [1, 2, 999] }]
  });

  assert.equal(organised.ok, true);
  assert.equal(organised.groups.length, 1);
  assert.equal(harness.tabs.find((tab) => tab.id === 1).groupId, harness.tabs.find((tab) => tab.id === 2).groupId);
  assert.equal(harness.tabs.find((tab) => tab.id === 3).groupId, -1);
  assert.equal(harness.tabGroups.get(1).title, "Shopping");
});

test("organisation supplements an empty AI plan with an obvious cross-domain Social group", async () => {
  const harness = createHarness({
    initialState: baseState(),
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, groupId: -1, url: "https://x.com/home", title: "Home / X" },
      { id: 2, windowId: 1, index: 1, groupId: -1, url: "https://reddit.com/", title: "Reddit" },
      { id: 3, windowId: 1, index: 2, groupId: -1, url: "https://facebook.com/", title: "Facebook" },
      { id: 4, windowId: 1, index: 3, groupId: -1, url: "https://example.com/", title: "Unrelated" }
    ]
  });
  await settle();

  const organised = await harness.send({
    type: "ORGANIZE_TABS",
    tabPlans: []
  });

  assert.equal(organised.ok, true);
  assert.equal(organised.usedLocalFallback, true);
  assert.equal(organised.groups.length, 1);
  assert.equal(harness.tabGroups.get(1).title, "💬 Social");
  assert.equal(harness.tabGroups.get(1).collapsed, false);
  assert.deepEqual(
    harness.tabs.filter((tab) => tab.groupId === 1).map((tab) => tab.id),
    [1, 2, 3]
  );
  assert.equal(harness.tabs.find((tab) => tab.id === 4).groupId, -1);
});

test("organisation keeps structurally valid cross-domain AI groups without a local taxonomy veto", async () => {
  const harness = createHarness({
    initialState: baseState(),
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, groupId: -1, url: "https://news.ycombinator.com/", title: "Hacker News" },
      { id: 2, windowId: 1, index: 1, groupId: -1, url: "https://theverge.com/", title: "The Verge" },
      { id: 3, windowId: 1, index: 2, groupId: -1, url: "https://arstechnica.com/", title: "Ars Technica" },
      { id: 4, windowId: 1, index: 3, groupId: -1, url: "https://flipkart.com/", title: "Flipkart" },
      { id: 5, windowId: 1, index: 4, groupId: -1, url: "https://firstcry.com/", title: "FirstCry" },
      { id: 6, windowId: 1, index: 5, groupId: -1, url: "https://example.com/", title: "Unrelated" }
    ]
  });
  await settle();

  const organised = await harness.send({
    type: "ORGANIZE_TABS",
    tabPlans: [
      { title: "Tech news", tabIds: [1, 2, 3] },
      { title: "Shopping", tabIds: [4, 5, 999] },
      { title: "Related tabs", tabIds: [5, 6] }
    ]
  });

  assert.equal(organised.ok, true);
  assert.equal(organised.groups.length, 2);
  assert.equal(harness.tabs.find((tab) => tab.id === 1).groupId, harness.tabs.find((tab) => tab.id === 3).groupId);
  assert.equal(harness.tabs.find((tab) => tab.id === 4).groupId, harness.tabs.find((tab) => tab.id === 5).groupId);
  assert.equal(harness.tabs.find((tab) => tab.id === 6).groupId, -1);
  assert.equal(harness.tabGroups.get(1).collapsed, false);
  assert.equal(harness.tabGroups.get(2).collapsed, true);
  assert.deepEqual(harness.tabGroupMoves, [
    { groupId: 1, index: 0 },
    { groupId: 2, index: 3 }
  ]);
});

test("organisation falls back to obvious local groups when every explicit AI plan is structurally invalid", async () => {
  const harness = createHarness({
    initialState: baseState(),
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, groupId: -1, url: "https://x.com/home", title: "X" },
      { id: 2, windowId: 1, index: 1, groupId: -1, url: "https://reddit.com/r/productivity", title: "Reddit" },
      { id: 3, windowId: 1, index: 2, groupId: -1, url: "https://github.com/", title: "GitHub" },
      { id: 4, windowId: 1, index: 3, groupId: -1, url: "https://news.ycombinator.com/", title: "Hacker News" }
    ]
  });
  await settle();

  const organised = await harness.send({
    type: "ORGANIZE_TABS",
    tabPlans: [
      { title: "Related tabs", tabIds: [1, 2] },
      { title: "Course", tabIds: [3] },
      { title: "Shopping", tabIds: [999, 1000] }
    ]
  });

  assert.equal(organised.ok, true);
  assert.equal(organised.usedLocalFallback, true);
  assert.equal(organised.groups.length, 1);
  assert.equal(harness.tabGroups.get(1).title, "💬 Social");
  assert.equal(harness.tabs.find((tab) => tab.id === 1).groupId, 1);
  assert.equal(harness.tabs.find((tab) => tab.id === 2).groupId, 1);
  assert.equal(harness.tabs.find((tab) => tab.id === 3).groupId, -1);
  assert.equal(harness.tabs.find((tab) => tab.id === 4).groupId, -1);
});

async function eventsCall(event, ...args) {
  await event.listeners[0](...args);
  await settle();
}
