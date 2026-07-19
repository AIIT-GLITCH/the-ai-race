import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import {
  DEFAULT_RACE_CONTROL_CLIPS,
  RaceControlDirector,
} from '../race-control.js';

for (const [clipId, descriptor] of Object.entries(DEFAULT_RACE_CONTROL_CLIPS)) {
  assert.equal(typeof descriptor, 'object', `${clipId} uses an authored clip descriptor`);
  assert.equal(typeof descriptor.src, 'string', `${clipId} descriptor exposes its source`);
  assert.equal(typeof descriptor.text, 'string', `${clipId} descriptor exposes its exact caption`);
  assert.doesNotMatch(descriptor.text, /Sam Altman/i, `${clipId} narration stays entrant-only`);
  if (clipId.startsWith('clause.')) {
    assert.ok(Number.isFinite(descriptor.offset), `${clipId} has a sample-accurate sprite offset`);
    assert.ok(descriptor.duration > 0, `${clipId} has a playable sprite duration`);
  }
}
assert.equal(
  new Set(Object.entries(DEFAULT_RACE_CONTROL_CLIPS)
    .filter(([clipId]) => clipId.startsWith('clause.'))
    .map(([, descriptor]) => descriptor.src)).size,
  1,
  'all compositional clauses share one deduplicated network/decode source',
);

function assertResolvedClipMatches(control, item, message) {
  if (item.audioProgram) {
    const segments = control._resolveProgram(item);
    assert.ok(segments?.length, `${message}: compositional baked program resolves`);
    assert.equal(
      segments.length,
      item.audioProgram.length,
      `${message}: every authored clause resolves`,
    );
    return;
  }
  const descriptor = control._resolveClip(item);
  assert.ok(descriptor, `${message}: a baked descriptor resolves`);
  assert.equal(descriptor.text, item.text, `${message}: baked speech and caption stay aligned`);
}

{
  const control = new RaceControlDirector();
  const pass = {
    clipId: 'rank.up.2.ANTHROPIC',
    kind: 'rankUp',
    text: DEFAULT_RACE_CONTROL_CLIPS['rank.up'].text,
  };
  const classification = {
    clipId: 'finish.loss.7',
    kind: 'finish',
    text: DEFAULT_RACE_CONTROL_CLIPS['finish.loss'].text,
  };
  assert.equal(
    control._resolveClip(pass),
    DEFAULT_RACE_CONTROL_CLIPS['rank.up'],
    'dynamic pass calls use the baked rank-up fallback',
  );
  assert.equal(
    control._resolveClip(classification),
    DEFAULT_RACE_CONTROL_CLIPS['finish.loss'],
    'dynamic classifications use the baked finish fallback',
  );
  assertResolvedClipMatches(control, pass, 'dynamic pass fallback');
  assertResolvedClipMatches(control, classification, 'dynamic classification fallback');
  control.dispose();
}

function fakeAudioNode(extra = {}) {
  return {
    connect() { return this; },
    disconnect() {},
    ...extra,
  };
}

