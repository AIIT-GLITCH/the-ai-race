/*
 * THE AI RACE // ORBITAL RACE CONTROL
 *
 * Event director and narration transport. The director is deliberately
 * independent of Three.js and the physics loop: feed it immutable snapshots
 * and it produces deterministic calls. That makes lead/rank stability,
 * cooldowns, stale-event handling, and authored clip selection testable
 * without a browser.
 *
 * Baked voice clips can be added without changing the director:
 *   { 'sector.03': {
 *       src: 'assets/race-control/sector-03.ogg',
 *       text: 'Sector three. Lunar Slingshot. Momentum is everything here.'
 *   } }
 * If no matching clip exists, the browser's local speechSynthesis voice is
 * used. No voice is selected by a real person's name.
 */

const CLIP_ROOT = 'assets/race-control';
export const DEFAULT_RACE_CONTROL_CLIPS = Object.freeze({
  briefing: `${CLIP_ROOT}/briefing.mp3`,
  green: `${CLIP_ROOT}/green.mp3`,
  'leader.OPENAI': `${CLIP_ROOT}/leader-openai.mp3`,
  'leader.ANTHROPIC': `${CLIP_ROOT}/leader-anthropic.mp3`,
  'leader.DEEPMIND': `${CLIP_ROOT}/leader-deepmind.mp3`,
  'leader.xAI': `${CLIP_ROOT}/leader-xai.mp3`,
  'leader.META': `${CLIP_ROOT}/leader-meta.mp3`,
  'leader.DEEPSEEK': `${CLIP_ROOT}/leader-deepseek.mp3`,
  'leader.MISTRAL': `${CLIP_ROOT}/leader-mistral.mp3`,
  'leader.QWEN': `${CLIP_ROOT}/leader-qwen.mp3`,
  'leader.MOONSHOT': `${CLIP_ROOT}/leader-moonshot.mp3`,
  'leader.COHERE': `${CLIP_ROOT}/leader-cohere.mp3`,
  'leader.MINIMAX': `${CLIP_ROOT}/leader-minimax.mp3`,
  'leader.MICROSOFT': `${CLIP_ROOT}/leader-microsoft.mp3`,
  'rank.up': `${CLIP_ROOT}/rank-up.mp3`,
  'rank.down': `${CLIP_ROOT}/rank-down.mp3`,
  draft: `${CLIP_ROOT}/draft.mp3`,
  core: `${CLIP_ROOT}/core.mp3`,
  'core.8': `${CLIP_ROOT}/core-8.mp3`,
  impact: `${CLIP_ROOT}/impact.mp3`,
  'shield.low': `${CLIP_ROOT}/shield-low.mp3`,
  'shield.gone': `${CLIP_ROOT}/shield-gone.mp3`,
  'sector.02': `${CLIP_ROOT}/sector-02.mp3`,
  'sector.03': `${CLIP_ROOT}/sector-03.mp3`,
  'sector.04': `${CLIP_ROOT}/sector-04.mp3`,
  'sector.05': `${CLIP_ROOT}/sector-05.mp3`,
  'sector.06': `${CLIP_ROOT}/sector-06.mp3`,
  'finish.win': `${CLIP_ROOT}/finish-win.mp3`,
  'finish.loss': `${CLIP_ROOT}/finish-loss.mp3`,
});

const DEFAULT_SECTORS = Object.freeze([
  { f: 0.00, code: '01', name: 'HELIOS LAUNCH ARRAY' },
  { f: 0.16, code: '02', name: 'KARMAN CLIMB' },
  { f: 0.35, code: '03', name: 'LUNAR SLINGSHOT' },
  { f: 0.55, code: '04', name: 'DARK-SIDE SWITCHBACK' },
  { f: 0.74, code: '05', name: 'QUANTUM DATA STREAM' },
  { f: 0.91, code: '06', name: 'HELIOS COMPUTE ARRAY' },
]);

const PRIORITY = Object.freeze({
  briefing: 64,
  green: 86,
  leader: 73,
  rankUp: 79,
  rankDown: 81,
  draft: 58,
  core: 76,
  impact: 84,
  shieldLow: 91,
  shieldGone: 97,
  sector: 70,
  final: 94,
  finish: 100,
});

