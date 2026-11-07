import { test } from "node:test";
import assert from "node:assert/strict";
import { screenshotRefs, unattached } from "../lib/attach.mjs";

test("screenshotRefs finds ./screenshots/ images in a body, once each", () => {
  const body = [
    "Before:",
    "![The tip page, before](./screenshots/before.png)",
    "![After, on a phone](./screenshots/after-phone.png) and again ![After, on a phone](./screenshots/after-phone.png)",
    "![elsewhere](https://example.com/x.png) ![not ours](./other/x.png)",
  ].join("\n");
  assert.deepEqual(screenshotRefs(body), [
    { alt: "The tip page, before", path: "./screenshots/before.png" },
    { alt: "After, on a phone", path: "./screenshots/after-phone.png" },
  ]);
  assert.deepEqual(screenshotRefs(null), []);
});

test("unattached turns references into plain text when there's no token to upload them", () => {
  const body = "See ![The tip page](./screenshots/tip.png) here.";
  assert.equal(unattached(body), "See _(Screenshot not attached: The tip page)_ here.");
});