// Sprite descriptors must start the shared decoded buffer at the exact clause
// window instead of leaking adjacent narration.
{
  let startArgs = null;
  let finished = 0;
  const source = fakeAudioNode({
    playbackRate: { value: 1 },
    start(...args) { startArgs = args; },
    stop() {},
    onended: null,
  });
  const context = {
    destination: {},
    createBufferSource: () => source,
    createBiquadFilter: () => fakeAudioNode({
      frequency: { value: 0 },
      Q: { value: 0 },
    }),
    createDynamicsCompressor: () => fakeAudioNode({
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
    }),
    createGain: () => fakeAudioNode({ gain: { value: 0 } }),
  };
  const timers = new Map();
  let timerId = 0;
  const control = new RaceControlDirector({
    setTimer: callback => {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimer: id => timers.delete(id),
  });
  const descriptor = DEFAULT_RACE_CONTROL_CLIPS['clause.digit.8'];
  const cancel = control._playDecodedClip(
    { duration: 46 },
    descriptor,
    () => { finished++; },
    context,
    descriptor.text,
  );
  assert.deepEqual(
    startArgs,
    [0, descriptor.offset, descriptor.duration],
    'decoded sprite playback is sample-windowed',
  );
  source.onended?.();
  assert.equal(finished, 1, 'a sliced clause completes its enclosing program');
  cancel();
  control.dispose();
}

// Menu-idle prefetch + gesture-time decode share one cache. A decoded cache hit
// starts a BufferSource without another request/decode, and cancellation stops
// that source without allowing its completion callback to leak through.
{
  let fetches = 0;
  let decodes = 0;
  let resumes = 0;
  let starts = 0;
  let stops = 0;
  let finishes = 0;
  const sources = [];
  const decodedBuffer = { duration: 0.42 };
  const context = {
    state: 'suspended',
    destination: {},
    resume() {
      resumes++;
      this.state = 'running';
      return Promise.resolve();
    },
    decodeAudioData() {
      decodes++;
      return Promise.resolve(decodedBuffer);
    },
    createBufferSource() {
      const source = fakeAudioNode({
        playbackRate: { value: 1 },
        onended: null,
        start() { starts++; },
        stop() { stops++; },
      });
      sources.push(source);
      return source;
    },
    createBiquadFilter: () => fakeAudioNode({
      frequency: { value: 0 },
      Q: { value: 0 },
    }),
    createDynamicsCompressor: () => fakeAudioNode({
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
    }),
    createGain: () => fakeAudioNode({ gain: { value: 0 } }),
  };
  const timers = new Map();
  let nextTimer = 0;
  const control = new RaceControlDirector({
    clipManifest: { green: 'voice/green.mp3' },
    getAudioContext: () => context,
    fetchFn: async () => {
      fetches++;
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(16),
      };
    },
    setTimer: callback => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimer: id => timers.delete(id),
  });

  const prefetched = await control.prefetch();
  assert.deepEqual(
    { prefetched: prefetched.prefetched, decoded: prefetched.decoded },
    { prefetched: 1, decoded: 0 },
    'prefetch fills compressed cache without requiring a user gesture',
  );

  const predecoded = await control.predecode();
  assert.equal(predecoded.decoded, 1, 'offline/menu decode fills the playable buffer cache');
  assert.equal(resumes, 0, 'offline/menu decode never resumes an output context');
  const warming = control.prewarm();
  assert.equal(resumes, 1, 'prewarm resumes Web Audio synchronously inside the gesture turn');
  const warmed = await warming;
  assert.equal(warmed.decoded, 1, 'prewarm decodes the prefetched baked clip');
  await control.prewarm();
  assert.equal(fetches, 1, 'a warm clip is fetched exactly once');
  assert.equal(decodes, 1, 'gesture-time cache hit avoids a second decode');
  assert.ok(control.inspect().audioCache.decodedHits >= 1, 'cache hits are visible to diagnostics');

  control.current = { text: 'Launch confirmed.' };
  const cancel = control._playClip('voice/green.mp3', () => { finishes++; });
  await Promise.resolve();
  assert.equal(starts, 1, 'decoded playback starts through an AudioBufferSource');
  cancel();
  assert.equal(stops, 1, 'cancellation stops the active decoded source');
  sources[0].onended?.();
  assert.equal(finishes, 0, 'a cancelled decoded call cannot complete later');
  control.current = null;
  control.dispose();
}

// A transient speculative prefetch failure must not poison the launch-time
// warm path. The user gesture explicitly retries both compressed and decoded
// cache failures.
{
  let fetches = 0;
  let decodes = 0;
  const control = new RaceControlDirector({
    clipManifest: { briefing: 'voice/briefing.mp3' },
    getAudioContext: () => ({
      state: 'running',
      decodeAudioData: async () => {
        decodes++;
        return { duration: 1 };
      },
    }),
    fetchFn: async () => {
      fetches++;
      if (fetches === 1) throw new Error('transient network failure');
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(16),
      };
    },
  });
  const speculative = await control.prefetch();
  assert.equal(speculative.failed, 1, 'failed speculative prefetch is reported');
  const launchWarm = await control.prewarm({ retryFailed: true });
  assert.equal(fetches, 2, 'launch warm retries a transient prefetch failure');
  assert.equal(decodes, 1, 'retried launch warm decodes the recovered clip');
  assert.equal(launchWarm.decoded, 1, 'recovered clip becomes immediately playable');
  control.dispose();
}

