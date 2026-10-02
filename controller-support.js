(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) {
    root.MonopolyControllerSupport = api;
    api.init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const STANDARD = {
    A: 0, B: 1, X: 2, Y: 3,
    LB: 4, RB: 5, LT: 6, RT: 7,
    VIEW: 8, MENU: 9, LS: 10, RS: 11,
    UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
  };
  const DEADZONE = 0.58;
  const FIRST_REPEAT_MS = 270;
  const REPEAT_MS = 105;

  function controllerFamily(id = '') {
    const name = String(id).toLowerCase();
    if (/dualsense|dualshock|playstation|sony/.test(name)) return 'playstation';
    if (/nintendo|switch|joy-con|pro controller/.test(name)) return 'nintendo';
    return 'xbox';
  }

  function buttonLabels(family) {
    if (family === 'playstation') {
      return { A: '✕', B: '○', X: '□', Y: '△', LB: 'L1', RB: 'R1', LT: 'L2', RT: 'R2', VIEW: 'Create', MENU: 'Options' };
    }
    if (family === 'nintendo') {
      return { A: 'B', B: 'A', X: 'Y', Y: 'X', LB: 'L', RB: 'R', LT: 'ZL', RT: 'ZR', VIEW: '−', MENU: '+' };
    }
    return { A: 'A', B: 'B', X: 'X', Y: 'Y', LB: 'LB', RB: 'RB', LT: 'LT', RT: 'RT', VIEW: 'View', MENU: 'Menu' };
  }

  function rectCenter(rect) {
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function chooseSpatialTarget(items, currentIndex, dx, dy) {
    if (!Array.isArray(items) || !items.length) return -1;
    const current = items[currentIndex];
    if (!current) return 0;
    const origin = rectCenter(current.rect || current);
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    let bestIndex = -1;
    let bestScore = Infinity;

    for (let i = 0; i < items.length; i++) {
      if (i === currentIndex) continue;
      const target = rectCenter(items[i].rect || items[i]);
      const vx = target.x - origin.x;
      const vy = target.y - origin.y;
      const main = horizontal ? vx * Math.sign(dx || 1) : vy * Math.sign(dy || 1);
      if (main <= 3) continue;
      const cross = horizontal ? Math.abs(vy) : Math.abs(vx);
      const euclid = Math.hypot(vx, vy);
      const score = main + cross * 2.35 + euclid * 0.08;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0) return bestIndex;

    // Wrap to the opposite edge while preferring the same row/column.
    let wrapScore = Infinity;
    for (let i = 0; i < items.length; i++) {
      if (i === currentIndex) continue;
      const target = rectCenter(items[i].rect || items[i]);
      const vx = target.x - origin.x;
      const vy = target.y - origin.y;
      const main = horizontal ? Math.abs(vx) : Math.abs(vy);
      const cross = horizontal ? Math.abs(vy) : Math.abs(vx);
      const edgeBias = horizontal
        ? (dx > 0 ? target.x : -target.x)
        : (dy > 0 ? target.y : -target.y);
      const score = cross * 3 + main * 0.08 + edgeBias * 0.001;
      if (score < wrapScore) {
        wrapScore = score;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  function modeForContext(context) {
    return ['menu', 'profile', 'friends', 'lobby', 'boards', 'settings', 'save', 'reconnect'].includes(context) ? 'mouse' : 'focus';
  }

  let preferences = { sensitivity: 1.2, deadzone: .18 };
  let runtime = null;
  try {
    const stored = JSON.parse(root.localStorage?.getItem('monopolyController') || '{}');
    preferences = normalizePreferences(stored);
  } catch (error) {}

  function normalizePreferences(value = {}) {
    return {
      sensitivity: Math.max(.4, Math.min(2.5, Number(value.sensitivity) || 1.2)),
      deadzone: Math.max(.1, Math.min(.4, Number(value.deadzone) || .18)),
    };
  }

  function configure(changes) {
    preferences = normalizePreferences({ ...preferences, ...changes });
    try { root.localStorage?.setItem('monopolyController', JSON.stringify(preferences)); } catch (error) {}
    runtime?.preferencesChanged();
  }

  function advanceCursor(cursor, x, y, elapsed, width, height, prefs = preferences) {
    const dt = Math.max(0, Math.min(.05, elapsed));
    const length = Math.hypot(x, y);
    const strength = Math.min(1, Math.max(0, (length - prefs.deadzone) / (1 - prefs.deadzone)));
    const speed = Math.pow(strength, 1.65) * 1000 * prefs.sensitivity;
    const smoothing = 1 - Math.exp(-18 * dt);
    const vx = (cursor.vx || 0) + ((length ? x / length * speed : 0) - (cursor.vx || 0)) * smoothing;
    const vy = (cursor.vy || 0) + ((length ? y / length * speed : 0) - (cursor.vy || 0)) * smoothing;
    return { x: Math.max(2, Math.min(width - 2, cursor.x + vx * dt)),
      y: Math.max(2, Math.min(height - 2, cursor.y + vy * dt)), vx, vy };
  }

  function init() {
    if (runtime) return runtime;
    if (!root || !root.document || !root.navigator || typeof root.navigator.getGamepads !== 'function') return;

    const doc = root.document;
    let connectedIndex = null;
    let connectedId = '';
    let family = 'xbox';
    let labels = buttonLabels(family);
    let buttonWasDown = [];
    let repeatState = Object.create(null);
    let pollFrame = null;
    let disconnectedTimer = null;
    let lastControllerInputAt = 0;
    let keyboardState = null;
    let quickMenuOpen = false;
    let cursor = { x: root.innerWidth / 2, y: root.innerHeight / 2, vx: 0, vy: 0 };
    let lastFrameAt = null;
    let hoveredElement = null;
    let interaction = { kind: 'menu', mode: 'mouse', scope: doc };
    let hudSignature = '';
    let lastFocusKey = null;

    function addStyles() {
      if (doc.getElementById('controllerSupportStyles')) return;
      const style = doc.createElement('style');
      style.id = 'controllerSupportStyles';
      style.textContent = `
        body.controller-input :focus {
          outline: 4px solid #ffd84d !important;
          outline-offset: 4px !important;
          box-shadow: 0 0 0 2px rgba(0,0,0,.72), 0 0 22px rgba(255,216,77,.4) !important;
        }
        body.controller-input .cell:focus {
          z-index: 16 !important;
          filter: brightness(1.12);
        }
        .controller-hud {
          position: fixed;
          left: 50%;
          bottom: 10px;
          transform: translateX(-50%);
          z-index: 525;
          width: max-content;
          max-width: calc(100vw - 20px);
          display: none;
          align-items: center;
          justify-content: center;
          gap: 8px 12px;
          flex-wrap: wrap;
          padding: 8px 12px;
          border: 2px solid rgba(255,255,255,.72);
          border-radius: 14px;
          background: rgba(12,19,15,.94);
          color: #fff;
          box-shadow: 0 7px 24px rgba(0,0,0,.35);
          font-size: .78rem;
          font-weight: 850;
          pointer-events: none;
        }
        body.controller-input .controller-hud.connected { display: flex; }
        body[data-controller-screen="keyboard"] .controller-hud { z-index:550; }
        .controller-cursor { position:fixed;z-index:1100;pointer-events:none;width:20px;height:20px;border:3px solid #101a14;border-radius:50%;background:#ffd84d;box-shadow:0 0 0 2px #fff;transform:translate(-50%,-50%);display:none; }
        body.controller-input .controller-cursor.enabled { display:block; }
        .controller-hover { outline:3px solid #ffd84d !important;outline-offset:3px !important; }
        .controller-turn-prompt { position:fixed;left:50%;bottom:calc(var(--controller-hud-height, 54px) + 22px);transform:translateX(-50%);z-index:526;max-width:calc(100vw - 28px);padding:14px 28px;border:2px solid #ffd84d;border-radius:18px;background:rgba(9,35,23,.97);color:#fff;box-shadow:0 8px 32px rgba(0,0,0,.4);text-align:center;pointer-events:none;display:none; }
        body.controller-input .controller-turn-prompt:not([hidden]) { display:block; }
        .controller-turn-prompt small { display:block;font-size:.9rem;font-weight:800;margin-bottom:7px;color:#fff1a0; }
        .controller-turn-prompt strong { display:flex;align-items:center;justify-content:center;gap:14px;font-size:clamp(1.6rem,4vw,2.6rem);font-weight:950;white-space:nowrap; }
        .controller-turn-prompt kbd { display:inline-grid;place-items:center;min-width:1.25em;height:1.25em;border-radius:50%;background:#138238;border:2px solid #afffc4;color:#fff;font:inherit; }
        @media (max-width:600px) { .controller-turn-prompt { padding:12px 20px; } .controller-hud .pad-name { display:none; } }
        .controller-hud .pad-name {
          opacity: .78;
          margin-right: 3px;
          max-width: 190px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .controller-hud kbd, .controller-keyboard kbd {
          min-width: 25px;
          height: 25px;
          padding: 0 6px;
          display: inline-grid;
          place-items: center;
          border: 1px solid rgba(255,255,255,.75);
          border-bottom-width: 3px;
          border-radius: 999px;
          background: #1d2b22;
          color: #fff;
          font: inherit;
          font-weight: 950;
        }
        .controller-toast {
          position: fixed;
          right: 14px;
          top: 14px;
          z-index: 520;
          padding: 10px 14px;
          border-radius: 12px;
          border: 2px solid rgba(255,255,255,.72);
          background: #173521;
          color: #fff;
          font-weight: 900;
          box-shadow: 0 8px 24px rgba(0,0,0,.3);
          pointer-events: none;
          animation: controllerToast 2.8s ease forwards;
        }
        @keyframes controllerToast {
          0% { opacity:0; transform:translateY(-8px); }
          10%,80% { opacity:1; transform:translateY(0); }
          100% { opacity:0; transform:translateY(-8px); }
        }
        .controller-overlay {
          position: fixed;
          inset: 0;
          z-index: 540;
          background: rgba(5,9,7,.78);
          display: grid;
          place-items: center;
          padding: 18px;
        }
        .controller-panel {
          width: min(720px, 96vw);
          max-height: min(760px, 92vh);
          overflow: auto;
          border-radius: 18px;
          border: 2px solid rgba(255,255,255,.74);
          background: var(--panel, #f7f1df);
          color: var(--fg, #101a14);
          box-shadow: 0 20px 60px rgba(0,0,0,.48);
          padding: 18px;
        }
        .controller-panel h2 { margin: 0 0 6px; }
        .controller-panel .controller-sub { opacity:.72; margin:0 0 14px; font-weight:700; }
        .controller-grid {
          display:grid;
          grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
          gap:10px;
        }
        .controller-action {
          min-height: 52px;
          border: 2px solid #142017;
          border-radius: 12px;
          background: var(--btn-alt, #fff);
          color: var(--fg, #101a14);
          font: inherit;
          font-weight: 900;
          cursor: pointer;
          padding: 10px;
        }
        .controller-action[disabled] { opacity:.38; cursor:not-allowed; }
        .controller-keyboard-preview {
          min-height: 58px;
          border-radius: 12px;
          background:var(--btn-alt, #fff);
          color:var(--fg, #101a14);
          border:2px solid var(--border, #18251c);
          display:flex;
          align-items:center;
          padding:10px 14px;
          font-size:1.05rem;
          font-weight:800;
          word-break:break-all;
          margin:12px 0;
        }
        .controller-keyboard-keys {
          display:grid;
          grid-template-columns:repeat(10,minmax(42px,1fr));
          gap:7px;
        }
        .controller-key {
          min-height:46px;
          border:2px solid #18251c;
          border-radius:10px;
          background:var(--btn-alt, #fff);
          color:var(--fg, #101a14);
          font:inherit;
          font-weight:900;
          cursor:pointer;
        }
        .controller-key.wide { grid-column:span 2; }
        .controller-key.extra-wide { grid-column:span 3; }
        @media (max-width:700px) {
          .controller-hud { font-size:.7rem; bottom:6px; }
          .controller-keyboard-keys { grid-template-columns:repeat(6,minmax(40px,1fr)); }
        }
      `;
      doc.head.appendChild(style);
    }

    function ensureHud() {
      let hud = doc.getElementById('controllerHud');
      if (hud) return hud;
      hud = doc.createElement('div');
      hud.id = 'controllerHud';
      hud.className = 'controller-hud';
      hud.setAttribute('aria-live', 'polite');
      doc.body.appendChild(hud);
      if (root.ResizeObserver) new root.ResizeObserver(positionTurnPrompt).observe(hud);
      return hud;
    }

    function positionTurnPrompt() {
      const height = Math.ceil(doc.getElementById('controllerHud')?.getBoundingClientRect().height || 0);
      const value = height + 'px';
      if (height && doc.body.style.getPropertyValue('--controller-hud-height') !== value) {
        doc.body.style.setProperty('--controller-hud-height', value);
      }
    }

    function isGameScreen() {
      return !!doc.getElementById('board') && !!doc.getElementById('dock');
    }

    function updateHud() {
      const hud = ensureHud();
      if (connectedIndex == null) {
        hud.classList.remove('connected');
        updateTurnPrompt(false);
        return;
      }
      const hints = interaction.kind === 'keyboard'
        ? `<span>Stick / D-pad: choose key</span><span><kbd>${labels.A}</kbd> Type</span><span><kbd>${labels.X}</kbd> Delete</span><span><kbd>${labels.B}</kbd> Cancel</span><span><kbd>${labels.MENU}</kbd> Done</span>`
        : interaction.kind === 'manage'
          ? `<span>Stick / D-pad: choose</span><span><kbd>${labels.A}</kbd> Select</span><span><kbd>${labels.LB}</kbd><kbd>${labels.RB}</kbd> Property</span><span><kbd>${labels.B}</kbd> Exit</span>`
          : interaction.kind === 'purchase'
            ? `<span>Stick / D-pad: choose</span><span><kbd>${labels.A}</kbd> Confirm</span><span><kbd>${labels.B}</kbd> Auction</span>`
            : interaction.kind === 'auction'
              ? `<span>Stick / D-pad: choose</span><span><kbd>${labels.A}</kbd> Bid / edit</span><span><kbd>${labels.B}</kbd> Fold</span>`
              : interaction.mode === 'mouse'
                ? `<span>Left stick: cursor</span><span><kbd>${labels.A}</kbd> Select</span><span><kbd>${labels.B}</kbd> Back</span><span>Right stick: scroll</span>`
                : `<span>Stick / D-pad: choose</span><span><kbd>${labels.A}</kbd> Select</span><span><kbd>${labels.B}</kbd> Back</span>`;
      const gameHints = interaction.kind === 'gameplay'
        ? `<span><kbd>${labels.X}</kbd> Manage</span><span><kbd>${labels.Y}</kbd> Trade</span><span><kbd>${labels.LB}</kbd> Deeds</span><span><kbd>${labels.MENU}</kbd> Game menu</span>` : '';
      hud.innerHTML = `<span class="pad-name">🎮 ${escapeHtml(shortControllerName(connectedId))}</span>
        ${hints}
        ${gameHints}`;
      hud.classList.add('connected');
      positionTurnPrompt();
    }

    function updateTurnPrompt(canRoll) {
      let prompt = doc.getElementById('controllerTurnPrompt');
      if (!prompt && !canRoll) return;
      if (!prompt) {
        prompt = doc.createElement('div'); prompt.id = 'controllerTurnPrompt';
        prompt.className = 'controller-turn-prompt'; prompt.setAttribute('role', 'status');
        doc.body.appendChild(prompt);
      }
      const player = doc.getElementById('dock')?.dataset.controllerPlayer || '';
      const text = `<small>${player ? escapeHtml(player) + ', your turn' : 'Your turn'}</small><strong><kbd>${labels.A}</kbd> TO ROLL</strong>`;
      if (canRoll && prompt.innerHTML !== text) prompt.innerHTML = text;
      if (prompt.hidden !== !canRoll) prompt.hidden = !canRoll;
    }

    function readInteraction() {
      const keyboard = doc.getElementById('controllerKeyboardOverlay');
      if (keyboard) return { kind: 'keyboard', mode: 'focus', scope: keyboard };
      const scrims = Array.from(doc.querySelectorAll('.scrim')).filter(visible);
      const scrim = scrims[scrims.length - 1];
      if (scrim && scrim.id !== 'gameMenuOverlay') {
        const kind = scrim.dataset.controllerContext || 'dialog';
        return { kind, mode: 'focus', scope: scrim };
      }
      const accountMenu = doc.getElementById('cornerAccountDialog');
      if (accountMenu && visible(accountMenu)) return { kind: 'profile', mode: 'mouse', scope: accountMenu };
      if (scrim) return { kind: 'settings', mode: 'mouse', scope: scrim };
      const manage = doc.getElementById('manage');
      if (manage?.querySelector('.mg-exit')) return { kind: 'manage', mode: 'focus', scope: manage };
      const pause = doc.getElementById('pauseOverlay');
      if (pause && visible(pause)) return { kind: 'paused', mode: 'focus', scope: pause };
      if (isGameScreen()) return { kind: 'gameplay', mode: 'focus', scope: doc };
      const kind = doc.querySelector('.reconnect-screen') ? 'reconnect' : doc.querySelector('.setup') ? 'menu' : 'other';
      return { kind, mode: modeForContext(kind), scope: doc };
    }

    function focusKey(element) {
      return element?.dataset.controllerFocus || element?.id || element?.getAttribute('onclick') || null;
    }

    function syncInteraction() {
      if (keyboardState && !keyboardState.input.isConnected) closeKeyboard(false);
      const next = readInteraction();
      const changed = next.kind !== interaction.kind || next.mode !== interaction.mode;
      interaction = next;
      if (doc.body.dataset.controllerMode !== next.mode) doc.body.dataset.controllerMode = next.mode;
      if (doc.body.dataset.controllerScreen !== next.kind) doc.body.dataset.controllerScreen = next.kind;
      if (changed) {
        cursor.vx = 0; cursor.vy = 0;
        hoveredElement?.classList.remove('controller-hover'); hoveredElement = null;
        repeatState = Object.create(null); lastFocusKey = null;
        drawCursor();
      }
      if (next.mode === 'focus' && doc.body.classList.contains('controller-input')) {
        const active = doc.activeElement;
        if (!active || active === doc.body || !active.isConnected || !next.scope.contains(active) || active.disabled || changed) {
          const elements = focusableElements();
          const previous = !changed && lastFocusKey ? elements.find(el => focusKey(el) === lastFocusKey) : null;
          focusElement(previous || preferredElement(elements));
        }
        lastFocusKey = focusKey(doc.activeElement);
      }
      const roll = doc.querySelector('#dock [data-controller-action="roll"]');
      const canRoll = next.kind === 'gameplay' && !!roll && !roll.disabled && visible(roll) && doc.activeElement === roll;
      updateTurnPrompt(canRoll);
      const signature = [next.kind, next.mode, connectedId, canRoll].join('|');
      if (signature !== hudSignature) { hudSignature = signature; updateHud(); }
    }

    function shortControllerName(id) {
      const clean = String(id || 'Controller')
        .replace(/\([^)]*vendor[^)]*\)/ig, '')
        .replace(/standard gamepad/ig, '')
        .replace(/\s+/g, ' ')
        .trim();
      return clean.slice(0, 45) || 'Controller';
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
    }

    function toast(message) {
      const old = doc.querySelector('.controller-toast');
      if (old) old.remove();
      const el = doc.createElement('div');
      el.className = 'controller-toast';
      el.textContent = message;
      doc.body.appendChild(el);
      root.setTimeout(() => el.remove(), 2900);
    }

    function haptic(strong = 0.14, duration = 35) {
      const pad = getPad();
      const actuator = pad && (pad.vibrationActuator || (pad.hapticActuators && pad.hapticActuators[0]));
      if (!actuator) return;
      try {
        if (typeof actuator.playEffect === 'function') {
          actuator.playEffect('dual-rumble', {
            duration,
            strongMagnitude: strong,
            weakMagnitude: Math.min(1, strong * .65),
          }).catch(() => {});
        } else if (typeof actuator.pulse === 'function') {
          actuator.pulse(strong, duration).catch(() => {});
        }
      } catch (error) {}
    }

    function getPads() {
      try { return Array.from(root.navigator.getGamepads() || []).filter(Boolean); }
      catch (error) { return []; }
    }

    function getPad() {
      if (connectedIndex == null) return null;
      const pads = getPads();
      return pads.find(pad => pad.index === connectedIndex) || null;
    }

    function connect(pad) {
      if (!pad) return;
      const changed = connectedIndex !== pad.index || connectedId !== pad.id;
      connectedIndex = pad.index;
      connectedId = pad.id || 'Controller';
      family = controllerFamily(connectedId);
      labels = buttonLabels(family);
      buttonWasDown = [];
      repeatState = Object.create(null);
      addStyles();
      interaction = readInteraction();
      hudSignature = '';
      updateHud();
      if (changed) {
        toast('🎮 Controller connected');
        setControllerInputMode();
        root.setTimeout(() => ensureFocused(), 40);
        haptic(.18, 60);
      }
    }

    function disconnect() {
      if (connectedIndex == null) return;
      connectedIndex = null;
      connectedId = '';
      buttonWasDown = [];
      repeatState = Object.create(null);
      updateHud();
      closeQuickMenu();
      closeKeyboard(false);
      doc.body.classList.remove('controller-input');
      toast('Controller disconnected');
    }

    function setControllerInputMode() {
      lastControllerInputAt = Date.now();
      doc.body.classList.add('controller-input');
      drawCursor();
    }

    function visible(el) {
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const style = root.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    }

    function activeScope() {
      return readInteraction().scope;
    }

    function focusableElements() {
      const scope = activeScope();
      const selector = [
        'button:not([disabled])',
        'a[href]',
        'input:not([disabled]):not([type="hidden"]):not([type="file"])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        'summary',
        '[tabindex]:not([tabindex="-1"])'
      ].join(',');
      const seen = new Set();
      return Array.from(scope.querySelectorAll(selector)).filter(el => {
        if (seen.has(el) || !visible(el)) return false;
        seen.add(el);
        return true;
      });
    }

    function preferredElement(elements) {
      if (!elements.length) return null;
      const preferredSelectors = [
        '#controllerQuickMenu .controller-action:not([disabled])',
        '#controllerKeyboardOverlay .controller-key:not([disabled])',
        '#manage .mg-panel .mg-btn:not([disabled])',
        '#modal .round.ok:not([disabled])',
        '#modal .primary:not([disabled])',
        '#modal .btn:not([disabled])',
        '#dock .primary:not([disabled])',
        '.setup .btn:not(.alt):not([disabled])',
      ];
      for (const selector of preferredSelectors) {
        const found = Array.from(doc.querySelectorAll(selector)).find(el => elements.includes(el) && visible(el));
        if (found) return found;
      }
      return elements[0];
    }

    function focusElement(el) {
      if (!el || !visible(el)) return;
      setControllerInputMode();
      try { el.focus({ preventScroll: true }); } catch (error) { el.focus(); }
      if (!el.closest('#manage, #board')) {
        try { el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); } catch (error) {}
      }
      haptic(.035, 18);
    }

    function ensureFocused() {
      const elements = focusableElements();
      if (!elements.length) return null;
      const active = doc.activeElement;
      if (active && elements.includes(active) && visible(active)) return active;
      const preferred = preferredElement(elements);
      focusElement(preferred);
      return preferred;
    }

    function moveFocus(dx, dy) {
      const elements = focusableElements();
      if (!elements.length) return;
      const active = ensureFocused();
      let index = elements.indexOf(active);
      if (index < 0) index = 0;
      const items = elements.map(element => ({ element, rect: element.getBoundingClientRect() }));
      const next = chooseSpatialTarget(items, index, dx, dy);
      if (next >= 0 && items[next]) focusElement(items[next].element);
    }

    function changeRange(input, direction) {
      const min = Number(input.min || 0);
      const max = Number(input.max || 100);
      const step = Number(input.step || 1) || 1;
      const next = Math.max(min, Math.min(max, Number(input.value || 0) + direction * step));
      input.value = String(next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      haptic(.045, 18);
    }

    function changeSelect(select, direction) {
      const options = Array.from(select.options).filter(option => !option.disabled);
      const current = options.indexOf(select.selectedOptions[0]);
      const next = options[Math.max(0, Math.min(options.length - 1, current + direction))];
      if (!next) return;
      select.value = next.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      haptic(.045, 18);
    }

    function activateFocused() {
      const el = ensureFocused();
      if (!el) return;
      setControllerInputMode();

      if (el.matches('input[type="range"]')) {
        changeRange(el, 1);
        return;
      }
      if (el.matches('input[type="checkbox"], input[type="radio"]')) {
        el.click();
        haptic(.1, 35);
        return;
      }
      if (el.matches('input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="url"], input[type="number"], textarea')) {
        openKeyboard(el);
        return;
      }
      if (el.matches('select')) {
        changeSelect(el, 1);
        return;
      }

      el.click();
      haptic(.13, 42);
      root.setTimeout(() => ensureFocused(), 45);
    }

    function buttonByText(patterns, scope = doc) {
      const lowered = patterns.map(value => String(value).toLowerCase());
      return Array.from(scope.querySelectorAll('button:not([disabled]), [role="button"]:not([aria-disabled="true"])'))
        .filter(visible)
        .find(button => {
          const text = (button.getAttribute('aria-label') || button.textContent || '').trim().toLowerCase();
          return lowered.some(pattern => text === pattern || text.startsWith(pattern));
        }) || null;
    }

    function triggerByText(patterns) {
      const button = buttonByText(patterns, activeScope());
      if (!button) return false;
      button.click();
      haptic(.14, 42);
      root.setTimeout(() => ensureFocused(), 45);
      return true;
    }

    function contextualBack() {
      setControllerInputMode();
      if (keyboardState) {
        closeKeyboard(false);
        return;
      }
      const context = readInteraction();
      if (context.kind === 'purchase') { triggerByText(['auction']); return; }
      if (context.kind === 'auction') { triggerByText(['fold']); return; }
      if (quickMenuOpen) {
        closeQuickMenu();
        return;
      }
      if (context.scope.id === 'gameMenuOverlay' && typeof root.closeGameMenu === 'function') { root.closeGameMenu(); return; }
      const accountMenu = doc.getElementById('cornerAccountDialog');
      if (context.scope === accountMenu && typeof root.closeCornerMenu === 'function') {
        root.closeCornerMenu();
        return;
      }
      const candidates = [
        'ok', 'close', 'back', 'exit', 'cancel', 'skip intro', 'done',
      ];
      const scope = activeScope();
      const button = buttonByText(candidates, scope);
      if (button) {
        button.click();
        haptic(.11, 36);
        root.setTimeout(() => ensureFocused(), 45);
        return;
      }

      // Property/deed overlays occasionally use an icon/unstyled button whose
      // text is not a reliable label. Their global helpers are safe to call.
      try {
        if (typeof root.closeTradeReview === 'function' && doc.querySelector('.trade-summary')) {
          root.closeTradeReview(); return;
        }
      } catch (error) {}
      haptic(.04, 18);
    }

    function quickAction(kind) {
      setControllerInputMode();
      if (readInteraction().kind !== 'gameplay' || keyboardState || quickMenuOpen) return;
      if (kind === 'manage') triggerByText(['manage properties']);
      else if (kind === 'trade') triggerByText(['trade']);
      else if (kind === 'deeds') triggerByText(['view deeds']);
      else if (kind === 'primary') {
        const primary = doc.querySelector('#dock .primary:not([disabled])');
        if (primary && visible(primary)) { primary.click(); haptic(.16, 45); }
      }
    }

    function closeQuickMenu() {
      const overlay = doc.getElementById('controllerQuickMenu');
      if (overlay) overlay.remove();
      quickMenuOpen = false;
      root.setTimeout(() => ensureFocused(), 20);
    }

    function openQuickMenu() {
      if (keyboardState) return;
      if (isGameScreen() && typeof root.openGameMenu === 'function') root.openGameMenu();
      else if (typeof root.openGameSettings === 'function') {
        if (doc.getElementById('gameMenuOverlay')) root.closeGameMenu();
        else root.openGameSettings();
      }
    }

    function cursorElement() {
      let element = doc.getElementById('controllerCursor');
      if (!element) {
        element = doc.createElement('div'); element.id = 'controllerCursor'; element.className = 'controller-cursor';
        element.setAttribute('aria-hidden', 'true'); doc.body.appendChild(element);
      }
      return element;
    }

    function drawCursor() {
      const element = cursorElement();
      cursor.x = Math.max(2, Math.min(root.innerWidth - 2, cursor.x));
      cursor.y = Math.max(2, Math.min(root.innerHeight - 2, cursor.y));
      element.classList.toggle('enabled', interaction.mode === 'mouse' && connectedIndex != null);
      element.style.left = cursor.x + 'px'; element.style.top = cursor.y + 'px';
    }

    function pointerTarget() {
      const target = doc.elementFromPoint(cursor.x, cursor.y);
      const scope = activeScope();
      return target && (scope === doc || scope.contains(target)) ? target : null;
    }

    function moveCursor(x, y, elapsed) {
      cursor = advanceCursor(cursor, x, y, elapsed, root.innerWidth, root.innerHeight);
      drawCursor();
      const target = pointerTarget();
      const selectable = target?.closest('button, input, select, textarea, summary, a[href], [role="button"]');
      if (hoveredElement !== selectable) {
        hoveredElement?.classList.remove('controller-hover');
        hoveredElement = selectable;
        hoveredElement?.classList.add('controller-hover');
      }
      target?.dispatchEvent(new root.PointerEvent('pointermove', { bubbles:true, clientX:cursor.x, clientY:cursor.y, pointerType:'mouse' }));
    }

    function clickCursor() {
      const target = pointerTarget();
      const element = target?.closest('button, input, select, textarea, summary, a[href], [role="button"]') || target;
      if (!element || element.disabled) return;
      if (element.matches('input[type="range"]')) {
        const rect = element.getBoundingClientRect();
        const min = Number(element.min || 0), max = Number(element.max || 100), step = Number(element.step || 1);
        element.value = String(Math.max(min, Math.min(max, min + Math.round((cursor.x - rect.left) / rect.width * (max - min) / step) * step)));
        element.dispatchEvent(new Event('input', { bubbles:true })); element.dispatchEvent(new Event('change', { bubbles:true }));
      } else if (element.matches('select')) { focusElement(element); changeSelect(element, 1); }
      else if (element.matches('textarea, input[type="text"], input[type="search"], input[type="number"], input[type="email"], input[type="password"]')) {
        focusElement(element); openKeyboard(element);
      } else {
        element.dispatchEvent(new root.PointerEvent('pointerdown', { bubbles:true, clientX:cursor.x, clientY:cursor.y, pointerType:'mouse', button:0 }));
        element.dispatchEvent(new root.PointerEvent('pointerup', { bubbles:true, clientX:cursor.x, clientY:cursor.y, pointerType:'mouse', button:0 }));
        element.click();
      }
      haptic(.1, 30);
    }

    function scrollCursor(x, y, elapsed) {
      let target = pointerTarget();
      while (target && target !== doc.body) {
        const style = root.getComputedStyle(target);
        if (/(auto|scroll)/.test(style.overflowY) && target.scrollHeight > target.clientHeight) break;
        target = target.parentElement;
      }
      const scrollable = target && target !== doc.body ? target : doc.scrollingElement;
      scrollable?.scrollBy(x * 900 * elapsed, y * 900 * elapsed);
    }

    function keyboardCharacters(shifted, input = null) {
      if (input && input.type === 'number') return [...'1234567890'.split(''), '.', '-'];
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(ch => shifted ? ch : ch.toLowerCase());
      return [...letters, ...'1234567890'.split(''), '@', '.', '_', '-', "'", '#'];
    }

    function openKeyboard(input) {
      if (!input || keyboardState) return;
      keyboardState = {
        input,
        original: input.value,
        shifted: false,
      };
      renderKeyboard();
      haptic(.09, 30);
    }

    function renderKeyboard() {
      const state = keyboardState;
      if (!state) return;
      let overlay = doc.getElementById('controllerKeyboardOverlay');
      if (overlay) overlay.remove();

      overlay = doc.createElement('div');
      overlay.id = 'controllerKeyboardOverlay';
      overlay.className = 'controller-overlay';

      const panel = doc.createElement('div');
      panel.className = 'controller-panel controller-keyboard';
      const masked = state.input.type === 'password';
      const previewValue = masked ? '•'.repeat(state.input.value.length) : state.input.value;
      panel.innerHTML = `
        <h2>⌨️ Controller keyboard</h2>
        <p class="controller-sub">${labels.A} type · ${labels.B} cancel · ${labels.X} delete · ${labels.Y} space · ${labels.MENU} done</p>
        <div class="controller-keyboard-preview" aria-live="polite">${escapeHtml(previewValue || state.input.placeholder || 'Type here')}</div>
      `;

      const keys = doc.createElement('div');
      keys.className = 'controller-keyboard-keys';
      for (const char of keyboardCharacters(state.shifted, state.input)) {
        const key = doc.createElement('button');
        key.className = 'controller-key';
        key.type = 'button';
        key.textContent = char;
        key.addEventListener('click', () => keyboardAppend(char));
        keys.appendChild(key);
      }

      [
        ['Shift', 'wide', () => { state.shifted = !state.shifted; renderKeyboard(); }],
        ['Space', 'wide', () => keyboardAppend(' ')],
        ['⌫ Backspace', 'wide', keyboardBackspace],
        ['Clear', 'wide', () => keyboardSetValue('')],
        ['Cancel', 'wide', () => closeKeyboard(false)],
        ['Done', 'extra-wide', () => closeKeyboard(true)],
      ].forEach(([label, cls, handler]) => {
        const key = doc.createElement('button');
        key.className = 'controller-key ' + cls;
        key.type = 'button';
        key.textContent = label;
        key.addEventListener('click', handler);
        keys.appendChild(key);
      });

      panel.appendChild(keys);
      overlay.appendChild(panel);
      doc.body.appendChild(overlay);
      root.setTimeout(() => ensureFocused(), 0);
    }

    function keyboardSetValue(value) {
      if (!keyboardState) return;
      const input = keyboardState.input;
      const max = Number(input.maxLength);
      const finalValue = Number.isInteger(max) && max > 0 ? value.slice(0, max) : value;
      input.value = finalValue;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // Keep the currently highlighted virtual key focused while typing.
      // Rebuilding the keyboard after every character made controller text
      // entry jump back to the first key.
      const preview = doc.querySelector('#controllerKeyboardOverlay .controller-keyboard-preview');
      if (preview) {
        const masked = input.type === 'password';
        preview.textContent = (masked ? '•'.repeat(input.value.length) : input.value) || input.placeholder || 'Type here';
      }
    }

    function keyboardAppend(char) {
      if (!keyboardState) return;
      keyboardSetValue(keyboardState.input.value + char);
      haptic(.045, 18);
    }

    function keyboardBackspace() {
      if (!keyboardState) return;
      keyboardSetValue(keyboardState.input.value.slice(0, -1));
      haptic(.055, 22);
    }

    function closeKeyboard(commit) {
      if (!keyboardState) return;
      const state = keyboardState;
      keyboardState = null;
      const overlay = doc.getElementById('controllerKeyboardOverlay');
      if (overlay) overlay.remove();
      if (!commit) {
        state.input.value = state.original;
        state.input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        state.input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      focusElement(state.input);
    }

    function horizontalControl(direction) {
      const active = doc.activeElement;
      if (active && active.matches('input[type="range"]')) {
        changeRange(active, direction);
        return true;
      }
      if (active && active.matches('select')) {
        changeSelect(active, direction);
        return true;
      }
      return false;
    }

    function browseBoard(delta) {
      if (readInteraction().kind !== 'gameplay' || keyboardState || quickMenuOpen) return false;
      let current = doc.activeElement;
      let index = current && current.id && /^cell\d+$/.test(current.id)
        ? Number(current.id.slice(4))
        : null;
      if (!Number.isInteger(index)) {
        const first = doc.getElementById('cell0');
        if (!first || !visible(first)) return false;
        index = 0;
      } else {
        index = (index + delta + 40) % 40;
      }
      const cell = doc.getElementById('cell' + index);
      if (!cell || !visible(cell)) return false;
      focusElement(cell);
      return true;
    }

    function shoulder(direction) {
      const scope = activeScope();
      if (readInteraction().kind === 'manage') {
        const arrow = scope.querySelector(direction > 0 ? '.mg-arrow.left' : '.mg-arrow.right');
        if (arrow && !arrow.disabled) { arrow.click(); haptic(.08, 30); }
        return;
      }
      const candidates = Array.from(scope.querySelectorAll(
        '.mg-arrow:not([disabled]), .player-tab:not([disabled]), .deed-tab:not([disabled]), .seg .btn:not([disabled])'
      )).filter(visible);
      if (candidates.length) {
        const active = doc.activeElement;
        let index = candidates.indexOf(active);
        index = index < 0 ? (direction > 0 ? -1 : 0) : index;
        index = (index + direction + candidates.length) % candidates.length;
        focusElement(candidates[index]);
        candidates[index].click();
        return;
      }
      moveFocus(direction, 0);
    }

    function pressed(pad, index) {
      const button = pad.buttons && pad.buttons[index];
      return !!button && (button.pressed || button.value > .55);
    }

    function edge(pad, index) {
      const now = pressed(pad, index);
      const was = !!buttonWasDown[index];
      buttonWasDown[index] = now;
      return now && !was;
    }

    function repeatGate(key, active, now) {
      const state = repeatState[key] || (repeatState[key] = { down: false, next: 0 });
      if (!active) {
        state.down = false;
        state.next = 0;
        return false;
      }
      if (!state.down) {
        state.down = true;
        state.next = now + FIRST_REPEAT_MS;
        return true;
      }
      if (now >= state.next) {
        state.next = now + REPEAT_MS;
        return true;
      }
      return false;
    }

    function poll(timestamp) {
      const pads = getPads();
      let pad = connectedIndex == null ? null : pads.find(item => item.index === connectedIndex);
      if (!pad && pads.length) {
        connect(pads[0]);
        pad = pads[0];
      }
      if (!pad) {
        if (connectedIndex != null && !disconnectedTimer) {
          disconnectedTimer = root.setTimeout(() => {
            disconnectedTimer = null;
            if (!getPad()) disconnect();
          }, 700);
        }
        pollFrame = root.requestAnimationFrame(poll);
        return;
      }
      if (disconnectedTimer) {
        root.clearTimeout(disconnectedTimer);
        disconnectedTimer = null;
      }

      syncInteraction();

      let used = false;
      const elapsed = lastFrameAt == null ? 1 / 60 : Math.min(.05, (timestamp - lastFrameAt) / 1000);
      lastFrameAt = timestamp;
      const x = pad.axes && Number.isFinite(pad.axes[0]) ? pad.axes[0] : 0;
      const y = pad.axes && Number.isFinite(pad.axes[1]) ? pad.axes[1] : 0;
      const rx = pad.axes && Number.isFinite(pad.axes[2]) ? pad.axes[2] : 0;
      const ry = pad.axes && Number.isFinite(pad.axes[3]) ? pad.axes[3] : 0;
      const up = pressed(pad, STANDARD.UP) || y < -DEADZONE;
      const down = pressed(pad, STANDARD.DOWN) || y > DEADZONE;
      const left = pressed(pad, STANDARD.LEFT) || x < -DEADZONE;
      const right = pressed(pad, STANDARD.RIGHT) || x > DEADZONE;

      if (interaction.mode === 'mouse') {
        const pointerX = pressed(pad, STANDARD.LEFT) ? -1 : pressed(pad, STANDARD.RIGHT) ? 1 : x;
        const pointerY = pressed(pad, STANDARD.UP) ? -1 : pressed(pad, STANDARD.DOWN) ? 1 : y;
        const moving = Math.hypot(pointerX, pointerY) > preferences.deadzone;
        if (moving || Math.hypot(cursor.vx, cursor.vy) > .1) { moveCursor(pointerX, pointerY, elapsed); used = moving; }
        const scrollX = Math.abs(rx) > preferences.deadzone ? rx : 0;
        const scrollY = Math.abs(ry) > preferences.deadzone ? ry : 0;
        const triggerScroll = (pressed(pad, STANDARD.RT) ? 1 : 0) - (pressed(pad, STANDARD.LT) ? 1 : 0);
        if (scrollX || scrollY || triggerScroll) { scrollCursor(scrollX, scrollY || triggerScroll, elapsed); used = true; }
      } else {
      if (repeatGate('up', up, timestamp)) { moveFocus(0, -1); used = true; }
      else if (repeatGate('down', down, timestamp)) { moveFocus(0, 1); used = true; }
      if (repeatGate('left', left, timestamp)) {
        if (!horizontalControl(-1)) moveFocus(-1, 0);
        used = true;
      } else if (repeatGate('right', right, timestamp)) {
        if (!horizontalControl(1)) moveFocus(1, 0);
        used = true;
      }

      // Right stick is dedicated to browsing the physical board ring. It
      // never commits an action: move around the 40 spaces, then press
      // Select to open the focused deed/square. Horizontal moves one square;
      // vertical jumps one side (10 squares).
      if (repeatGate('board-left', rx < -0.72, timestamp)) { used = browseBoard(-1) || used; }
      else if (repeatGate('board-right', rx > 0.72, timestamp)) { used = browseBoard(1) || used; }
      if (repeatGate('board-up', ry < -0.72, timestamp)) { used = browseBoard(10) || used; }
      else if (repeatGate('board-down', ry > 0.72, timestamp)) { used = browseBoard(-10) || used; }

      }

      if (edge(pad, STANDARD.A)) { if (interaction.mode === 'mouse') clickCursor(); else activateFocused(); used = true; }
      if (edge(pad, STANDARD.B)) { contextualBack(); used = true; }
      if (edge(pad, STANDARD.X)) {
        if (keyboardState) keyboardBackspace(); else quickAction('manage');
        used = true;
      }
      if (edge(pad, STANDARD.Y)) {
        if (keyboardState) keyboardAppend(' '); else quickAction('trade');
        used = true;
      }
      if (edge(pad, STANDARD.LB)) { if (interaction.kind === 'manage') shoulder(-1); else if (!keyboardState) quickAction('deeds'); used = true; }
      if (edge(pad, STANDARD.RB)) { if (!keyboardState) shoulder(1); used = true; }
      if (edge(pad, STANDARD.LT)) { if (interaction.mode === 'focus' && !keyboardState) shoulder(-1); used = true; }
      if (edge(pad, STANDARD.RT)) { if (interaction.mode === 'focus' && !keyboardState) quickAction('primary'); used = true; }
      if (edge(pad, STANDARD.MENU)) { if (keyboardState) closeKeyboard(true); else openQuickMenu(); used = true; }
      if (edge(pad, STANDARD.VIEW)) {
        updateHud();
        toast(interaction.mode === 'mouse' ? `Left stick: cursor · ${labels.A} select · ${labels.B} back · Right stick: scroll` : `Stick / D-pad: choose · ${labels.A} confirm · ${labels.B} back`);
        used = true;
      }
      if (edge(pad, STANDARD.LS)) {
        if (interaction.kind === 'gameplay') {
          const boardCell = doc.getElementById('cell0');
          if (boardCell) focusElement(boardCell);
        } else {
          ensureFocused();
        }
        used = true;
      }

      // R3 snaps focus back to the main available action. Useful after
      // browsing board squares or a long menu.
      if (edge(pad, STANDARD.RS)) {
        const elements = focusableElements();
        focusElement(preferredElement(elements));
        used = true;
      }

      if (used) setControllerInputMode();
      pollFrame = root.requestAnimationFrame(poll);
    }

    function onGamepadConnected(event) {
      connect(event.gamepad);
    }

    function onGamepadDisconnected(event) {
      if (event.gamepad && event.gamepad.index === connectedIndex) disconnect();
    }

    function onPointerInput() {
      if (Date.now() - lastControllerInputAt > 180) doc.body.classList.remove('controller-input');
    }

    function onKeyboardInput(event) {
      if (event.key !== 'Tab') doc.body.classList.remove('controller-input');
    }

    addStyles();
    ensureHud();
    root.addEventListener('gamepadconnected', onGamepadConnected);
    root.addEventListener('gamepaddisconnected', onGamepadDisconnected);
    root.addEventListener('resize', positionTurnPrompt);
    doc.addEventListener('pointerdown', onPointerInput, { passive: true });
    doc.addEventListener('keydown', onKeyboardInput, { passive: true });

    const pads = getPads();
    if (pads.length) connect(pads[0]);
    pollFrame = root.requestAnimationFrame(poll);
    runtime = { preferencesChanged() {
      cursor.vx = 0; cursor.vy = 0;
      hoveredElement?.classList.remove('controller-hover'); hoveredElement = null;
      drawCursor(); updateHud();
    } };
    return runtime;
  }

  return {
    controllerFamily,
    buttonLabels,
    chooseSpatialTarget,
    advanceCursor,
    normalizePreferences,
    configure,
    getPreferences: () => ({ ...preferences }),
    modeForContext,
    init,
  };
});
