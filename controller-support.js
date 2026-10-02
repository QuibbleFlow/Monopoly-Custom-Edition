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

  function init() {
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
          z-index: 500;
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
        .controller-hud.connected { display: flex; }
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
          background: #f7f1df;
          color: #101a14;
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
          background: #fff;
          color: #101a14;
          font: inherit;
          font-weight: 900;
          cursor: pointer;
          padding: 10px;
        }
        .controller-action[disabled] { opacity:.38; cursor:not-allowed; }
        .controller-keyboard-preview {
          min-height: 58px;
          border-radius: 12px;
          background:#fff;
          border:2px solid #18251c;
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
          background:#fff;
          color:#101a14;
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
      return hud;
    }

    function isGameScreen() {
      return !!doc.getElementById('board') && !!doc.getElementById('dock');
    }

    function updateHud() {
      const hud = ensureHud();
      if (connectedIndex == null) {
        hud.classList.remove('connected');
        return;
      }
      const gameHints = isGameScreen()
        ? `<span><kbd>${labels.X}</kbd> Manage</span><span><kbd>${labels.Y}</kbd> Trade</span><span><kbd>${labels.LB}</kbd> Deeds</span><span><kbd>${labels.RT}</kbd> Main action</span><span><kbd>${labels.MENU}</kbd> Quick menu</span>`
        : '';
      hud.innerHTML = `<span class="pad-name">🎮 ${escapeHtml(shortControllerName(connectedId))}</span>
        <span><kbd>${labels.A}</kbd> Select</span>
        <span><kbd>${labels.B}</kbd> Back</span>
        <span>✚ Navigate</span>
        ${gameHints}`;
      hud.classList.add('connected');
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
    }

    function visible(el) {
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const style = root.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    }

    function activeScope() {
      const keyboard = doc.getElementById('controllerKeyboardOverlay');
      if (keyboard) return keyboard;
      const quick = doc.getElementById('controllerQuickMenu');
      if (quick) return quick;
      const scrims = Array.from(doc.querySelectorAll('.scrim')).filter(visible);
      if (scrims.length) return scrims[scrims.length - 1];
      return doc;
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
      try { el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); } catch (error) {}
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
          const text = (button.textContent || '').trim().toLowerCase();
          return lowered.some(pattern => text === pattern || text.startsWith(pattern));
        }) || null;
    }

    function triggerByText(patterns) {
      const button = buttonByText(patterns);
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
      if (quickMenuOpen) {
        closeQuickMenu();
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
      if (!isGameScreen() || keyboardState || quickMenuOpen) return;
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

    function openSaveQuitConfirm() {
      const gameId = root.authoritativeGame && root.authoritativeGame.gameId;
      const canDirectSave = gameId && typeof root.backendSaveAndQuitGame === 'function';
      const overlay = doc.getElementById('controllerQuickMenu');
      if (!overlay) return;
      const panel = overlay.querySelector('.controller-panel');
      if (!panel) return;
      panel.innerHTML = '<h2>Save & Quit?</h2><p class="controller-sub">The match will be saved and paused. Every original player must return before it can continue.</p>';
      const grid = doc.createElement('div');
      grid.className = 'controller-grid';
      const cancel = doc.createElement('button');
      cancel.type = 'button';
      cancel.className = 'controller-action';
      cancel.textContent = 'Keep playing';
      cancel.addEventListener('click', closeQuickMenu);
      const confirm = doc.createElement('button');
      confirm.type = 'button';
      confirm.className = 'controller-action';
      confirm.textContent = 'Save & Quit';
      confirm.disabled = !canDirectSave;
      confirm.addEventListener('click', () => {
        closeQuickMenu();
        if (canDirectSave) root.backendSaveAndQuitGame(gameId);
      });
      grid.append(cancel, confirm);
      panel.appendChild(grid);
      root.setTimeout(() => focusElement(cancel), 0);
    }

    function openQuickMenu() {
      if (keyboardState) return;
      if (quickMenuOpen) { closeQuickMenu(); return; }
      quickMenuOpen = true;
      const overlay = doc.createElement('div');
      overlay.id = 'controllerQuickMenu';
      overlay.className = 'controller-overlay';

      const actions = [
        { label: 'Resume', run: closeQuickMenu, enabled: true },
        { label: 'Primary action', run: () => { closeQuickMenu(); quickAction('primary'); }, enabled: !!doc.querySelector('#dock .primary:not([disabled])') },
        { label: 'Manage properties', run: () => { closeQuickMenu(); quickAction('manage'); }, enabled: !!buttonByText(['manage properties']) },
        { label: 'View deeds', run: () => { closeQuickMenu(); quickAction('deeds'); }, enabled: !!buttonByText(['view deeds']) },
        { label: 'Trade', run: () => { closeQuickMenu(); quickAction('trade'); }, enabled: !!buttonByText(['trade']) },
        { label: 'Save & Quit', run: () => openSaveQuitConfirm(), enabled: !!buttonByText(['save & quit']) },
      ];

      const panel = doc.createElement('div');
      panel.className = 'controller-panel';
      panel.innerHTML = `<h2>🎮 Controller menu</h2><p class="controller-sub">${labels.A} select · ${labels.B} close · D-pad / left stick navigate</p>`;
      const grid = doc.createElement('div');
      grid.className = 'controller-grid';
      actions.forEach(action => {
        const button = doc.createElement('button');
        button.className = 'controller-action';
        button.type = 'button';
        button.textContent = action.label;
        button.disabled = !action.enabled;
        button.addEventListener('click', action.run);
        grid.appendChild(button);
      });
      panel.appendChild(grid);
      overlay.appendChild(panel);
      doc.body.appendChild(overlay);
      root.setTimeout(() => ensureFocused(), 0);
      haptic(.11, 35);
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
        <p class="controller-sub">${labels.A} type · ${labels.B} cancel · ${labels.X} backspace · ${labels.Y} space</p>
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
      if (!isGameScreen() || keyboardState || quickMenuOpen) return false;
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

      let used = false;
      const x = pad.axes && Number.isFinite(pad.axes[0]) ? pad.axes[0] : 0;
      const y = pad.axes && Number.isFinite(pad.axes[1]) ? pad.axes[1] : 0;
      const rx = pad.axes && Number.isFinite(pad.axes[2]) ? pad.axes[2] : 0;
      const ry = pad.axes && Number.isFinite(pad.axes[3]) ? pad.axes[3] : 0;
      const up = pressed(pad, STANDARD.UP) || y < -DEADZONE;
      const down = pressed(pad, STANDARD.DOWN) || y > DEADZONE;
      const left = pressed(pad, STANDARD.LEFT) || x < -DEADZONE;
      const right = pressed(pad, STANDARD.RIGHT) || x > DEADZONE;

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

      if (edge(pad, STANDARD.A)) { activateFocused(); used = true; }
      if (edge(pad, STANDARD.B)) { contextualBack(); used = true; }
      if (edge(pad, STANDARD.X)) {
        if (keyboardState) keyboardBackspace(); else quickAction('manage');
        used = true;
      }
      if (edge(pad, STANDARD.Y)) {
        if (keyboardState) keyboardAppend(' '); else quickAction('trade');
        used = true;
      }
      if (edge(pad, STANDARD.LB)) { if (!keyboardState) quickAction('deeds'); used = true; }
      if (edge(pad, STANDARD.RB)) { if (!keyboardState) shoulder(1); used = true; }
      if (edge(pad, STANDARD.LT)) { if (!keyboardState) shoulder(-1); used = true; }
      if (edge(pad, STANDARD.RT)) { if (!keyboardState) quickAction('primary'); used = true; }
      if (edge(pad, STANDARD.MENU)) { openQuickMenu(); used = true; }
      if (edge(pad, STANDARD.VIEW)) {
        updateHud();
        toast(`${labels.A} Select · ${labels.B} Back · D-pad Navigate · Right stick Browse board`);
        used = true;
      }
      if (edge(pad, STANDARD.LS)) {
        if (isGameScreen()) {
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
    doc.addEventListener('pointerdown', onPointerInput, { passive: true });
    doc.addEventListener('keydown', onKeyboardInput, { passive: true });

    const pads = getPads();
    if (pads.length) connect(pads[0]);
    pollFrame = root.requestAnimationFrame(poll);
  }

  return {
    controllerFamily,
    buttonLabels,
    chooseSpatialTarget,
    init,
  };
});