// Decode/network failure retains the original media-element fallback, and a
// rejected media play retains local browser speech as the final safe fallback.
{
  let mediaAttempts = 0;
  let speechAttempts = 0;
  let speechCancellations = 0;
  class RejectingAudio {
    constructor() {
      mediaAttempts++;
      this.currentTime = 0;
      this.volume = 1;
      this.playbackRate = 1;
    }
    play() { return Promise.reject(new Error('media unavailable')); }
    pause() {}
  }
  class FakeUtterance {
    constructor(text) { this.text = text; }
  }
  const speech = {
    getVoices: () => [],
    speak: () => { speechAttempts++; },
    cancel: () => { speechCancellations++; },
  };
  const context = {
    state: 'running',
    decodeAudioData: () => Promise.reject(new Error('decode unavailable')),
  };
  const control = new RaceControlDirector({
    clipManifest: { briefing: 'voice/briefing.mp3' },
    getAudioContext: () => context,
    fetchFn: async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    }),
    AudioCtor: RejectingAudio,
    speech,
    Utterance: FakeUtterance,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  control.current = { text: 'Orbital race control online.' };
  const cancel = control._playClip('voice/briefing.mp3', () => {});
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mediaAttempts, 1, 'decode failure falls back to the baked media element');
  assert.equal(speechAttempts, 1, 'media rejection falls back to browser speech');
  cancel();
  assert.equal(speechCancellations, 1, 'fallback speech remains cancellable');
  control.current = null;
  control.dispose();
}

// Baked media completion is driven by `onended`; its defensive timer must be
// late enough that a valid clip cannot be cut off.
{
  const delays = [];
  class FakeAudio {
    constructor() {
      this.currentTime = 0;
      this.volume = 1;
      this.playbackRate = 1;
    }
    play() { return Promise.resolve(); }
    pause() {}
  }
  const control = new RaceControlDirector({
    AudioCtor: FakeAudio,
    setTimer: (_callback, delay) => {
      delays.push(delay);
      return delays.length;
    },
    clearTimer: () => {},
  });
  control.current = { text: 'Final approach. HELIOS is awake. Every position is live.' };
  const cancel = control._playClip('assets/race-control/sector-06.mp3', () => {});
  assert.ok(delays.at(-1) >= 15_000, 'clip watchdog leaves room for the complete baked line');
  cancel();
  control.dispose();
}

const calls = [];
let finishCurrent = null;
let cancellations = 0;
const transport = (item, finish) => {
  calls.push({
    kind: item.kind,
    text: item.text,
    clipId: item.clipId,
    meta: item.meta,
    audioProgram: item.audioProgram,
  });
  finishCurrent = finish;
  return () => { cancellations++; };
};

const order = (leader = 'ANTHROPIC', playerRank = 3) => {
  const names = ['ANTHROPIC', 'DEEPMIND', 'OPENAI', 'xAI'];
  names.splice(names.indexOf(leader), 1);
  names.unshift(leader);
  names.splice(names.indexOf('OPENAI'), 1);
  names.splice(playerRank - 1, 0, 'OPENAI');
  return names.map((name, index) => ({ name, progress: 100 - index, finished: false }));
};

const snapshot = ({
  time = 0,
  phase = 'race',
  leader = 'ANTHROPIC',
  rank = 3,
  progress = 0.02,
  packets = 0,
  drafting = false,
  shield = 100,
  impactSerial = 0,
  slingshotReady = false,
  slingshotReadySerial = 0,
  slingshotSerial = 0,
  draftTarget = null,
  finished = false,
} = {}) => ({
  time,
  phase,
  progress,
  player: {
    rank,
    packets,
    packetTotal: 8,
    drafting,
    shield,
    impactSerial,
    slingshotReady,
    slingshotReadySerial,
    slingshotSerial,
    draftTarget,
    hitWall: false,
    finished,
  },
  order: order(leader, rank),
});

const director = new RaceControlDirector({
  transport,
  minGap: 0,
  leaderStableFor: 1.25,
  rankStableFor: 0.72,
});

director.reset(snapshot({ phase: 'countdown' }));
assert.equal(calls.at(-1).kind, 'briefing');
finishCurrent();

director.update(snapshot({ time: 0.01 }));
assert.equal(calls.at(-1).kind, 'green');
finishCurrent();

director.update(snapshot({ time: 1.3 }));
assert.equal(calls.at(-1).kind, 'leader');
assert.equal(calls.at(-1).text, DEFAULT_RACE_CONTROL_CLIPS['leader.ANTHROPIC'].text);
finishCurrent();

