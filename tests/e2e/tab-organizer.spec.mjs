import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, chromium } from "@playwright/test";

const extensionPath = path.resolve(new URL("../..", import.meta.url).pathname);

async function waitForServiceWorker(context) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const worker = context.serviceWorkers()[0];
    if (worker) return worker;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Still service worker did not start");
}

async function openUnreachableTab(context, url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 5_000 }).catch(() => {});
  return page;
}

test("organize tabs merges same-domain tabs into an existing linked group", async () => {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "still-playwright-"));
  let context;

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: { width: 1280, height: 800 },
      args: [
        "--disable-crash-reporter",
        "--disable-crashpad",
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ]
    });

    const worker = await waitForServiceWorker(context);
    const extensionId = new URL(worker.url()).host;

    await openUnreachableTab(context, "http://github.test/pull/1");
    await openUnreachableTab(context, "http://github.test/issues");

    await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const sourceTabs = tabs.filter((tab) => tab.url?.startsWith("http://github.test/"));
      const groupId = await chrome.tabs.group({ tabIds: sourceTabs.map((tab) => tab.id) });
      await chrome.tabGroups.update(groupId, {
        title: "🔗 GitHub",
        color: "blue",
        collapsed: false
      });
      // Let the native tab-group update event settle before seeding the
      // metadata that Still normally writes when it creates linked groups.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const data = await chrome.storage.session.get("tabOrganizerState");
      const state = data.tabOrganizerState || { managedGroups: {}, undoByWindow: {} };
      state.managedGroups = state.managedGroups || {};
      state.managedGroups[groupId] = {
        windowId: sourceTabs[0].windowId,
        kind: "linkTrail",
        sourceHost: "github.test",
        autoName: "🔗 GitHub",
        manualName: false,
        color: "blue",
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await chrome.storage.session.set({ tabOrganizerState: state });
    });

    await openUnreachableTab(context, "http://github.test/settings");
    await openUnreachableTab(context, "http://github.test/notifications");
    await openUnreachableTab(context, "http://reddit.test/r/webdev");

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator("#organize-tabs").click();
    await popup.locator("#tab-organizer-status").waitFor({ state: "visible" });

    const result = await worker.evaluate(async () => ({
      tabs: (await chrome.tabs.query({})).map(({ url, groupId }) => ({ url, groupId })),
      groups: (await chrome.tabGroups.query({})).map(({ id, title, collapsed }) => ({
        id,
        title,
        collapsed
      }))
    }));

    const githubTabs = result.tabs.filter(({ url }) => url?.startsWith("http://github.test/"));
    const githubGroups = result.groups.filter(({ title }) => title === "🔗 GitHub");
    assert.equal(githubGroups.length, 1, "same-domain tabs should reuse the linked group");
    assert.equal(
      new Set(githubTabs.map(({ groupId }) => groupId)).size,
      1,
      "all same-domain tabs should share the existing group"
    );
    assert.equal(githubGroups[0].collapsed, false, "the existing linked group stays expanded");
  } finally {
    await context?.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("organize tabs consolidates duplicate group names regardless of creator", async () => {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "still-playwright-"));
  let context;

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: { width: 1280, height: 800 },
      args: [
        "--disable-crash-reporter",
        "--disable-crashpad",
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ]
    });

    const worker = await waitForServiceWorker(context);
    const extensionId = new URL(worker.url()).host;
    await openUnreachableTab(context, "http://alpha.test/one");
    await openUnreachableTab(context, "http://alpha.test/two");
    await openUnreachableTab(context, "http://beta.test/one");
    await openUnreachableTab(context, "http://beta.test/two");

    await worker.evaluate(async () => {
      const tabs = (await chrome.tabs.query({})).filter((tab) =>
        tab.url?.startsWith("http://alpha.test/") || tab.url?.startsWith("http://beta.test/")
      );
      const alphaTabs = tabs.filter((tab) => tab.url.startsWith("http://alpha.test/"));
      const betaTabs = tabs.filter((tab) => tab.url.startsWith("http://beta.test/"));
      const leftGroupId = await chrome.tabs.group({ tabIds: alphaTabs.map((tab) => tab.id) });
      const rightGroupId = await chrome.tabs.group({ tabIds: betaTabs.map((tab) => tab.id) });
      await chrome.tabGroups.update(leftGroupId, {
        title: "Project Alpha",
        color: "blue",
        collapsed: false
      });
      await chrome.tabGroups.update(rightGroupId, {
        title: "Project Alpha",
        color: "red",
        collapsed: true
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator("#organize-tabs").click();
    await popup.locator("#tab-organizer-status").waitFor({ state: "visible" });

    const result = await worker.evaluate(async () => ({
      tabs: (await chrome.tabs.query({})).filter((tab) =>
        tab.url?.startsWith("http://alpha.test/") || tab.url?.startsWith("http://beta.test/")
      ).map(({ id, groupId }) => ({ id, groupId })),
      groups: (await chrome.tabGroups.query({})).filter((group) => group.title === "Project Alpha")
    }));

    assert.equal(result.groups.length, 1, "same-name groups should consolidate");
    assert.equal(new Set(result.tabs.map(({ groupId }) => groupId)).size, 1);
    assert.equal(result.tabs[0].groupId, result.groups[0].id);
  } finally {
    await context?.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
