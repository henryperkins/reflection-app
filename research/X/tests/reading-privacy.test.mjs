import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createRecordsHarness, successfulReadingResponse } from "./helpers/records-harness.mjs";

let harness;
before(async () => {
  harness = await createRecordsHarness();
});
beforeEach(async () => {
  await harness.reset();
});
after(async () => {
  await harness?.close();
});

const todayDay = () => new Date().toISOString().slice(0, 10);
const gatewayText = () => JSON.stringify(harness.gatewayRequests);
const sourceIds = (today) => today.provenance.map((row) => row.source_id);
function successfulFeatureResponse(body) {
  const prompt = body.messages.find((message) => message.role === "user").content;
  const tone = prompt.match(/Tone preference: (\w+)\./)?.[1];
  return Response.json({
    choices: [
      {
        message: {
          content: JSON.stringify({
            paragraphs: [
              {
                text: `This chapter uses ${tone} wording. The supplied structure is described as a reflective pattern. Your experience can be considered alongside it.`,
                facts: ["N1"],
              },
            ],
            reflection_question: "Where do you recognise this pattern in your everyday life?",
          }),
        },
      },
    ],
  });
}
async function prepare() {
  const db = harness.records();
  const ephem = harness.ephemerisModule;
  const saturn = ephem.positionOf("saturn", ephem.toJulianDay(new Date(`${todayDay()}T12:00:00Z`)));
  await harness.seedChart(db, harness.userA, {
    positions: {
      sun: {
        key: "sun",
        label: "Sun",
        lon: saturn.lon,
        sign: ephem.signOf(saturn.lon),
        degree: ephem.degreeInSign(saturn.lon),
        house: 1,
        speed: 1,
        retrograde: false,
        angleDependent: false,
      },
    },
  });
  harness.setGateway(successfulReadingResponse);
  return db;
}

test("an unconsented private check-in cannot enter the external reading request", async () => {
  const db = await prepare();
  await harness.app.saveCheckIn(
    db,
    harness.userA,
    todayDay(),
    2,
    4,
    "PRIVATE_NOTE_SENTINEL",
    null,
    null,
  );
  const today = await harness.app.getToday(db, harness.userA, "UTC");
  assert.equal(harness.gatewayRequests.length, 1, "The real language gateway path was exercised");
  assert.doesNotMatch(
    gatewayText(),
    /self-reported mood|self-reported energy|PRIVATE_NOTE_SENTINEL/,
  );
  assert.equal(sourceIds(today).includes("USR-04"), false);
  assert.equal(today.wellness.note, "PRIVATE_NOTE_SENTINEL", "Private storage stays available");
  const grants = await harness.app.grantedSet(db, harness.userA);
  assert.equal(grants.has("USR-04"), false, "Saving must not grant reading consent");
});

test("opted-in check-in and wellness remain local while model prose stays available", async () => {
  const db = await prepare();
  for (const id of ["USR-04", "WEL-01", "WEL-03"])
    await harness.app.setConsent(db, harness.userA, id, true);
  await harness.app.saveCheckIn(db, harness.userA, todayDay(), 2, 4, "PRIVATE_NOTE_SENTINEL", 1, 5);
  const today = await harness.app.getToday(db, harness.userA, "UTC");
  assert.equal(today.language.mode, "model");
  assert.equal(harness.gatewayRequests.length, 1);
  assert.doesNotMatch(
    gatewayText(),
    /self-reported mood|self-reported energy|sleep quality|stress load|PRIVATE_NOTE_SENTINEL/,
  );
  assert.match(today.reading.body, /mood 2\/5 and energy 4\/5/);
  assert.match(today.reading.body, /sleep 1\/5 and stress 5\/5/);
  assert.match(today.reading.prompt, /pressure running high/);
  for (const id of ["USR-04", "WEL-01", "WEL-03"])
    assert.ok(sourceIds(today).includes(id), `${id} local provenance`);
  assert.equal(today.wellness.note, "PRIVATE_NOTE_SENTINEL");
});

test("unconsented tone and depth are replaced by ordinary defaults before model use", async () => {
  const db = await prepare();
  await harness.app.updatePrefs(db, harness.userA, "PRIVATE_NAME_SENTINEL", "warm", "technical");
  await harness.app.getToday(db, harness.userA, "UTC");
  assert.match(gatewayText(), /Tone: plain\./);
  assert.match(gatewayText(), /Depth: standard\./);
  assert.doesNotMatch(gatewayText(), /Tone: warm|Depth: technical|PRIVATE_NAME_SENTINEL/);
});

test("opted-in ordinary tone and depth preferences may reach the language provider", async () => {
  const db = await prepare();
  await harness.app.updatePrefs(db, harness.userA, null, "warm", "technical");
  for (const id of ["USR-01", "USR-02"]) await harness.app.setConsent(db, harness.userA, id, true);
  await harness.app.getToday(db, harness.userA, "UTC");
  assert.match(gatewayText(), /Tone: warm\./);
  assert.match(gatewayText(), /Depth: technical\./);
});