director.update(snapshot({ time: 2, leader: 'OPENAI', rank: 1 }));
assert.equal(director.inspect().leader.committed, 'ANTHROPIC', 'lead change must not fire on a transient');
director.update(snapshot({ time: 3.3, leader: 'OPENAI', rank: 1 }));
assert.equal(director.inspect().leader.committed, 'OPENAI', 'stable lead change should commit');
assert.ok(director.inspect().queued.some(item => item.kind === 'leader'), 'leader cooldown retains the newest call');

director.update(snapshot({ time: 3.4, leader: 'OPENAI', rank: 1, packets: 1 }));
assert.ok(
  director.inspect().current?.kind === 'core' || director.inspect().queued.some(item => item.kind === 'core'),
  'core pickup produces a call',
);

// A finish is priority 100, interrupts any lower-priority call, and discards stale chatter.
director.update(snapshot({
  time: 4,
  leader: 'OPENAI',
  rank: 1,
  packets: 1,
  progress: 1,
  finished: true,
}));
assert.equal(calls.at(-1).kind, 'finish');
assert.match(calls.at(-1).text, /HELIOS online/);
assert.ok(cancellations >= 1, 'priority finish cancels an in-flight lower-priority call');
assert.ok(director.inspect().queued.every(item => item.kind === 'finish'), 'finish suppresses stale race calls');
for (const call of director.inspect().history) {
  assertResolvedClipMatches(director, call, `primary scenario call ${call.id}`);
}

director.dispose();

// Countdown time is frozen at zero, so the green call must explicitly bypass
// the briefing's default 4.1-second simulation-time spacing window.
{
  const transitionCalls = [];
  let transitionCancel = 0;
  const transition = new RaceControlDirector({
    transport: (item, done) => {
      transitionCalls.push({ ...item, done });
      return () => { transitionCancel++; };
    },
  });
  transition.reset(snapshot({ phase: 'countdown' }));
  assert.equal(transition.inspect().current?.kind, 'briefing');
  transition.update(snapshot({ time: 0.01, phase: 'race' }));
  assert.equal(transition.inspect().current?.kind, 'green', 'green starts on the phase transition');
  assert.equal(transitionCalls.at(-1).kind, 'green');
  assert.ok(transitionCancel >= 1, 'green interrupts a briefing that is still transmitting');
  assertResolvedClipMatches(transition, transitionCalls.at(-1), 'immediate green call');
  transition.dispose();
}

// Priority interrupts bypass the normal spacing window after cancelling a
// lower-priority transmission.
{
  const urgentCalls = [];
  let urgentCancelled = 0;
  const urgent = new RaceControlDirector({
    transport: (item, done) => {
      urgentCalls.push({ kind: item.kind, done });
      return () => { urgentCancelled++; };
    },
  });
  urgent.reset(snapshot({ phase: 'countdown' }));
  urgent.update(snapshot({
    time: 0.5,
    phase: 'race',
    leader: 'OPENAI',
    rank: 1,
    progress: 1,
    finished: true,
  }));
  assert.equal(urgentCalls.at(-1).kind, 'finish', 'finish bypasses the default minimum call gap');
  assert.ok(urgentCancelled >= 1, 'finish cancels the lower-priority briefing');
  urgent.dispose();
}

function scenario(start = {}) {
  const spoken = [];
  const events = [];
  const ducking = [];
  let finish = null;
  const control = new RaceControlDirector({
    minGap: 0,
    leaderStableFor: 1.25,
    rankStableFor: 0.72,
    draftStableFor: 0.7,
    onDuck: value => ducking.push(value),
    onEvent: item => events.push({ kind: item.kind, meta: item.meta }),
    transport: (item, done) => {
      spoken.push({
        kind: item.kind,
        text: item.text,
        clipId: item.clipId,
        meta: item.meta,
        audioProgram: item.audioProgram,
      });
      finish = done;
      return () => {};
    },
  });
  control.reset(snapshot({ phase: 'countdown', ...start }));
  const end = () => {
    const done = finish;
    finish = null;
    done?.();
  };
  end();
  control.update(snapshot({ time: 0.01, ...start }));
  end();
  return { control, spoken, events, ducking, end };
}