const COOLDOWN = Object.freeze({
  briefing: 30,
  green: 30,
  leader: 7.5,
  rankUp: 5.5,
  rankDown: 5.5,
  draft: 11,
  core: 3.8,
  impact: 7,
  shieldLow: 18,
  shieldGone: 30,
  sector: 5,
  final: 20,
  finish: 60,
});

const STALE_AFTER = Object.freeze({
  briefing: 5,
  green: 7,
  leader: 9,
  rankUp: 7,
  rankDown: 7,
  draft: 6,
  core: 8,
  impact: 3.2,
  shieldLow: 8,
  shieldGone: 10,
  sector: 13,
  final: 18,
  finish: 60,
});

const POSITION_WORDS = Object.freeze([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pick(lines, key) {
  return lines[hashString(String(key)) % lines.length];
}

function spokenLab(name = '') {
  const aliases = {
    xAI: 'xAI',
    QWEN: 'Qwen',
    DEEPSEEK: 'DeepSeek',
    DEEPMIND: 'DeepMind',
    MINIMAX: 'MiniMax',
    OPENAI: 'OpenAI',
  };
  return aliases[name] || String(name).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function speechText(text) {
  return String(text)
    .replace(/\bOpenAI\b/gi, 'Open A I')
    .replace(/\bxAI\b/g, 'x A I');
}

function pWord(rank) {
  return `P ${POSITION_WORDS[rank] || String(rank)}`;
}

function estimateSpeechMs(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  return clamp(650 + words * 300, 1500, 6200);
}

function makeEvent(kind, time, text, options = {}) {
  return {
    id: options.id || `${kind}.${Math.round(time * 1000)}`,
    clipId: options.clipId || kind,
    dedupeKey: options.dedupeKey || kind,
    kind,
    text,
    priority: options.priority ?? PRIORITY[kind] ?? 50,
    createdAt: time,
    expiresAt: time + (options.staleAfter ?? STALE_AFTER[kind] ?? 8),
    interrupt: Boolean(options.interrupt),
    meta: options.meta || {},
  };
}

function defaultTimer(fn, delay) {
  return setTimeout(fn, delay);
}

/**
 * Event-driven announcer. `update(snapshot)` is the only simulation input.
 *
 * Snapshot shape:
 * {
 *   phase, time, progress,
 *   player: { rank, packets, drafting, shield, limp, hitWall,
 *             impactSerial, finished },
 *   order: [{ name, progress, finished, finishTime }]
 * }
 */
export class RaceControlDirector {
  constructor(options = {}) {
    this.captionEl = options.captionEl || null;
    this.captionCopy = this.captionEl?.querySelector?.('[data-race-control-copy]') || this.captionEl;
    this.captionSignal = this.captionEl?.querySelector?.('[data-race-control-signal]') || null;
    this.clipManifest = options.clipManifest || DEFAULT_RACE_CONTROL_CLIPS;
    this.sectors = [...(options.sectors || DEFAULT_SECTORS)].sort((a, b) => a.f - b.f);
    this.onDuck = options.onDuck || (() => {});
    this.getAudioContext = options.getAudioContext || (() => null);
    this.speech = options.speech ?? globalThis.speechSynthesis ?? null;
    this.Utterance = options.Utterance ?? globalThis.SpeechSynthesisUtterance ?? null;
    this.AudioCtor = options.AudioCtor ?? globalThis.Audio ?? null;
    this.transport = options.transport || null;
    this.setTimer = options.setTimer || defaultTimer;
    this.clearTimer = options.clearTimer || (timer => clearTimeout(timer));
    this.minGap = options.minGap ?? 4.1;
    this.leaderStableFor = options.leaderStableFor ?? 1.25;
    this.rankStableFor = options.rankStableFor ?? 0.72;
    this.draftStableFor = options.draftStableFor ?? 0.7;
    this.maxHistory = options.maxHistory ?? 80;
    this.muted = Boolean(options.muted);
    this.run = 0;
    this.queue = [];
    this.history = [];
    this.current = null;
    this.currentCancel = null;
    this.captionTimer = null;
    this.lastSpokenAt = -Infinity;
    this.lastByKind = new Map();
    this.now = 0;
    this.phase = 'menu';
    this.voice = null;
    this.voiceName = null;
    this._token = 0;
    this._resetDetection();
  }

  _resetDetection(snapshot = null) {
    const first = snapshot?.order?.[0]?.name || null;
    const rank = snapshot?.player?.rank || null;
    this.leader = { committed: null, candidate: first, since: this.now };
    this.playerRank = { committed: rank, candidate: rank, since: this.now };
    this.prevPackets = snapshot?.player?.packets || 0;
    this.prevDrafting = Boolean(snapshot?.player?.drafting);
    this.draftSince = this.prevDrafting ? this.now : null;
    this.prevShield = snapshot?.player?.shield ?? 100;
    this.lowShieldCalled = this.prevShield < 25;
    this.shieldGoneCalled = this.prevShield <= 0;
    this.prevHitWall = Boolean(snapshot?.player?.hitWall);
    this.prevImpactSerial = snapshot?.player?.impactSerial || 0;
    this.prevFinished = Boolean(snapshot?.player?.finished);
    this.lastSectorIndex = this._sectorIndex(snapshot?.progress ?? 0);
    this.sectorsCalled = new Set([0]);
  }

  reset(snapshot = null) {
    this.run++;
    this._cancelCurrent();
    this.queue.length = 0;
    this.lastByKind.clear();
    this.lastSpokenAt = -Infinity;
    this.now = Number.isFinite(snapshot?.time) ? snapshot.time : 0;
    this.phase = snapshot?.phase || 'countdown';
    this._resetDetection(snapshot);
    this._hideCaption(true);
    this.emit(makeEvent(
      'briefing',
      this.now,
      'Orbital race control online. Twelve labs cleared for launch.',
      {
        id: `briefing.${this.run}`,
        clipId: 'briefing',
        dedupeKey: 'briefing',
      },
    ));
    this._drain();
  }

  setMuted(muted) {
    const next = Boolean(muted);
    if (next === this.muted) return;
    this.muted = next;
    if (next && this.current) {
      const item = this.current;
      this._cancelCurrent(false);
      this._showCaption(item);
      this._scheduleCaptionHide(estimateSpeechMs(item.text));
    }
  }

  update(snapshot) {
    if (!snapshot || !Number.isFinite(snapshot.time)) return;
    this.now = Math.max(this.now, snapshot.time);
    const previousPhase = this.phase;
    this.phase = snapshot.phase || this.phase;

    if (this.phase === 'paused') {
      if (previousPhase !== 'paused') this._cancelCurrent();
      return;
    }

    if (this.phase === 'race' && previousPhase === 'countdown') {
      this.playerRank = {
        committed: snapshot.player?.rank || null,
        candidate: snapshot.player?.rank || null,
        since: this.now,
      };
      this.emit(makeEvent(
        'green',
        this.now,
        'Launch confirmed. The race to HELIOS is on.',
        {
          id: `green.${this.run}`,
          clipId: 'green',
          dedupeKey: 'green',
        },
      ));
    }

    if (this.phase === 'race') {
      const leaderChanged = this._detectLeader(snapshot);
      this._detectRank(snapshot, leaderChanged);
      this._detectDraft(snapshot);
      this._detectCores(snapshot);
      this._detectImpactAndShield(snapshot);
      this._detectSector(snapshot);
    }
    // Results can be entered on the same simulation frame as the final
    // crossing. Keep finish detection alive for that boundary frame.
    if (this.phase === 'race' || this.phase === 'results') this._detectFinish(snapshot);

    this._purgeStale();
    this._drain();
  }

  emit(event) {
    if (!event || !event.text) return false;
    const normalized = {
      ...event,
      priority: event.priority ?? 50,
      createdAt: Number.isFinite(event.createdAt) ? event.createdAt : this.now,
      expiresAt: Number.isFinite(event.expiresAt) ? event.expiresAt : this.now + 8,
      dedupeKey: event.dedupeKey || event.kind || event.id,
      id: event.id || `${event.kind || 'call'}.${Math.round(this.now * 1000)}`,
    };

    const existing = this.queue.findIndex(item => item.dedupeKey === normalized.dedupeKey);
    if (existing >= 0) {
      if (this.queue[existing].createdAt <= normalized.createdAt) this.queue[existing] = normalized;
    } else {
      this.queue.push(normalized);
    }
    if (this.queue.length > 18) {
      this.queue.sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt);
      this.queue.length = 18;
    }

    if (normalized.interrupt && this.current && normalized.priority > this.current.priority) {
      this._cancelCurrent();
    }
    this._drain();
    return true;
  }

  _detectLeader(snapshot) {
    const observed = snapshot.order?.[0]?.name;
    if (!observed) return false;
    if (observed !== this.leader.candidate) {
      this.leader.candidate = observed;
      this.leader.since = this.now;
      return false;
    }
    if (observed === this.leader.committed || this.now - this.leader.since < this.leaderStableFor) return false;

    const previous = this.leader.committed;
    this.leader.committed = observed;
    const early = previous === null;
    const text = early
      ? `${spokenLab(observed)} establishes the early lead.`
      : observed === 'OPENAI'
        ? 'OpenAI takes command of the orbital sprint.'
        : `${spokenLab(observed)} takes the lead${previous === 'OPENAI' ? ' from OpenAI' : ''}.`;
    this.emit(makeEvent('leader', this.now, text, {
      id: `leader.${observed}.${Math.round(this.now * 10)}`,
      clipId: `leader.${observed}`,
      dedupeKey: 'leader',
      meta: { leader: observed, previous },
    }));
    return true;
  }

  _detectRank(snapshot, leaderChanged) {
    const observed = snapshot.player?.rank;
    if (!Number.isInteger(observed) || observed < 1) return;
    if (this.playerRank.committed === null) {
      this.playerRank = { committed: observed, candidate: observed, since: this.now };
      return;
    }
    if (observed !== this.playerRank.candidate) {
      this.playerRank.candidate = observed;
      this.playerRank.since = this.now;
      return;
    }
    if (observed === this.playerRank.committed || this.now - this.playerRank.since < this.rankStableFor) return;

    const previous = this.playerRank.committed;
    this.playerRank.committed = observed;
    const improved = observed < previous;
    const rival = improved
      ? snapshot.order?.[observed]?.name
      : snapshot.order?.[observed - 2]?.name;

    // A lead-change call already tells this story more cleanly.
    if (leaderChanged && (observed === 1 || previous === 1)) return;

    const moved = Math.abs(previous - observed);
    const text = improved
      ? moved > 1
        ? `OpenAI surges from ${pWord(previous)} to ${pWord(observed)}.`
        : `OpenAI clears ${spokenLab(rival)} for ${pWord(observed)}.`
      : moved > 1
        ? `Trouble for OpenAI. Down to ${pWord(observed)}.`
        : `${spokenLab(rival)} gets by OpenAI. OpenAI drops to ${pWord(observed)}.`;
    const kind = improved ? 'rankUp' : 'rankDown';
    this.emit(makeEvent(kind, this.now, text, {
      id: `rank.${previous}.${observed}.${Math.round(this.now * 10)}`,
      clipId: `rank.${improved ? 'up' : 'down'}.${observed}.${rival || 'field'}`,
      dedupeKey: 'player-rank',
      meta: { previous, rank: observed, rival },
    }));
  }

  _detectDraft(snapshot) {
    const drafting = Boolean(snapshot.player?.drafting);
    if (drafting && !this.prevDrafting) this.draftSince = this.now;
    if (!drafting) this.draftSince = null;
    if (drafting && this.draftSince !== null && this.now - this.draftSince >= this.draftStableFor) {
      this.emit(makeEvent(
        'draft',
        this.now,
        pick([
          'Draft link established. Burst charge is climbing.',
          'OpenAI locks onto the slipstream. Free energy on the link.',
          'Wake telemetry acquired. OpenAI is charging in the draft.',
        ], `draft.${this.run}.${Math.floor(this.now / 8)}`),
        {
          id: `draft.${this.run}.${Math.round(this.draftSince * 10)}`,
          clipId: 'draft',
          dedupeKey: 'draft',
        },
      ));
      this.draftSince = null;
    }
    this.prevDrafting = drafting;
  }

  _detectCores(snapshot) {
    const packets = snapshot.player?.packets || 0;
    if (packets > this.prevPackets) {
      const total = snapshot.player?.packetTotal || 8;
      const text = packets >= total
        ? 'Every data core secured. OpenAI has a full inference payload.'
        : `Data core secured. ${packets} of ${total}. Burst and shields replenished.`;
      this.emit(makeEvent('core', this.now, text, {
        id: `core.${packets}`,
        clipId: `core.${packets}`,
        dedupeKey: 'core',
        meta: { packets, total },
      }));
    }
    this.prevPackets = packets;
  }

  _detectImpactAndShield(snapshot) {
    const player = snapshot.player || {};
    const shield = clamp(player.shield ?? 100, 0, 100);
    const impactSerial = player.impactSerial || 0;
    const wallHit = Boolean(player.hitWall) && !this.prevHitWall;
    const collision = impactSerial !== this.prevImpactSerial;
    const shieldDrop = this.prevShield - shield;

    if ((collision || wallHit) && shieldDrop > 0.6 && shield > 0) {
      this.emit(makeEvent(
        'impact',
        this.now,
        shield < 38
          ? `Heavy contact. OpenAI shield down to ${Math.round(shield)} percent.`
          : pick([
            `Contact. OpenAI shield holding at ${Math.round(shield)} percent.`,
            'OpenAI trades paint in vacuum. Shield is still online.',
          ], `impact.${impactSerial}.${Math.round(this.now)}`),
        {
          id: `impact.${impactSerial}.${Math.round(this.now * 10)}`,
          clipId: 'impact',
          dedupeKey: 'impact',
        },
      ));
    }

    if (shield <= 0 && !this.shieldGoneCalled) {
      this.shieldGoneCalled = true;
      this.lowShieldCalled = true;
      this.emit(makeEvent(
        'shieldGone',
        this.now,
        'Shield failure. OpenAI is in limp mode. Clean line, now.',
        {
          id: `shield-gone.${this.run}`,
          clipId: 'shield.gone',
          dedupeKey: 'shield-status',
          interrupt: true,
        },
      ));
    } else if (shield < 25 && !this.lowShieldCalled) {
      this.lowShieldCalled = true;
      this.emit(makeEvent(
        'shieldLow',
        this.now,
        `Thermal shield critical. ${Math.round(shield)} percent. Keep it off the barriers.`,
        {
          id: `shield-low.${this.run}`,
          clipId: 'shield.low',
          dedupeKey: 'shield-status',
        },
      ));
    } else if (shield > 38) {
      this.lowShieldCalled = false;
      this.shieldGoneCalled = false;
    }

    this.prevShield = shield;
    this.prevHitWall = Boolean(player.hitWall);
    this.prevImpactSerial = impactSerial;
  }

  _sectorIndex(progress) {
    let index = 0;
    for (let i = 0; i < this.sectors.length; i++) {
      if ((progress || 0) >= this.sectors[i].f) index = i;
    }
    return index;
  }

  _detectSector(snapshot) {
    const index = this._sectorIndex(snapshot.progress || 0);
    if (index <= this.lastSectorIndex) return;
    for (let i = this.lastSectorIndex + 1; i <= index; i++) {
      if (this.sectorsCalled.has(i)) continue;
      this.sectorsCalled.add(i);
      const sector = this.sectors[i];
      const isFinal = i === this.sectors.length - 1;
      const authored = {
        '02': 'Sector two. Karman Climb. The field goes to full thrust.',
        '03': 'Sector three. Lunar Slingshot. Momentum is everything here.',
        '04': 'Sector four. Dark-Side Switchback. No sunlight, no margin.',
        '05': 'Sector five. Quantum Data Stream. The racing line is wide open.',
        '06': 'Final approach. HELIOS is awake. Every position is live.',
      };
      const kind = isFinal ? 'final' : 'sector';
      this.emit(makeEvent(kind, this.now, authored[sector.code] ||
        `Sector ${spokenLab(sector.code)}. ${spokenLab(sector.name)}.`, {
        id: `sector.${sector.code}`,
        clipId: `sector.${sector.code}`,
        dedupeKey: isFinal ? 'final' : `sector.${sector.code}`,
        interrupt: isFinal,
        meta: { index: i, code: sector.code, name: sector.name },
      }));
    }
    this.lastSectorIndex = index;
  }

  _detectFinish(snapshot) {
    const finished = Boolean(snapshot.player?.finished);
    if (!finished || this.prevFinished) {
      this.prevFinished = finished;
      return;
    }
    this.prevFinished = true;
    const rank = snapshot.player?.rank || 12;
    const won = rank === 1;
    this.queue.length = 0;
    this.emit(makeEvent(
      'finish',
      this.now,
      won
        ? 'Compute claimed! OpenAI wins the race to HELIOS!'
        : `HELIOS reached. OpenAI finishes ${pWord(rank)}. The array belongs to ${spokenLab(snapshot.order?.[0]?.name)}.`,
      {
        id: `finish.${won ? 'win' : rank}`,
        clipId: won ? 'finish.win' : `finish.loss.${rank}`,
        dedupeKey: 'finish',
        interrupt: true,
        staleAfter: 60,
        meta: { rank, won },
      },
    ));
  }

  _purgeStale() {
    this.queue = this.queue.filter(item =>
      item.kind === 'finish' || item.expiresAt >= this.now);
  }

  _eligible(item) {
    const last = this.lastByKind.get(item.kind) ?? -Infinity;
    return this.now - last >= (COOLDOWN[item.kind] ?? 0);
  }

  _drain() {
    if (this.current || (this.phase !== 'race' && this.phase !== 'countdown' && this.phase !== 'results')) return;
    this._purgeStale();
    if (!this.queue.length) return;

    const insideMinimumGap = this.now - this.lastSpokenAt < this.minGap;
    let selected = -1;
    for (let i = 0; i < this.queue.length; i++) {
      if (!this._eligible(this.queue[i])) continue;
      // Priority interrupts such as a shield failure or the finish call must
      // transmit immediately, even if ordinary commentary just ended.
      if (insideMinimumGap && !this.queue[i].interrupt) continue;
      if (selected < 0 ||
          this.queue[i].priority > this.queue[selected].priority ||
          (this.queue[i].priority === this.queue[selected].priority &&
           this.queue[i].createdAt < this.queue[selected].createdAt)) {
        selected = i;
      }
    }
    if (selected < 0) return;
    const [item] = this.queue.splice(selected, 1);
    this._play(item);
  }

  _play(item) {
    this.current = item;
    this.lastSpokenAt = this.now;
    this.lastByKind.set(item.kind, this.now);
    this.history.push({
      id: item.id,
      kind: item.kind,
      text: item.text,
      clipId: item.clipId,
      priority: item.priority,
      at: this.now,
      run: this.run,
    });
    if (this.history.length > this.maxHistory) this.history.shift();
    this._showCaption(item);

    const token = ++this._token;
    const finish = () => {
      if (token !== this._token) return;
      this.current = null;
      this.currentCancel = null;
      this.onDuck(false);
      this._radioCue(false);
      this._scheduleCaptionHide(1250);
      this._drain();
    };

    if (this.muted) {
      this.currentCancel = () => {};
      const timer = this.setTimer(finish, estimateSpeechMs(item.text));
      this.currentCancel = () => this.clearTimer(timer);
      return;
    }

    this.onDuck(true);
    this._radioCue(true);
    if (this.transport) {
      this.currentCancel = this.transport(item, finish) || (() => {});
      return;
    }

    const clip = this._resolveClip(item);
    const clipText = clip && typeof clip === 'object' ? clip.text : null;
    if (clip && (!clipText || clipText === item.text) && this.AudioCtor) {
      this.currentCancel = this._playClip(clip, finish);
      return;
    }
    this.currentCancel = this._speak(item.text, finish);
  }

  _resolveClip(item) {
    const exact = this.clipManifest[item.clipId];
    if (exact) return exact;
    const clipId = String(item.clipId || '');
    const fallbacks = [];
    if (clipId.startsWith('rank.up.')) fallbacks.push('rank.up');
    if (clipId.startsWith('rank.down.')) fallbacks.push('rank.down');
    if (clipId.startsWith('core.')) fallbacks.push('core');
    if (clipId.startsWith('finish.loss.')) fallbacks.push('finish.loss');
    if (clipId.startsWith('leader.')) fallbacks.push('leader');
    fallbacks.push(item.kind);
    for (const id of fallbacks) {
      if (this.clipManifest[id]) return this.clipManifest[id];
    }
    return null;
  }

  _playClip(entry, finish) {
    const descriptor = typeof entry === 'string' ? { src: entry } : entry;
    const audio = new this.AudioCtor(descriptor.src);
    audio.preload = 'auto';
    audio.volume = clamp(descriptor.volume ?? 0.92, 0, 1);
    audio.playbackRate = descriptor.rate || 1;
    let fallback = null;
    let settled = false;
    const audioNodes = [];
    const disconnectNodes = () => {
      for (const node of audioNodes) {
        try { node.disconnect(); } catch { /* already disconnected */ }
      }
      audioNodes.length = 0;
    };

    // Baked clips get an actual narrow-band race-radio chain. Browser TTS
    // cannot be routed through WebAudio, so it uses the procedural squelch cue.
    const context = this.getAudioContext();
    if (context?.createMediaElementSource) {
      try {
        const source = context.createMediaElementSource(audio);
        const highpass = context.createBiquadFilter();
        const lowpass = context.createBiquadFilter();
        const compressor = context.createDynamicsCompressor();
        const gain = context.createGain();
        highpass.type = 'highpass';
        highpass.frequency.value = 260;
        highpass.Q.value = 0.75;
        lowpass.type = 'lowpass';
        lowpass.frequency.value = 4700;
        lowpass.Q.value = 0.7;
        compressor.threshold.value = -24;
        compressor.knee.value = 10;
        compressor.ratio.value = 5;
        compressor.attack.value = 0.006;
        compressor.release.value = 0.12;
        gain.gain.value = 0.9;
        source.connect(highpass);
        highpass.connect(lowpass);
        lowpass.connect(compressor);
        compressor.connect(gain);
        gain.connect(context.destination);
        audioNodes.push(source, highpass, lowpass, compressor, gain);
        audio.volume = 1;
      } catch {
        disconnectNodes();
      }
    }

    const done = () => {
      if (settled) return;
      settled = true;
      audio.onended = null;
      audio.onerror = null;
      if (fallback) this.clearTimer(fallback);
      disconnectNodes();
      finish();
    };
    const fallbackToSpeech = () => {
      if (settled) return;
      settled = true;
      audio.onended = null;
      audio.onerror = null;
      if (fallback) this.clearTimer(fallback);
      audio.pause?.();
      disconnectNodes();
      this.currentCancel = this._speak(this.current?.text || '', finish);
    };
    audio.onended = done;
    audio.onerror = fallbackToSpeech;
    const play = audio.play?.();
    if (play?.catch) play.catch(fallbackToSpeech);
    // `onended` is the normal completion path. This timer is only a watchdog
    // for a browser that never emits media completion, so keep it comfortably
    // beyond every authored line rather than clipping slower baked delivery.
    const watchdogMs = Math.max(
      15_000,
      (descriptor.durationMs || 0) + 3_000,
      estimateSpeechMs(this.current?.text) * 3,
    );
    fallback = this.setTimer(done, watchdogMs);
    return () => {
      settled = true;
      if (fallback) this.clearTimer(fallback);
      audio.pause?.();
      audio.currentTime = 0;
      disconnectNodes();
    };
  }

  _selectVoice() {
    if (this.voice || !this.speech?.getVoices) return this.voice;
    const voices = this.speech.getVoices() || [];
    const scored = voices.map(voice => {
      const label = `${voice.name || ''} ${voice.voiceURI || ''}`.toLowerCase();
      let score = /^en([-_]|$)/i.test(voice.lang || '') ? 20 : 0;
      if (voice.localService) score += 3;
      if (/neural|natural|enhanced|premium/.test(label)) score += 9;
      if (/google|microsoft|apple/.test(label)) score += 4;
      if (/novelty|whisper|organ|bells|zarvox/.test(label)) score -= 20;
      return { voice, score };
    }).sort((a, b) => b.score - a.score ||
      String(a.voice.name).localeCompare(String(b.voice.name)));
    this.voice = scored[0]?.voice || null;
    this.voiceName = this.voice?.name || 'browser default';
    return this.voice;
  }

  _speak(text, finish) {
    const prepared = speechText(text);
    if (!this.speech || !this.Utterance) {
      const timer = this.setTimer(finish, estimateSpeechMs(prepared));
      return () => this.clearTimer(timer);
    }
    const utterance = new this.Utterance(prepared);
    const voice = this._selectVoice();
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || 'en-US';
    utterance.rate = 1.08;
    utterance.pitch = 0.84;
    utterance.volume = 0.96;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      finish();
    };
    utterance.onend = done;
    utterance.onerror = done;
    this.speech.speak(utterance);
    const fallback = this.setTimer(done, estimateSpeechMs(prepared) + 2400);
    return () => {
      settled = true;
      this.clearTimer(fallback);
      this.speech.cancel?.();
    };
  }

  _radioCue(opening) {
    if (this.muted) return;
    const context = this.getAudioContext();
    if (!context || context.state === 'closed') return;
    try {
      const t = context.currentTime;
      const osc = context.createOscillator();
      const gain = context.createGain();
      const filter = context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = opening ? 1220 : 840;
      filter.Q.value = 3.5;
      osc.type = 'square';
      osc.frequency.setValueAtTime(opening ? 940 : 720, t);
      osc.frequency.exponentialRampToValueAtTime(opening ? 1420 : 520, t + 0.075);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.035, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.095);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);
      osc.start(t);
      osc.stop(t + 0.1);

      const length = Math.max(1, Math.floor(context.sampleRate * 0.07));
      const buffer = context.createBuffer(1, length, context.sampleRate);
      const data = buffer.getChannelData(0);
      let seed = opening ? 0xA17ACE : 0xC105E;
      for (let i = 0; i < length; i++) {
        seed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        data[i] = (((seed >>> 0) / 4294967296) * 2 - 1) * (1 - i / length);
      }
      const noise = context.createBufferSource();
      const noiseFilter = context.createBiquadFilter();
      const noiseGain = context.createGain();
      noise.buffer = buffer;
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.value = 1850;
      noiseFilter.Q.value = 0.8;
      noiseGain.gain.setValueAtTime(0.025, t);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(context.destination);
      noise.start(t);
    } catch {
      // Audio cues are enhancement only; narration must survive unavailable WebAudio.
    }
  }

  _showCaption(item) {
    if (!this.captionEl) return;
    if (this.captionCopy) this.captionCopy.textContent = item.text;
    if (this.captionSignal) this.captionSignal.textContent =
      item.kind === 'finish' ? 'HELIOS PRIORITY' : 'ORBITAL RACE CONTROL';
    this.captionEl.classList?.add('live');
    this.captionEl.dataset.kind = item.kind;
    if (this.captionTimer) this.clearTimer(this.captionTimer);
    this.captionTimer = null;
  }

  _scheduleCaptionHide(delay) {
    if (!this.captionEl) return;
    if (this.captionTimer) this.clearTimer(this.captionTimer);
    this.captionTimer = this.setTimer(() => this._hideCaption(), delay);
  }

  _hideCaption(immediate = false) {
    if (!this.captionEl) return;
    if (this.captionTimer) this.clearTimer(this.captionTimer);
    this.captionTimer = null;
    this.captionEl.classList?.remove('live');
    if (immediate && this.captionCopy) this.captionCopy.textContent = '';
  }

  _cancelCurrent(hideCaption = true) {
    this._token++;
    try {
      this.currentCancel?.();
    } catch {
      // A transport cancellation failure must never break the race loop.
    }
    this.currentCancel = null;
    this.current = null;
    this.onDuck(false);
    if (hideCaption) this._hideCaption();
  }

  inspect() {
    return {
      run: this.run,
      now: this.now,
      phase: this.phase,
      muted: this.muted,
      voice: this.voiceName,
      current: this.current ? {
        id: this.current.id,
        kind: this.current.kind,
        text: this.current.text,
        priority: this.current.priority,
      } : null,
      queued: this.queue.map(item => ({
        id: item.id,
        kind: item.kind,
        text: item.text,
        priority: item.priority,
        expiresAt: item.expiresAt,
      })),
      history: this.history.map(item => ({ ...item })),
      leader: { ...this.leader },
      playerRank: { ...this.playerRank },
    };
  }

  dispose() {
    this._cancelCurrent();
    this.queue.length = 0;
    if (this.captionTimer) this.clearTimer(this.captionTimer);
  }
}

export function createRaceControl(options) {
  return new RaceControlDirector(options);
}