test("raw birth details and opted-in ambient context cannot reach the model", async () => {
  const db = await prepare();
  for (const id of ["AMB-02", "DEV-01"]) await harness.app.setConsent(db, harness.userA, id, true);
  await harness.app.getToday(db, harness.userA, "Pacific/Honolulu");
  assert.equal(harness.gatewayRequests.length, 1);
  assert.doesNotMatch(
    gatewayText(),
    /Private birth place sentinel|1990-01-01|12\.34567|76\.54321|Pacific\/Honolulu|time-of-day bucket|local time bucket|F1:/,
  );
});

test("a reopened cached model reading reports the exact original provider inputs", async () => {
  const db = await prepare();
  const first = await harness.app.getToday(db, harness.userA, "UTC");
  assert.equal(first.language.mode, "model");
  assert.ok(first.language.facts.length > 0);
  const sentPrompt = harness.gatewayRequests[0].messages.find(
    (message) => message.role === "user",
  ).content;
  assert.deepEqual(
    sentPrompt.match(/^[A-Z]\d+: .*$/gm).sort(),
    first.language.facts.map((fact) => `${fact.id}: ${fact.statement}`).sort(),
  );
  harness.reopen();
  const cached = await harness.app.getToday(harness.records(), harness.userA, "UTC");
  assert.equal(cached.reading.id, first.reading.id);
  assert.deepEqual(cached.language.facts, first.language.facts);
  assert.equal(harness.gatewayRequests.length, 1, "Reopen reuses stored language and inputs");
});

async function prepareFeature() {
  const db = harness.records();
  const { snapshotId } = await harness.seedChart(db, harness.userA);
  const result = await db.from("natal_features").insert({
    user_id: harness.userA,
    snapshot_id: snapshotId,
    feature_key: "sun_in_aries",
    family: "placement",
    title: "Sun in Aries",
    strength: 1,
    payload: { sign: "Aries", house: 1, degree: 12 },
  });
  assert.equal(result.error, null, result.error?.message);
  await harness.app.updatePrefs(db, harness.userA, null, "warm", "technical");
  harness.setGateway(successfulFeatureResponse);
  return db;
}

test("natal language requests also keep unconsented ordinary preferences at defaults", async () => {
  const db = await prepareFeature();
  const chapter = await harness.app.getFeatureNarrative(db, harness.userA, "sun_in_aries");
  assert.equal(chapter.available, true);
  assert.equal(chapter.mode, "model");
  assert.equal(harness.gatewayRequests.length, 1);
  assert.match(gatewayText(), /Tone preference: plain\./);
  assert.doesNotMatch(gatewayText(), /Tone preference: warm\./);
});

test("revoking natal tone use invalidates cached warm prose before a plain rewrite", async () => {
  const db = await prepareFeature();
  await harness.app.setConsent(db, harness.userA, "USR-01", true);
  const warm = await harness.app.getFeatureNarrative(db, harness.userA, "sun_in_aries");
  assert.equal(warm.available, true);
  assert.match(warm.narrative, /warm wording/);
  harness.reopen();
  const cached = await harness.app.getFeatureNarrative(
    harness.records(),
    harness.userA,
    "sun_in_aries",
  );
  assert.equal(cached.narrative, warm.narrative);
  assert.equal(harness.gatewayRequests.length, 1);
  await harness.app.setConsent(harness.records(), harness.userA, "USR-01", false);
  const plain = await harness.app.getFeatureNarrative(
    harness.records(),
    harness.userA,
    "sun_in_aries",
  );
  assert.equal(plain.available, true);
  assert.match(plain.narrative, /plain wording/);
  assert.equal(harness.gatewayRequests.length, 2, "Revoke refreshes the cached chapter");
  assert.match(JSON.stringify(harness.gatewayRequests[1]), /Tone preference: plain\./);
});

test("external language policy permits chart-derived sources and only opted-in ordinary preferences", () => {
  const { SOURCES, isPermitted, assertUse } = harness.registryModule;
  const chart = new Set(["AST-05", "AST-07", "AST-08", "AST-20"]);
  const preferences = new Set(["USR-01", "USR-02"]);
  const everySource = new Set(SOURCES.map((source) => source.id));
  for (const source of SOURCES) {
    assert.equal(
      isPermitted(source.id, "external_language", new Set()),
      chart.has(source.id),
      `${source.id} off`,
    );
    assert.equal(
      isPermitted(source.id, "external_language", everySource),
      chart.has(source.id) || preferences.has(source.id),
      `${source.id} on`,
    );
    if (!chart.has(source.id) && !preferences.has(source.id))
      assert.throws(
        () => assertUse(source.id, "external_language"),
        undefined,
        `${source.id} rejected`,
      );
  }
});