// Player position calls wait for a stable rank, then name the pass/loss.
{
  const s = scenario({ rank: 3 });
  s.control.update(snapshot({ time: 0.8, rank: 2 }));
  s.control.update(snapshot({ time: 1.55, rank: 2 }));
  s.end();
  assert.ok(s.spoken.some(call =>
    call.kind === 'rankUp' &&
    call.text === 'OpenAI passes DeepMind for second.'));
  assert.ok(s.events.some(event => event.kind === 'rankUp'), 'host moment callback receives rank-up metadata');
  s.control.update(snapshot({ time: 2, rank: 3 }));
  s.control.update(snapshot({ time: 2.75, rank: 3 }));
  s.end();
  assert.ok(s.spoken.some(call =>
    call.kind === 'rankDown' &&
    call.text === 'DeepMind passes OpenAI. OpenAI drops to third.'));
  for (const call of s.control.inspect().history) {
    assertResolvedClipMatches(s.control, call, `position call ${call.id}`);
  }
  s.control.dispose();
}

// Drafting must persist; pickup, impact, and shield thresholds are edge-triggered.
{
  const s = scenario();
  s.control.update(snapshot({ time: 0.4, drafting: true }));
  s.control.update(snapshot({ time: 1.11, drafting: true }));
  while (s.control.inspect().current) s.end();
  assert.ok(s.spoken.some(call => call.kind === 'draft'));

  s.control.update(snapshot({ time: 2, packets: 2, shield: 72, impactSerial: 1 }));
  assert.equal(
    s.spoken.at(-1).kind,
    'impact',
    'same-snapshot detectors batch before the higher-priority impact is selected',
  );
  while (s.control.inspect().current) s.end();
  assert.ok(s.spoken.some(call => call.kind === 'core'));
  assert.ok(s.spoken.some(call => call.kind === 'impact'));

  s.control.update(snapshot({ time: 3, packets: 2, shield: 21, impactSerial: 1 }));
  while (s.control.inspect().current) s.end();
  assert.ok(s.spoken.some(call => call.kind === 'shieldLow'));
  s.control.update(snapshot({ time: 4, packets: 2, shield: 0, impactSerial: 1 }));
  while (s.control.inspect().current) s.end();
  assert.ok(s.spoken.some(call => call.kind === 'shieldGone'));
  for (const call of s.control.inspect().history) {
    assertResolvedClipMatches(s.control, call, `status call ${call.id}`);
  }
  s.control.dispose();
}

// Slingshot readiness and deployment are serial-edge events. A held ready
// state cannot chatter, and deployment pre-empts lower-priority radio traffic.
{
  const s = scenario();
  s.control.update(snapshot({
    time: 0.4,
    slingshotReady: true,
    slingshotReadySerial: 1,
    draftTarget: 'ANTHROPIC',
  }));
  assert.equal(s.spoken.at(-1).kind, 'slingshotReady');
  assert.equal(
    s.spoken.at(-1).text,
    'Wake lock complete. Slingshot is armed.',
  );
  assert.equal(s.spoken.at(-1).meta.target, 'ANTHROPIC');
  s.end();
  const readyCount = s.spoken.filter(call => call.kind === 'slingshotReady').length;
  s.control.update(snapshot({
    time: 0.8,
    slingshotReady: true,
    slingshotReadySerial: 1,
    draftTarget: 'ANTHROPIC',
  }));
  assert.equal(
    s.spoken.filter(call => call.kind === 'slingshotReady').length,
    readyCount,
    'a held ready serial does not repeat',
  );

  s.control.emit({
    id: 'slingshot-blocker',
    kind: 'draft',
    text: DEFAULT_RACE_CONTROL_CLIPS.draft.text,
    clipId: 'draft',
    priority: 58,
    createdAt: 0.8,
    expiresAt: 4,
  });
  assert.equal(s.control.inspect().current?.kind, 'draft');
  s.control.update(snapshot({
    time: 1,
    slingshotReady: false,
    slingshotReadySerial: 1,
    slingshotSerial: 1,
    draftTarget: 'ANTHROPIC',
  }));
  assert.equal(s.control.inspect().current?.kind, 'slingshotFire');
  assert.equal(
    s.spoken.at(-1).text,
    'Slingshot deployed. OpenAI attacks Anthropic.',
  );
  assert.equal(s.spoken.at(-1).meta.target, 'ANTHROPIC');
  s.end();
  const fireCount = s.spoken.filter(call => call.kind === 'slingshotFire').length;
  s.control.update(snapshot({
    time: 1.2,
    slingshotReady: false,
    slingshotReadySerial: 1,
    slingshotSerial: 1,
    draftTarget: 'ANTHROPIC',
  }));
  assert.equal(
    s.spoken.filter(call => call.kind === 'slingshotFire').length,
    fireCount,
    'a held deployment serial does not repeat',
  );
  for (const call of s.control.inspect().history) {
    assertResolvedClipMatches(s.control, call, `slingshot call ${call.id}`);
  }
  s.control.dispose();
}

// Sector transitions are authored and the final approach pre-empts normal traffic.
{
  const s = scenario();
  s.control.update(snapshot({ time: 2, progress: 0.36 }));
  while (s.control.inspect().current) s.end();
  assert.ok(s.spoken.some(call => call.text.includes('Karman Climb')));
  s.control.update(snapshot({ time: 7.1, progress: 0.36 }));
  while (s.control.inspect().current) s.end();
  assert.ok(s.spoken.some(call => call.text.includes('Lunar Slingshot')));
  s.control.update(snapshot({ time: 8, progress: 0.92 }));
  while (s.control.inspect().current) s.end();
  assert.ok(s.spoken.some(call => call.kind === 'final' && call.text.includes('HELIOS is awake')));
  for (const call of s.control.inspect().history) {
    assertResolvedClipMatches(s.control, call, `sector call ${call.id}`);
  }
  s.control.dispose();
}

// Non-winning finishes still classify OpenAI and identify the winner.
{
  const s = scenario({ rank: 3 });
  s.control.update(snapshot({ time: 2, phase: 'results', rank: 3, progress: 1, finished: true }));
  assert.equal(s.spoken.at(-1).kind, 'finish');
  assert.equal(s.spoken.at(-1).text, DEFAULT_RACE_CONTROL_CLIPS['finish.loss'].text);
  assert.equal(s.spoken.at(-1).meta.rank, 3);
  assert.equal(s.spoken.at(-1).meta.winner, 'ANTHROPIC');
  assertResolvedClipMatches(s.control, s.spoken.at(-1), 'non-winning finish');
  s.control.dispose();
}

// Mute suppresses the voice/duck path while preserving the caption-only call.
{
  const s = scenario();
  s.control.setMuted(true);
  s.control.reset(snapshot({ phase: 'countdown' }));
  assert.equal(s.control.inspect().current?.kind, 'briefing');
  assert.notEqual(s.ducking.at(-1), true);
  s.control.dispose();
}

// Calls that become irrelevant while another transmission is live are discarded.
{
  const s = scenario();
  s.control.emit({
    id: 'blocking-call',
    kind: 'impact',
    text: 'Blocking transmission.',
    priority: 90,
    createdAt: 0.01,
    expiresAt: 5,
  });
  s.control.emit({
    id: 'stale-rank',
    kind: 'rankUp',
    text: 'Outdated position call.',
    priority: 20,
    createdAt: 0.01,
    expiresAt: 0.2,
  });
  s.control.update(snapshot({ time: 1 }));
  assert.ok(!s.control.inspect().queued.some(call => call.id === 'stale-rank'));
  s.control.dispose();
}

// Exact HELIOS classification is deterministic, margin-aware, and idempotent.
// This exercises the public seam directly so the regression does not depend on
// audio duration, browser timers, or the order in which the render loop observes
// P1 and P2 crossing the line.
{
  const transmissions = [];
  let complete = null;
  const control = new RaceControlDirector({
    minGap: 0,
    transport: (item, done) => {
      transmissions.push({
        kind: item.kind,
        text: item.text,
        meta: item.meta,
        audioProgram: item.audioProgram,
      });
      complete = done;
      return () => {};
    },
  });
  const base = snapshot({ phase: 'countdown' });
  control.reset(base);
  complete?.();
  control.update(snapshot({ time: .01, phase: 'race' }));
  complete?.();

  const exactWin = {
    phase: 'race',
    time: 42.18,
    progress: 1,
    player: {
      name: 'OPENAI',
      rank: 1,
      finished: true,
      finishTime: 42,
    },
    order: [
      { name: 'OPENAI', finished: true, finishTime: 42, progress: 1 },
      { name: 'ANTHROPIC', finished: true, finishTime: 42.18, progress: 1 },
      { name: 'DEEPMIND', finished: false, finishTime: 0, progress: .99 },
    ],
  };
  assert.equal(control.emitClaim(exactWin), true, 'an exact P1/P2 result emits a claim');
  const claim = transmissions.at(-1);
  assert.equal(claim.kind, 'claim');
  assert.equal(claim.text, 'HELIOS online. OpenAI wins by 0.18 seconds.');
  assert.deepEqual(
    {
      winner: claim.meta.winner,
      rival: claim.meta.rival,
      rank: claim.meta.rank,
      marginText: claim.meta.marginText,
      marginKnown: claim.meta.marginKnown,
    },
    {
      winner: 'OPENAI',
      rival: 'ANTHROPIC',
      rank: 1,
      marginText: '0.18 seconds',
      marginKnown: true,
    },
  );
  assert.ok(Math.abs(claim.meta.margin - .18) < 1e-9, 'raw winning margin remains numeric');
  assert.deepEqual(
    claim.audioProgram.map(segment => segment.clipId),
    [
      'clause.helios-online',
      'clause.openai-wins-by',
      'clause.digit.0',
      'clause.point',
      'clause.digit.1',
      'clause.digit.8',
      'clause.seconds',
    ],
    'the exact 0.18-second margin is assembled from bounded baked clauses',
  );
  assert.equal(
    control.emitClaim(exactWin),
    false,
    're-observing the same classification cannot repeat the HELIOS claim',
  );
  assert.equal(
    control.inspect().history.filter(item => item.kind === 'claim').length,
    1,
    'history contains exactly one authoritative HELIOS claim',
  );
  control.dispose();
}

// A non-winning classification names the winner, OpenAI's position, and its
// exact deficit using the same bounded clause transport.
{
  const transmissions = [];
  const control = new RaceControlDirector({
    minGap: 0,
    transport: item => {
      transmissions.push(item);
      return () => {};
    },
  });
  control.phase = 'race';
  control.now = 40.42;
  const exactLoss = {
    phase: 'race',
    time: 40.42,
    progress: 1,
    player: {
      name: 'OPENAI',
      rank: 2,
      finished: true,
      finishTime: 40.42,
    },
    order: [
      { name: 'ANTHROPIC', finished: true, finishTime: 40, progress: 1 },
      { name: 'OPENAI', finished: true, finishTime: 40.42, progress: 1 },
      { name: 'DEEPMIND', finished: false, finishTime: 0, progress: .99 },
    ],
  };
  assert.equal(control.emitClaim(exactLoss), true);
  const claim = transmissions.at(-1);
  assert.equal(claim.kind, 'claim');
  assert.equal(
    claim.text,
    'Anthropic claims HELIOS. OpenAI finishes second, 0.42 seconds back.',
  );
  assert.deepEqual(
    {
      winner: claim.meta.winner,
      rank: claim.meta.rank,
      playerFinishTime: claim.meta.playerFinishTime,
      winnerFinishTime: claim.meta.winnerFinishTime,
    },
    {
      winner: 'ANTHROPIC',
      rank: 2,
      playerFinishTime: 40.42,
      winnerFinishTime: 40,
    },
  );
  assert.ok(Math.abs(claim.meta.margin - .42) < 1e-9, 'raw losing margin remains numeric');
  assert.ok(
    claim.audioProgram.some(segment => segment.clipId === 'clause.lab.ANTHROPIC') &&
    claim.audioProgram.some(segment => segment.clipId === 'clause.rank.2') &&
    claim.audioProgram.some(segment => segment.clipId === 'clause.digit.4') &&
    claim.audioProgram.some(segment => segment.clipId === 'clause.digit.2'),
    'loss program names the winner, rank, and exact deficit',
  );
  control.dispose();
}

// Keep this last so director behavior remains testable while a newly authored
// clip is waiting to be baked. Release verification still fails closed when a
// manifest source is absent.
for (const [clipId, descriptor] of Object.entries(DEFAULT_RACE_CONTROL_CLIPS)) {
  await access(new URL(`../${descriptor.src}`, import.meta.url));
  assert.ok(descriptor.text.length > 0, `${clipId} has authored caption text`);
}

console.log('RACE CONTROL OK');
